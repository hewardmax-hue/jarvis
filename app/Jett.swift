// Jett — the Mac app.
//
// One small native app with three jobs:
//
//   · His window. The interface the core serves on this Mac, in a window of
//     its own: the conversation, the map of what he remembers, and a live view
//     of what he and his agents are doing.
//   · His dot in the menu bar, coloured by what he is doing, there whether the
//     window is open or not.
//   · The talk key. Hold ⌥ Option on its own, in any app, and he listens; let
//     go and what you said goes to him.
//
// Listening is Apple's speech recognition — on-device when the language
// supports it — and the microphone is open only while the key is held. Words
// go to the core over a private local socket (a token in ~/.jett/helper.json
// that only this user can read).
//
// The talk key needs no Accessibility permission. macOS lets any app see a
// modifier key change; what it guards is the other keys. So this watches ⌥
// alone and asks the system only "has any key gone down since?" — a counter,
// not the keys — to tell ⌥ held to talk from ⌥ used in a shortcut.
//
// Closing the window leaves him in the menu bar, still listening for ⌥.
// Built by scripts/app.mjs into ~/Applications/Jett.app.

import AppKit
import AVFoundation
import Speech
import WebKit

// MARK: - Where things live

/// His folder. ~/.jett, or what it was called before the core has moved it.
func jettHome() -> String {
    if let h = ProcessInfo.processInfo.environment["JETT_HOME"], !h.isEmpty { return h }
    let base = FileManager.default.homeDirectoryForCurrentUser
    for name in [".jett", ".emrys", ".jarvis"] {
        let p = base.appendingPathComponent(name).path
        if FileManager.default.fileExists(atPath: p) { return p }
    }
    return base.appendingPathComponent(".jett").path
}

func logsDir() -> String { (jettHome() as NSString).appendingPathComponent("logs") }

// MARK: - Log

/// ~/.jett/logs/app.log — what it could and could not do, for when ⌥ "does nothing".
func log(_ line: String) {
    let dir = logsDir()
    let path = (dir as NSString).appendingPathComponent("app.log")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let stamp = ISO8601DateFormatter().string(from: Date())
    let data = "\(stamp) \(line)\n".data(using: .utf8)!
    if let h = FileHandle(forWritingAtPath: path) {
        h.seekToEndOfFile()
        h.write(data)
        try? h.close()
    } else {
        FileManager.default.createFile(atPath: path, contents: data)
    }
}

// MARK: - The core

/// The connection to Jett's core for the talk key. Reconnects quietly for as long as the app runs.
final class Core: NSObject, URLSessionWebSocketDelegate {
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private(set) var connected = false
    var onMessage: ([String: Any]) -> Void = { _ in }
    var onConnection: (Bool) -> Void = { _ in }

    override init() {
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    }

    /// Where the core said to find it: written by the core at start-up, readable only by this user.
    static func config() -> (port: Int, token: String, app: Int)? {
        let path = (jettHome() as NSString).appendingPathComponent("helper.json")
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String else { return nil }
        return ((json["port"] as? Int) ?? 8787, token, (json["app"] as? Int) ?? 4180)
    }

    func connect() {
        guard task == nil else { return }
        guard let cfg = Core.config(),
              let url = URL(string: "ws://127.0.0.1:\(cfg.port)/helper?token=\(cfg.token)") else {
            retry()
            return
        }
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receive(t)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self, t === self.task else { return }
            switch result {
            case .success(.string(let text)):
                if let data = text.data(using: .utf8),
                   let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self.onMessage(msg)
                }
                self.receive(t)
            case .success:
                self.receive(t)
            case .failure:
                self.dropped()
            }
        }
    }

    func send(_ msg: [String: Any]) {
        guard connected, let t = task,
              let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        t.send(.string(text)) { _ in }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        connected = true
        onConnection(true)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        dropped()
    }

    private func dropped() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if connected {
            connected = false
            onConnection(false)
        }
        retry()
    }

    private func retry() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.connect() }
    }
}

// MARK: - Listening

