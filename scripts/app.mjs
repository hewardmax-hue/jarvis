/**
 * Building and running Jett, the Mac app (app/Jett.swift).
 *
 * Used by scripts/service.mjs: install builds it into ~/Applications/Jett.app
 * and starts it at login, quietly, in the menu bar; uninstall removes both.
 * Everything uses what macOS and the Command Line Tools ship — swiftc,
 * codesign, iconutil — and nothing is downloaded.
 *
 * The app is only rebuilt when its source changes. macOS ties the permissions
 * it needs — Microphone and Speech Recognition — to the exact build, so
 * rebuilding on every install would mean granting them again every time.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'app', 'Jett.swift')
const ICON = join(ROOT, 'public', 'jett-icon.svg')
export const APP = join(homedir(), 'Applications', 'Jett.app')
const BINARY = join(APP, 'Contents', 'MacOS', 'Jett')
const STAMP = join(APP, 'Contents', 'Resources', 'build.sha')
export const APP_LABEL = 'com.jett.app'
const AGENTS = join(homedir(), 'Library', 'LaunchAgents')
const PLIST = join(AGENTS, `${APP_LABEL}.plist`)
const DOMAIN = `gui/${userInfo().uid}`

/**
 * What came before the app: a menu-bar helper that only carried the talk key,
 * under his earlier name. The app does its job now, and two of them would both
 * answer ⌥.
 */
const LEGACY = [
  { label: 'com.emrys.helper', app: join(homedir(), 'Applications', 'Emrys Helper.app'), process: 'EmrysHelper' },
  { label: 'com.jett.helper', app: join(homedir(), 'Applications', 'Jett Helper.app'), process: 'JettHelper' },
]

const INFO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${APP_LABEL}</string>
  <key>CFBundleName</key><string>Jett</string>
  <key>CFBundleDisplayName</key><string>Jett</string>
  <key>CFBundleExecutable</key><string>Jett</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Jett listens only while you hold ⌥ Option or the talk button.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Jett turns what you say while holding ⌥ Option into words, on this Mac where it can.</string>
  <key>NSCameraUsageDescription</key><string>Jett uses the camera only when you ask him to look at something or turn on hand gestures.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
