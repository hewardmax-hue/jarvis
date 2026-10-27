// Emrys Helper — the talk key from anywhere, and Emrys in the menu bar.
//
// The web interface can only hear ⌥ while its own window is in front. This
// small native app lives in the menu bar instead: hold ⌥ Option on its own, in
// any app, and it listens; let go and what you said goes to Emrys.
//
// It does its own listening, with Apple's speech recognition — on-device when
// the language supports it — so it works whether the Emrys window is in front,
// behind other windows, or minimised. The microphone is open only while the
// key is held. Words go to the core over a private local socket (a token in
// ~/.emrys/helper.json that only this user can read), and the core hands them
// to the open Emrys window, which answers exactly as if you had typed them.
//
// Built by scripts/service.mjs into ~/Applications/Emrys Helper.app.

import AppKit
import AVFoundation
import Speech

// MARK: - Log

/// ~/.emrys/logs/helper.log — what it could and could not do, for when ⌥ "does nothing".
func log(_ line: String) {
    let home = ProcessInfo.processInfo.environment["EMRYS_HOME"]
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".emrys").path
    let dir = (home as NSString).appendingPathComponent("logs")
    let path = (dir as NSString).appendingPathComponent("helper.log")
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

/// The connection to Emrys's core. Reconnects quietly for as long as the helper runs.
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
    private func config() -> (port: Int, token: String)? {
        let home = ProcessInfo.processInfo.environment["EMRYS_HOME"]
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".emrys").path
        let path = (home as NSString).appendingPathComponent("helper.json")
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String else { return nil }
        return ((json["port"] as? Int) ?? 8787, token)
    }

    func connect() {
        guard task == nil else { return }
        guard let cfg = config(),
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
}

// MARK: - The talk key

/// ⌥ Option, held on its own, anywhere. Anything else pressed while it is down
/// — ⌥→ to jump a word, ⌥E for an accent — means it was a shortcut, not a
/// request to talk, and the press is dropped without a sound.
final class TalkKey {
    var onPress: () -> Void = {}
    var onAnnounce: () -> Void = {}
    var onRelease: () -> Void = {}
    var onCancel: () -> Void = {}

    private var monitors: [Any] = []
    private var down = false
    private var spoiled = false
    private var announce: DispatchWorkItem?

    /// How long ⌥ has to be held before anything is shown. Long enough that a
    /// shortcut never flashes the interface; short enough not to be felt.
    private let settle: TimeInterval = 0.18

