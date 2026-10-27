/**
 * Building and running the menu-bar helper (helper/EmrysHelper.swift).
 *
 * Used by scripts/service.mjs: install builds it into
 * ~/Applications/Emrys Helper.app and starts it at login; uninstall removes
 * both. Everything uses what macOS and the Command Line Tools ship — swiftc,
 * codesign, iconutil — and nothing is downloaded.
 *
 * The app is only rebuilt when its source changes. macOS ties the permissions
 * it needs — Accessibility for the ⌥ key, Microphone and Speech Recognition —
 * to the exact build, so rebuilding on every install would mean granting them
 * again every time.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'helper', 'EmrysHelper.swift')
const ICON = join(ROOT, 'public', 'emrys-icon.svg')
export const HELPER_APP = join(homedir(), 'Applications', 'Emrys Helper.app')
const BINARY = join(HELPER_APP, 'Contents', 'MacOS', 'EmrysHelper')
const STAMP = join(HELPER_APP, 'Contents', 'Resources', 'build.sha')
export const HELPER_LABEL = 'com.emrys.helper'
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${HELPER_LABEL}.plist`)
const DOMAIN = `gui/${userInfo().uid}`

const INFO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${HELPER_LABEL}</string>
  <key>CFBundleName</key><string>Emrys Helper</string>
  <key>CFBundleDisplayName</key><string>Emrys Helper</string>
  <key>CFBundleExecutable</key><string>EmrysHelper</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Emrys listens only while you hold ⌥ Option.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Emrys turns what you say while holding ⌥ Option into words, on this Mac where it can.</string>
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
      '-framework', 'Speech',
      '-framework', 'AVFoundation',
    ]
    const r = spawnSync('swiftc', args, { encoding: 'utf8' })
    if (r.status === 0) return
    last = r.stderr || r.stdout || String(r.error ?? '')
  }
  throw new Error(`could not compile the helper:\n${last.split('\n').slice(0, 8).join('\n')}`)
}

/** AppIcon.icns from the Emrys icon, so permission dialogs and Settings show it. */
function icon(resources) {
  if (!existsSync(ICON)) return
  const work = join(tmpdir(), `emrys-icon-${process.pid}`)
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

export function helperBuilt() {
  return existsSync(BINARY) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === sourceHash()
}

/** Build the app bundle if its source changed. Returns true when it was rebuilt. */
export function buildHelper() {
  if (helperBuilt()) return false
  const hash = sourceHash()
  const staging = `${HELPER_APP}.building`
  rmSync(staging, { recursive: true, force: true })
  const macos = join(staging, 'Contents', 'MacOS')
  const resources = join(staging, 'Contents', 'Resources')
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(staging, 'Contents', 'Info.plist'), INFO)
  compile(join(macos, 'EmrysHelper'))
  icon(resources)
  writeFileSync(join(resources, 'build.sha'), `${hash}\n`)
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', HELPER_LABEL, staging], { stdio: 'pipe' })
  stopHelper()
  rmSync(HELPER_APP, { recursive: true, force: true })
  mkdirSync(dirname(HELPER_APP), { recursive: true })
  renameSync(staging, HELPER_APP)
  return true
}

function loaded() {
  return spawnSync('launchctl', ['print', `${DOMAIN}/${HELPER_LABEL}`], { stdio: 'ignore' }).status === 0
}

export function helperRunning() {
  const out = spawnSync('launchctl', ['print', `${DOMAIN}/${HELPER_LABEL}`], { encoding: 'utf8' })
  return out.status === 0 && /^\s*state = running$/m.test(out.stdout)
}

export function stopHelper() {
  if (loaded()) spawnSync('launchctl', ['bootout', `${DOMAIN}/${HELPER_LABEL}`], { stdio: 'ignore' })
}

/**
 * Start it now and at every login. Quitting it from its menu exits cleanly and
 * it stays quit until the next login; a crash is restarted.
 */
export async function startHelper(plist) {
  writeFileSync(
    PLIST,
    plist({
      Label: HELPER_LABEL,
      ProgramArguments: [BINARY],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      LimitLoadToSessionType: 'Aqua',
      ProcessType: 'Interactive',
    }),
  )
  stopHelper()
  for (let i = 0; i < 20 && loaded(); i++) await new Promise((r) => setTimeout(r, 250))
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = spawnSync('launchctl', ['bootstrap', DOMAIN, PLIST], { encoding: 'utf8' })
    if (r.status === 0) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('launchctl refused to start the helper')
}

export function removeHelper() {
  stopHelper()
  if (existsSync(PLIST)) rmSync(PLIST)
  rmSync(HELPER_APP, { recursive: true, force: true })
}