</dict>
</plist>
`

const sourceHash = () =>
  createHash('sha1')
    .update(readFileSync(SOURCE))
    .update(INFO)
    .update(existsSync(ICON) ? readFileSync(ICON) : '')
    .digest('hex')

/**
 * Compile with the first SDK the installed compiler accepts. The Command Line
 * Tools can ship an SDK newer than their own swiftc — on this Mac the default
 * is — and that combination refuses to build at all.
 */
function compile(out) {
  const sdks = ['']
  const dir = '/Library/Developer/CommandLineTools/SDKs'
  if (existsSync(dir)) {
    sdks.push(
      ...readdirSync(dir)
        .filter((d) => /^MacOSX\d[\d.]*\.sdk$/.test(d))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((d) => join(dir, d)),
    )
  }
  let last = ''
  for (const sdk of sdks) {
    const args = [
      '-O',
      ...(sdk ? ['-sdk', sdk] : []),
      '-target', 'arm64-apple-macos13',
      SOURCE,
      '-o', out,
      '-framework', 'AppKit',
      '-framework', 'WebKit',
      '-framework', 'Speech',
      '-framework', 'AVFoundation',
    ]
    const r = spawnSync('swiftc', args, { encoding: 'utf8' })
    if (r.status === 0) return
    last = r.stderr || r.stdout || String(r.error ?? '')
  }
  throw new Error(`could not compile the app:\n${last.split('\n').slice(0, 12).join('\n')}`)
}

/** AppIcon.icns from the Jett icon, for the Dock, Launchpad and permission dialogs. */
function icon(resources) {
  if (!existsSync(ICON)) return
  const work = join(tmpdir(), `jett-icon-${process.pid}`)
  const set = join(work, 'AppIcon.iconset')
  mkdirSync(set, { recursive: true })
  try {
    spawnSync('qlmanage', ['-t', '-s', '1024', '-o', work, ICON], { stdio: 'ignore' })
    const big = join(work, `${ICON.split('/').pop()}.png`)
    if (!existsSync(big)) return
    for (const size of [16, 32, 128, 256, 512]) {
      spawnSync('sips', ['-z', `${size}`, `${size}`, big, '--out', join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' })
      spawnSync('sips', ['-z', `${size * 2}`, `${size * 2}`, big, '--out', join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' })
    }
    spawnSync('iconutil', ['-c', 'icns', set, '-o', join(resources, 'AppIcon.icns')], { stdio: 'ignore' })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export function appBuilt() {
  return existsSync(BINARY) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === sourceHash()
}

/** Build the app bundle if its source changed. Returns true when it was rebuilt. */
export function buildApp() {
  if (appBuilt()) return false
  const hash = sourceHash()
  const staging = `${APP}.building`
  rmSync(staging, { recursive: true, force: true })
  const macos = join(staging, 'Contents', 'MacOS')
  const resources = join(staging, 'Contents', 'Resources')
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(staging, 'Contents', 'Info.plist'), INFO)
  compile(join(macos, 'Jett'))
  icon(resources)
  writeFileSync(join(resources, 'build.sha'), `${hash}\n`)
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', APP_LABEL, staging], { stdio: 'pipe' })
  stopApp()
  rmSync(APP, { recursive: true, force: true })
  mkdirSync(dirname(APP), { recursive: true })
  renameSync(staging, APP)
  return true
}

function loaded(label = APP_LABEL) {
  return spawnSync('launchctl', ['print', `${DOMAIN}/${label}`], { stdio: 'ignore' }).status === 0
}

/** Running at all — started by launchd at login, or opened by hand. */
export function appRunning() {
  return spawnSync('pgrep', ['-f', BINARY], { stdio: 'ignore' }).status === 0
}

/** Stop it, however it was started: launchd's copy, and one opened from the Dock. */
export function stopApp() {
  if (loaded()) spawnSync('launchctl', ['bootout', `${DOMAIN}/${APP_LABEL}`], { stdio: 'ignore' })
  spawnSync('pkill', ['-f', BINARY], { stdio: 'ignore' })
}

/**
 * Remove the menu-bar helpers the app replaces. Returns the names of what it
 * found, so the installer can say so.
 */
export function retireLegacy() {
  const gone = []
  for (const old of LEGACY) {
    const plist = join(AGENTS, `${old.label}.plist`)
    const present = loaded(old.label) || existsSync(plist) || existsSync(old.app)
    if (loaded(old.label)) spawnSync('launchctl', ['bootout', `${DOMAIN}/${old.label}`], { stdio: 'ignore' })
    spawnSync('pkill', ['-x', old.process], { stdio: 'ignore' })
    if (existsSync(plist)) rmSync(plist)
    rmSync(old.app, { recursive: true, force: true })
    if (present) gone.push(old.app.split('/').pop().replace(/\.app$/, ''))
  }
  return gone
}

/**
 * Start it now and at every login — in the menu bar, without opening a window.
 * Quitting it from its menu exits cleanly and it stays quit until the next
 * login; a crash is restarted.
 */
export async function startApp(plist) {
  mkdirSync(AGENTS, { recursive: true })
  writeFileSync(
    PLIST,
    plist({
      Label: APP_LABEL,
      ProgramArguments: [BINARY, '--background'],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      LimitLoadToSessionType: 'Aqua',
      ProcessType: 'Interactive',
    }),
  )
  stopApp()
  for (let i = 0; i < 20 && loaded(); i++) await new Promise((r) => setTimeout(r, 250))
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = spawnSync('launchctl', ['bootstrap', DOMAIN, PLIST], { encoding: 'utf8' })
    if (r.status === 0) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('launchctl refused to start the app')
}

/** Bring its window forward — the same as clicking it in the Dock or Launchpad. */
export function openApp() {
  spawnSync('open', [APP], { stdio: 'ignore' })
}

export function removeApp() {
  stopApp()
  if (existsSync(PLIST)) rmSync(PLIST)
  rmSync(APP, { recursive: true, force: true })
  retireLegacy()
}

// `node scripts/app.mjs` builds it and opens it, without touching what starts at login.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rebuilt = buildApp()
  console.log(rebuilt ? `Built ${APP}.` : `${APP} is up to date.`)
  if (!process.argv.includes('--no-open')) openApp()
}