/// The microphone and the recogniser, for one press at a time.
final class Listener {
    private let recognizer: SFSpeechRecognizer?
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var heard = ""
    private var finished: ((String) -> Void)?
    private var deadline: DispatchWorkItem?
    var onPartial: (String) -> Void = { _ in }

    /// On this Mac's own language when it recognises on-device, else US English
    /// on-device, else the system language through Apple's servers.
    init() {
        let candidates = [Locale.current, Locale(identifier: "en-US")]
        let onDevice = candidates.lazy.compactMap { SFSpeechRecognizer(locale: $0) }.first { $0.supportsOnDeviceRecognition }
        recognizer = onDevice ?? SFSpeechRecognizer(locale: Locale.current)
    }

    var onDevice: Bool { recognizer?.supportsOnDeviceRecognition ?? false }

    func start() -> Bool {
        cancel()
        guard let recognizer, recognizer.isAvailable else {
            log("listen: no recogniser available")
            return false
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        req.addsPunctuation = true
        request = req
        heard = ""

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            log("listen: no microphone input")
            return false
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            req.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            log("listen: microphone would not start — \(error.localizedDescription)")
            return false
        }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let result {
                    self.heard = result.bestTranscription.formattedString
                    if result.isFinal {
                        self.complete()
                    } else {
                        self.onPartial(self.heard)
                    }
                } else if error != nil {
                    self.complete()
                }
            }
        }
        return true
    }

    /// The key came up: stop recording and hand back the words, as soon as the
    /// recogniser has finished with them — or what it had, after a second and a half.
    func finish(_ done: @escaping (String) -> Void) {
        guard request != nil else {
            done("")
            return
        }
        finished = done
        stopAudio()
        request?.endAudio()
        let item = DispatchWorkItem { [weak self] in self?.complete() }
        deadline = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: item)
    }

    func cancel() {
        finished = nil
        deadline?.cancel()
        task?.cancel()
        task = nil
        request = nil
        stopAudio()
    }

    private func complete() {
        guard let done = finished else { return }
        finished = nil
        deadline?.cancel()
        task?.cancel()
        task = nil
        request = nil
        stopAudio()
        done(heard.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }

    // MARK: a recording, not the microphone

    private var fileTask: SFSpeechRecognitionTask?

    /// Write down a recording with the same recogniser the talk key uses. This
    /// is how `npm run preflight` checks these ears without anyone speaking:
    /// the core says a sentence into a file, and the words have to come back.
    func transcribe(file: URL, _ done: @escaping (_ text: String, _ error: String) -> Void) {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            done("", "speech recognition is not allowed yet")
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            done("", "no recogniser available")
            return
        }
        fileTask?.cancel()
        let req = SFSpeechURLRecognitionRequest(url: file)
        req.shouldReportPartialResults = false
        req.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        var answered = false
        let answer: (String, String) -> Void = { text, error in
            DispatchQueue.main.async {
                guard !answered else { return }
                answered = true
                done(text.trimmingCharacters(in: .whitespacesAndNewlines), error)
            }
        }
        let task = recognizer.recognitionTask(with: req) { result, error in
            if let result {
                if result.isFinal { answer(result.bestTranscription.formattedString, "") }
            } else if let error {
                answer("", error.localizedDescription)
            }
        }
        fileTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            guard !answered else { return }
            task.cancel()
            answer("", "the recogniser took too long")
        }
    }
}

// MARK: - The talk key

/// ⌥ Option, held on its own, anywhere. Anything else pressed while it is down
/// — ⌥→ to jump a word, ⌥3 for a #, an ⌥-click — means it was a shortcut, not a
/// request to talk, and the press is dropped without a sound.
final class TalkKey {
    var onPress: () -> Void = {}
    var onAnnounce: () -> Void = {}
    var onRelease: () -> Void = {}
    var onCancel: () -> Void = {}

    private var monitors: [Any] = []
    private var down = false
    private var spoiled = false
    private var downAt = Date()
    private var announce: DispatchWorkItem?
    private var watch: Timer?

    /// How long ⌥ has to be held before anything is shown. Long enough that a
    /// shortcut never flashes the interface; short enough not to be felt.
    private let settle: TimeInterval = 0.18
    /// Nobody holds a key this long on purpose; a missed key-up should not hold the microphone.
    private let longest: TimeInterval = 120