    func install() {
        uninstall()
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown], handler: { [weak self] e in
            self?.handle(e)
        }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown], handler: { [weak self] e in
            self?.handle(e)
            return e
        }) { monitors.append(m) }
    }

    func uninstall() {
        monitors.forEach { NSEvent.removeMonitor($0) }
        monitors = []
    }

    private func handle(_ e: NSEvent) {
        if e.type == .keyDown {
            if down && !spoiled { spoil() }
            return
        }
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let option = flags.contains(.option)
        let others = !flags.intersection([.command, .control, .shift, .function]).isEmpty
        if option && !down {
            down = true
            spoiled = others
            if spoiled { return }
            onPress()
            let item = DispatchWorkItem { [weak self] in
                guard let self, self.down, !self.spoiled else { return }
                self.onAnnounce()
            }
            announce = item
            DispatchQueue.main.asyncAfter(deadline: .now() + settle, execute: item)
        } else if option && down && others && !spoiled {
            spoil()
        } else if !option && down {
            down = false
            announce?.cancel()
            if spoiled {
                spoiled = false
                return
            }
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

final class Helper: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let core = Core()
    private let listener = Listener()
    private let key = TalkKey()
    private var item: NSStatusItem!
    private let menu = NSMenu()

    private var phase = "offline"
    private var apps = 0
    private var trusted = AXIsProcessTrusted()
    private var announced = false
    private var enabled = UserDefaults.standard.object(forKey: "talkKey") as? Bool ?? true

    func applicationDidFinishLaunching(_ note: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        menu.delegate = self
        item.menu = menu
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

        log("started — \(permissionSummary)")
        askForPermissions()
        // Without Accessibility the ⌥ key never reaches this app at all, so ask
        // for it straight away rather than waiting to be found in the menu.
        if !trusted { allowKey() }

        // Permissions are granted in System Settings while this runs; notice,
        // restart the key monitors so they start receiving, and tell the core.
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self else { return }
            let now = AXIsProcessTrusted()
            if now != self.trusted {
                self.trusted = now
                log("Accessibility \(now ? "granted" : "withdrawn")")
                if self.enabled { self.key.install() }
                self.refresh()
            }
            self.sendStatus()
        }
    }

    // MARK: talking

    private var ready: Bool {
        enabled && trusted && core.connected
            && SFSpeechRecognizer.authorizationStatus() == .authorized
            && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    private var permissionSummary: String {
        "accessibility \(trusted ? "yes" : "NO"), speech \(speechState), microphone \(micState), talk key \(enabled ? "on" : "off"), \(listener.onDevice ? "on-device" : "server") recognition"
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

    /// What the core and the Emrys window need to know: whether ⌥ will work from
    /// here, and if not, what is missing — so the window keeps handling ⌥ itself
    /// until it does.
    private func sendStatus(force: Bool = false) {
        var missing: [String] = []
        if !trusted { missing.append("accessibility") }
        if SFSpeechRecognizer.authorizationStatus() != .authorized { missing.append("speech") }
        if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized { missing.append("microphone") }
        if !enabled { missing.append("off") }
        let key = missing.joined(separator: ",")
        guard force || key != lastStatus else { return }
        lastStatus = key
        core.send(["type": "status", "ready": missing.isEmpty, "missing": missing])
    }

    private func pressed() {
        log("⌥ down — \(ready ? "listening" : "not ready: \(permissionSummary)")\(apps == 0 ? ", Emrys window not open" : "")")
        guard ready else { return }
        if apps == 0 {
            openEmrys()
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
            log("⌥ up — heard \(text.split(separator: " ").count) words")
            self?.core.send(["type": "heard", "text": text, "final": true])
        }
    }

    private func cancelled() {
        log("⌥ used as a shortcut — ignored")
        listener.cancel()
        if announced {
            announced = false
            core.send(["type": "talk", "down": false, "cancelled": true])
        }
    }

    private func received(_ msg: [String: Any]) {
        guard msg["type"] as? String == "state" else { return }
        if let p = msg["phase"] as? String { phase = p }
        if let n = msg["apps"] as? Int { apps = n }
        refresh()
    }

    // MARK: permissions

    private func askForPermissions() {
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { _ in
                DispatchQueue.main.async {
                    log("speech recognition: \(self.speechState)")
                    self.refresh()
                    self.sendStatus()
                }
            }
        }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async {
                    log("microphone: \(self.micState)")
                    self.refresh()
                    self.sendStatus()
                }
            }
        }
    }

    @objc private func allowKey() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(options) {
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        }
    }

    @objc private func allowSpeech() {
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined
            || AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            askForPermissions()
        } else if SFSpeechRecognizer.authorizationStatus() != .authorized {
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")
        } else {
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        }
    }

    // MARK: menu

    @objc private func openEmrys() {
        // The installed app, by name; failing that, the page in the browser.
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-a", "Emrys"]
        task.terminationHandler = { t in
            if t.terminationStatus != 0 { self.open("http://localhost:4180/") }
        }
        try? task.run()
    }

    @objc private func toggleKey() {
        enabled.toggle()
        UserDefaults.standard.set(enabled, forKey: "talkKey")
        if enabled { key.install() } else { key.uninstall(); listener.cancel() }
        refresh()
        sendStatus()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func open(_ url: String) {
        if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    }

    private var statusLine: String {
        if !core.connected { return "Emrys’s core isn’t running" }
        if apps == 0 { return "Emrys isn’t open — hold ⌥ to open it" }
        switch phase {
        case "listening": return "Listening…"
        case "thinking": return "Thinking…"
        case "tooling": return "Working…"
        case "speaking": return "Speaking…"
        default: return enabled ? "Ready — hold ⌥ Option to talk" : "Talk key is off"
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let status = NSMenuItem(title: statusLine, action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())
        menu.addItem(entry("Open Emrys", #selector(openEmrys), "o"))
        let toggle = entry("Talk key (hold ⌥ Option)", #selector(toggleKey))
        toggle.state = enabled ? .on : .off
        menu.addItem(toggle)
        if !trusted {
            menu.addItem(.separator())
            menu.addItem(entry("Allow the ⌥ key… (Accessibility)", #selector(allowKey)))
        }
        if SFSpeechRecognizer.authorizationStatus() != .authorized
            || AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
            if trusted { menu.addItem(.separator()) }
            menu.addItem(entry("Allow listening… (Microphone, Speech)", #selector(allowSpeech)))
        }
        let note = NSMenuItem(title: listener.onDevice ? "Speech is recognised on this Mac" : "Speech is recognised by Apple", action: nil, keyEquivalent: "")
        note.isEnabled = false
        menu.addItem(.separator())
        menu.addItem(note)
        menu.addItem(entry("Quit Emrys Helper", #selector(quit), "q"))
    }

    private func entry(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let m = NSMenuItem(title: title, action: action, keyEquivalent: key)
        m.target = self
        return m
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
        let needsAttention = !trusted
            || SFSpeechRecognizer.authorizationStatus() != .authorized
            || AVCaptureDevice.authorizationStatus(for: .audio) != .authorized
        button.image = orb(color: color, hollow: hollow, badge: needsAttention && core.connected)
        button.toolTip = "Emrys — \(statusLine)"
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
let helper = Helper()
app.delegate = helper
app.setActivationPolicy(.accessory)
app.run()