    func install() {
        uninstall()
        // Other apps: modifier changes are all that arrive without Accessibility — and all this needs.
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged], handler: { [weak self] e in
            self?.handle(e)
        }) { monitors.append(m) }
        // His own window: everything arrives, so a shortcut is caught the instant it is typed.
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown], handler: { [weak self] e in
            self?.handle(e)
            return e
        }) { monitors.append(m) }
    }

    func uninstall() {
        monitors.forEach { NSEvent.removeMonitor($0) }
        monitors = []
        watch?.invalidate()
        watch = nil
        announce?.cancel()
        down = false
        spoiled = false
    }

    /// Has a key or a mouse button gone down, in any app, since ⌥ did? The
    /// system keeps the time of the last one; it does not say which.
    private func usedAsShortcut() -> Bool {
        let held = Date().timeIntervalSince(downAt)
        for type in [CGEventType.keyDown, .leftMouseDown, .rightMouseDown] {
            let since = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: type)
            if since < held - 0.03 { return true }
        }
        return false
    }

    private func handle(_ e: NSEvent) {
        if e.type != .flagsChanged {
            if down && !spoiled { spoil() }
            return
        }
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let option = flags.contains(.option)
        let others = !flags.intersection([.command, .control, .shift, .function]).isEmpty
        if option && !down {
            down = true
            downAt = Date()
            spoiled = others
            if spoiled { return }
            onPress()
            let item = DispatchWorkItem { [weak self] in
                guard let self, self.down, !self.spoiled else { return }
                if self.usedAsShortcut() {
                    self.spoil()
                } else {
                    self.onAnnounce()
                }
            }
            announce = item
            DispatchQueue.main.asyncAfter(deadline: .now() + settle, execute: item)
            watch?.invalidate()
            watch = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.check() }
        } else if option && down && others && !spoiled {
            spoil()
        } else if !option && down {
            lifted()
        }
    }

    /// While ⌥ is down: a key pressed in another app, or a key-up that never arrived.
    private func check() {
        guard down else { return }
        let stillHeld = NSEvent.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.option)
        if !stillHeld || Date().timeIntervalSince(downAt) > longest {
            lifted()
        } else if !spoiled && usedAsShortcut() {
            spoil()
        }
    }

    private func lifted() {
        down = false
        announce?.cancel()
        watch?.invalidate()
        watch = nil
        if spoiled {
            spoiled = false
            return
        }
        if usedAsShortcut() {
            onCancel()
        } else {
            onRelease()
        }
    }

    private func spoil() {
        spoiled = true
        announce?.cancel()
        onCancel()
    }
}

// MARK: - The app

final class Jett: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    private let core = Core()
    private let listener = Listener()
    private let key = TalkKey()
    private var item: NSStatusItem!
    private let menu = NSMenu()
    private var window: NSWindow!
    private var web: WKWebView!

    private let background = CommandLine.arguments.contains("--background")
    private var appPort = 4180
    private var appURL: URL { URL(string: "http://localhost:\(appPort)/")! }

    private var phase = "offline"
    private var apps = 0
    private var announced = false
    private var enabled = UserDefaults.standard.object(forKey: "talkKey") as? Bool ?? true

    /// The interface is on screen (rather than the "starting" page, or nothing).
    private var loaded = false
    private var loading = false

    private static let showName = Notification.Name("com.jett.app.show")

    func applicationDidFinishLaunching(_ note: Notification) {
        // One Jett. A second launch brings the first one's window forward and leaves.
        let mine = Bundle.main.bundleIdentifier ?? "com.jett.app"
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: mine)
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !others.isEmpty {
            if !background {
                DistributedNotificationCenter.default().postNotificationName(Jett.showName, object: nil, userInfo: nil, deliverImmediately: true)
            }
            exit(0)
        }
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(showWindow), name: Jett.showName, object: nil)

        if let cfg = Core.config() { appPort = cfg.app }

        buildMainMenu()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        menu.delegate = self
        item.menu = menu
        buildWindow()
        refresh()

        core.onConnection = { [weak self] up in
            guard let self else { return }
            log(up ? "connected to the core" : "lost the core")
            if !up {
                self.phase = "offline"
                self.apps = 0
            }
            self.refresh()
            if up { self.sendStatus(force: true) }
        }
        core.onMessage = { [weak self] msg in self?.received(msg) }
        core.connect()

        listener.onPartial = { [weak self] text in
            guard let self, self.announced else { return }
            self.core.send(["type": "heard", "text": text, "final": false])
        }

        key.onPress = { [weak self] in self?.pressed() }
        key.onAnnounce = { [weak self] in self?.announce() }
        key.onRelease = { [weak self] in self?.released() }
        key.onCancel = { [weak self] in self?.cancelled() }
        if enabled { key.install() }

        log("started\(background ? " in the background" : "") — \(permissionSummary)")
        askForPermissions()
        load()
        if !background { showWindow() }

        // Permissions are granted in System Settings while this runs, and the
        // core can come up after the app does: notice both.
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.sendStatus()
            if !self.loaded && !self.loading { self.load() }
            self.requests()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return false
    }

    // MARK: window

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "Jett/2.0"
        config.websiteDataStore = .default()

        // Sharing the screen with him is off in an embedded page unless asked for.
        let prefs = config.preferences
        if prefs.responds(to: NSSelectorFromString("_setScreenCaptureEnabled:")) {
            prefs.setValue(true, forKey: "screenCaptureEnabled")
        }

        // The page's own errors, into app.log: a blank window should leave a reason behind.
        let capture = """
        (function () {
          var post = function (level, args) {
            try {
              var text = Array.prototype.map.call(args, function (a) {
                try { return typeof a === 'string' ? a : (a && (a.stack || a.message)) || JSON.stringify(a) } catch (e) { return String(a) }
              }).join(' ').slice(0, 1500)
              window.webkit.messageHandlers.jett.postMessage({ type: 'log', level: level, text: text })
            } catch (e) {}
          }
          var error = console.error
          console.error = function () { post('error', arguments); return error.apply(console, arguments) }
          window.addEventListener('error', function (e) { post('error', [e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')]) })
          window.addEventListener('unhandledrejection', function (e) { post('error', ['unhandled: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)]) })
        })()
        """
        config.userContentController.addUserScript(WKUserScript(source: capture, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "jett")

        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.autoresizingMask = [.width, .height]
        web.allowsBackForwardNavigationGestures = false
        // No white flash before the page paints its own dark background.
        if web.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
            web.setValue(false, forKey: "drawsBackground")
        }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Jett"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 10 / 255, green: 12 / 255, blue: 17 / 255, alpha: 1)
        window.minSize = NSSize(width: 1040, height: 660)
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("JettMain")
    }

    @objc func showWindow() {
        NSApp.setActivationPolicy(.regular)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if !loaded && !loading { load() }
    }

    /// Closing the window is not quitting: he stays in the menu bar, and ⌥ still works.
    func windowWillClose(_ notification: Notification) {
        DispatchQueue.main.async { NSApp.setActivationPolicy(.accessory) }
    }

    private func load() {
        loading = true
        web.load(URLRequest(url: appURL, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 8))
    }

    @objc private func reload() {
        loaded = false
        load()
    }

    @objc private func zoomIn() { web.pageZoom = min(web.pageZoom + 0.1, 2) }
    @objc private func zoomOut() { web.pageZoom = max(web.pageZoom - 0.1, 0.6) }
    @objc private func zoomReset() { web.pageZoom = 1 }

    private func isOurs(host: String?, port: Int?) -> Bool {
        (host == "localhost" || host == "127.0.0.1") && port == appPort
    }

    /// Shown until the core answers; the two-second timer keeps trying.
    private func waiting() {
        let html = """
        <!doctype html><meta charset="utf-8"><title>Jett</title>
        <style>
          html,body{height:100%;margin:0;background:#0a0c11;color:#aab3c5;font:15px -apple-system,system-ui;display:grid;place-items:center}
          div{text-align:center}b{display:block;color:#e8ecf5;font-size:22px;font-weight:600;margin-bottom:8px}
          i{display:block;width:14px;height:14px;border-radius:50%;background:#9fb4ff;margin:0 auto 22px;animation:p 1.6s ease-in-out infinite}
          @keyframes p{50%{transform:scale(1.5);opacity:.5}}small{display:block;margin-top:14px;opacity:.6}
          code{font:13px ui-monospace,monospace;background:#161a24;padding:2px 6px;border-radius:5px}
        </style>
        <div><i></i><b>Starting Jett…</b>Waiting for his core on this Mac.
        <small>If this stays, run <code>npm run service:install</code> in the Jett folder.</small></div>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: the page

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let url = webView.url, isOurs(host: url.host, port: url.port) {
            loading = false
            if !loaded { log("interface loaded") }
            loaded = true
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    private func failed(_ error: Error) {
        // Opening a link elsewhere cancels the navigation here; that is not a failure.
        if (error as NSError).code == NSURLErrorCancelled { return }
        if (error as NSError).domain == "WebKitErrorDomain" && (error as NSError).code == 102 { return }
        let wasLoaded = loaded
        loading = false
        loaded = false
        if wasLoaded || web.url == nil || web.url?.scheme != "about" {
            log("interface not reachable — \(error.localizedDescription)")
            waiting()
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("the page's process ended — reloading")
        loaded = false
        load()
    }

    /// His own pages stay in the window. Anything else — a link in an answer,
    /// another app's address — opens where it belongs.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else {
            decisionHandler(.cancel)
            return
        }
        guard let target = action.targetFrame else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        if !target.isMainFrame {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || ((scheme == "http" || scheme == "https") && isOurs(host: url.host, port: url.port)) {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    /// The microphone, camera and screen, for his own page only. macOS still
    /// asks you once itself; this just spares a second question on every use.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(frame.isMainFrame && isOurs(host: origin.host, port: origin.port) ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard frame.isMainFrame else {
            completionHandler()
            return
        }
        let alert = NSAlert()
        alert.messageText = "Jett"
        alert.informativeText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame else {
            completionHandler(false)
            return
        }
        let alert = NSAlert()
        alert.messageText = "Jett"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    /// Messages from his own page, and only his own page — never a frame inside it.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, isOurs(host: origin.host, port: origin.port),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "log":
            log("page \(body["level"] as? String ?? "error"): \(body["text"] as? String ?? "")")
        case "talk":
            // The on-screen talk button, held like the key.
            if body["down"] as? Bool == true {
                pressed()
                announce()
            } else if body["cancelled"] as? Bool == true {
                cancelled()
            } else {
                released()
            }
        default:
            break
        }
    }

    // MARK: requests from the Terminal

    /// `touch ~/.jett/logs/snapshot.request` writes a picture of the window to
    /// snapshot.png beside it; reload.request reloads the page; show.request
    /// brings the window forward. For checking on him without clicking.
    private func requests() {
        let dir = logsDir()
        let fm = FileManager.default
        func asked(_ name: String) -> Bool {
            let path = (dir as NSString).appendingPathComponent(name)
            guard fm.fileExists(atPath: path) else { return false }
            try? fm.removeItem(atPath: path)
            return true
        }
        if asked("show.request") { showWindow() }
        if asked("reload.request") { reload() }
        if asked("snapshot.request") {
            let out = (dir as NSString).appendingPathComponent("snapshot.png")
            web.takeSnapshot(with: nil) { image, error in
                guard let image, let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else {
                    log("snapshot failed — \(error?.localizedDescription ?? "no image")")
                    return
                }
                try? png.write(to: URL(fileURLWithPath: out))
                log("snapshot written")
            }
        }
    }

    // MARK: talking

    private var listeningAllowed: Bool {
        SFSpeechRecognizer.authorizationStatus() == .authorized
            && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    private var ready: Bool { enabled && core.connected && listeningAllowed }

    private var permissionSummary: String {
        "speech \(speechState), microphone \(micState), talk key \(enabled ? "on" : "off"), \(listener.onDevice ? "on-device" : "server") recognition"
    }

    private var speechState: String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return "yes"
        case .notDetermined: return "not asked"
        default: return "NO"
        }
    }

    private var micState: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "yes"
        case .notDetermined: return "not asked"
        default: return "NO"
        }
    }

    private var lastStatus = ""

    /// What the core and the page need to know: whether ⌥ will be heard from
    /// here, and if not, what is missing — so the page keeps handling ⌥ itself
    /// until it is.
    private func sendStatus(force: Bool = false) {
        var missing: [String] = []
        if SFSpeechRecognizer.authorizationStatus() != .authorized { missing.append("speech") }
        if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized { missing.append("microphone") }
        if !enabled { missing.append("off") }
        let key = missing.joined(separator: ",")
        guard force || key != lastStatus else { return }
        lastStatus = key
        core.send(["type": "status", "ready": missing.isEmpty, "missing": missing, "transcribes": true])
        refresh()
    }

    private func pressed() {
        log("talk — \(ready ? "listening" : "not ready: \(permissionSummary)")\(apps == 0 ? ", interface not connected" : "")")
        guard ready else { return }
        if apps == 0 {
            showWindow()
            return
        }
        announced = false
        if !listener.start() { log("could not start listening") }
    }

    private func announce() {
        guard ready, apps > 0 else { return }
        announced = true
        core.send(["type": "talk", "down": true])
        phase = "listening"
        refresh()
    }

    private func released() {
        guard announced else {
            listener.cancel()
            return
        }
        announced = false
        core.send(["type": "talk", "down": false])
        listener.finish { [weak self] text in
            log("heard \(text.split(separator: " ").count) words")
            self?.core.send(["type": "heard", "text": text, "final": true])
        }
    }

    private func cancelled() {
        listener.cancel()
        if announced {
            log("⌥ used as a shortcut — ignored")
            announced = false
            core.send(["type": "talk", "down": false, "cancelled": true])
        }
    }

    private func received(_ msg: [String: Any]) {
        if msg["type"] as? String == "transcribe", let id = msg["id"] as? String, let path = msg["path"] as? String {
            hearRecording(id: id, path: path)
            return
        }
        guard msg["type"] as? String == "state" else { return }
        if let p = msg["phase"] as? String { phase = p }
        if let n = msg["apps"] as? Int { apps = n }
        refresh()
    }

    /// Preflight asks for a recording Jett made to be written down. Only a
    /// recording in his own logs folder is ever read.
    private func hearRecording(id: String, path: String) {
        let file = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        let logs = URL(fileURLWithPath: logsDir()).resolvingSymlinksInPath().path + "/"
        guard file.path.hasPrefix(logs), file.pathExtension == "wav" else {
            core.send(["type": "transcribed", "id": id, "text": "", "error": "not one of Jett's recordings"])
            return
        }
        listener.transcribe(file: file) { [weak self] text, error in
            log("preflight: heard \(text.split(separator: " ").count) words\(error.isEmpty ? "" : " — \(error)")")
            self?.core.send(["type": "transcribed", "id": id, "text": text, "error": error])
        }
    }

    // MARK: permissions

    private func askForPermissions() {
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { _ in
                DispatchQueue.main.async {
                    log("speech recognition: \(self.speechState)")
                    self.sendStatus()
                }
            }
        }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async {
                    log("microphone: \(self.micState)")
                    self.sendStatus()
                }
            }
        }
    }

    @objc private func allowListening() {
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined
            || AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            askForPermissions()
        } else if SFSpeechRecognizer.authorizationStatus() != .authorized {
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")
        } else {
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        }
    }

    // MARK: menus

    @objc private func toggleKey() {
        enabled.toggle()
        UserDefaults.standard.set(enabled, forKey: "talkKey")
        if enabled { key.install() } else { key.uninstall(); listener.cancel() }
        refresh()
        sendStatus()
    }

    private func open(_ url: String) {
        if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    }

    private var statusLine: String {
        if !core.connected { return "Jett’s core isn’t running" }
        switch phase {
        case "listening": return "Listening…"
        case "thinking": return "Thinking…"
        case "tooling": return "Working…"
        case "speaking": return "Speaking…"
        default:
            if !enabled { return "Talk key is off" }
            return listeningAllowed ? "Ready — hold ⌥ Option to talk" : "Needs the microphone to hear ⌥"
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let status = NSMenuItem(title: statusLine, action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())
        menu.addItem(entry("Open Jett", #selector(showWindow)))
        let toggle = entry("Talk key (hold ⌥ Option)", #selector(toggleKey))
        toggle.state = enabled ? .on : .off
        menu.addItem(toggle)
        if !listeningAllowed {
            menu.addItem(.separator())
            menu.addItem(entry("Allow listening… (Microphone, Speech)", #selector(allowListening)))
        }
        let note = NSMenuItem(title: listener.onDevice ? "Speech is recognised on this Mac" : "Speech is recognised by Apple", action: nil, keyEquivalent: "")
        note.isEnabled = false
        menu.addItem(.separator())
        menu.addItem(note)
        let quit = NSMenuItem(title: "Quit Jett", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        menu.addItem(quit)
    }

    private func entry(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let m = NSMenuItem(title: title, action: action, keyEquivalent: key)
        m.target = self
        return m
    }

    /// The menu bar across the top while his window is in front. Without an
    /// Edit menu, ⌘C and ⌘V do nothing in the message box.
    private func buildMainMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            let holder = NSMenuItem()
            holder.submenu = m
            main.addItem(holder)
        }
        func sys(_ title: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let m = NSMenuItem(title: title, action: action, keyEquivalent: key)
            m.keyEquivalentModifierMask = mods
            return m
        }
        add("Jett", [
            sys("About Jett", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            sys("Hide Jett", #selector(NSApplication.hide(_:)), "h"),
            sys("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            sys("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            sys("Quit Jett", #selector(NSApplication.terminate(_:)), "q"),
        ])
        add("Edit", [
            sys("Undo", Selector(("undo:")), "z"),
            sys("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            sys("Cut", #selector(NSText.cut(_:)), "x"),
            sys("Copy", #selector(NSText.copy(_:)), "c"),
            sys("Paste", #selector(NSText.paste(_:)), "v"),
            sys("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        add("View", [
            entry("Reload", #selector(reload), "r"),
            .separator(),
            entry("Actual Size", #selector(zoomReset), "0"),
            entry("Zoom In", #selector(zoomIn), "="),
            entry("Zoom Out", #selector(zoomOut), "-"),
            .separator(),
            sys("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        add("Window", [
            sys("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            sys("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }

    /// The menu-bar orb: hollow when nothing is reachable, a quiet dot at rest,
    /// coloured while he listens, thinks or speaks.
    private func refresh() {
        guard let button = item?.button else { return }
        let color: NSColor?
        var hollow = false
        if !core.connected || !enabled {
            hollow = true
            color = nil
        } else {
            switch phase {
            case "listening": color = NSColor(red: 0.50, green: 0.89, blue: 0.82, alpha: 1)
            case "thinking", "tooling": color = NSColor(red: 0.71, green: 0.61, blue: 1.0, alpha: 1)
            case "speaking": color = NSColor(red: 0.62, green: 0.71, blue: 1.0, alpha: 1)
            default: color = nil
            }
        }
        button.image = orb(color: color, hollow: hollow, badge: !listeningAllowed && core.connected)
        button.toolTip = "Jett — \(statusLine)"
    }

    private func orb(color: NSColor?, hollow: Bool, badge: Bool) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            let r = NSRect(x: 4, y: 4, width: 10, height: 10)
            let path = NSBezierPath(ovalIn: hollow ? r.insetBy(dx: 0.75, dy: 0.75) : r)
            if hollow {
                NSColor.black.setStroke()
                path.lineWidth = 1.5
                path.stroke()
            } else {
                (color ?? NSColor.black).setFill()
                path.fill()
            }
            if badge {
                NSColor.systemOrange.setFill()
                NSBezierPath(ovalIn: NSRect(x: 12, y: 12, width: 5, height: 5)).fill()
            }
            return true
        }
        // A plain dot follows the menu bar's own light or dark; a coloured one keeps its colour.
        image.isTemplate = color == nil && !badge
        return image
    }
}

let app = NSApplication.shared
let jett = Jett()
app.delegate = jett
app.setActivationPolicy(CommandLine.arguments.contains("--background") ? .accessory : .regular)
app.run()
