/**
 * The always-on core: the bridge as a macOS launchd agent.
 *
 *   npm run service:install     build the interface and the Mac app, start the core
 *                               and the app now and at every login (--no-app to skip
 *                               the app)
 *   npm run service:restart     put the core on the code that is on disk (it waits for
 *                               a running job; -- --force does not)
 *   npm run service:status      is it running, and what is scheduled
 *   npm run service:logs        the last of its output (-- --follow to tail)
 *   npm run service:uninstall   stop it and remove it
 *
 * Installed, the brain no longer depends on a terminal being open. launchd
 * starts it when you log in, restarts it if it dies, and it keeps the Mac
 * awake on mains power (caffeinate -s) so the schedule actually runs. The
 * face is unchanged: `npm start` notices the core is already up and starts
 * only the interface.
 *
 * It is a per-user LaunchAgent in ~/Library/LaunchAgents — no sudo, nothing
 * system-wide — and uninstall removes every trace of it.
 */

import '../bridge/env.mjs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOME, migrateHome } from '../bridge/home.mjs'
import { APP, appRunning, buildApp, openApp, removeApp, retireLegacy, startApp } from './app.mjs'

const LABEL = 'com.jett.core'
/** The service's names when he was called Emrys, and JARVIS before that. Replaced on install. */
const LEGACY_LABELS = ['com.emrys.core', 'com.jarvis.core']
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AGENTS = join(homedir(), 'Library', 'LaunchAgents')
const PLIST = join(AGENTS, `${LABEL}.plist`)
const LOGS = join(HOME, 'logs')
const OUT_LOG = join(LOGS, 'core.log')
const ERR_LOG = join(LOGS, 'core.err.log')
const DOMAIN = `gui/${userInfo().uid}`
const PORT = Number(process.env.JETT_PORT ?? process.env.JETT_BRIDGE_PORT ?? 8787)

const command = process.argv[2]

if (process.platform !== 'darwin') {
  console.error('The always-on service uses launchd, so it is macOS only. Run `npm run bridge` under your own process manager instead.')
  process.exit(1)
}

const actions = { install, uninstall, restart, status, logs }
if (!actions[command]) {
  console.error('Usage: node scripts/service.mjs install | uninstall | restart [--force] | status | logs [--follow]')
  process.exit(1)
}
await actions[command]()

// ---------------------------------------------------------------------------

async function install() {
  const health = await probe('/health')
  if (health && !health.service) {
    console.error(
      `Something is already serving port ${PORT} — probably \`npm start\` or ` +
        '`npm run bridge` in a terminal. Stop it first, then install.',
    )
    process.exit(1)
  }

  buildInterface()

  // A service under an earlier name goes first, so nothing is holding the port
  // or writing to the old folder while it moves. Then the memory folder moves
  // to ~/.jett — before the plist below points launchd's log files into it.
  for (const old of LEGACY_LABELS) {
    const oldPlist = join(AGENTS, `${old}.plist`)
    if (!existsSync(oldPlist) && !loaded(old)) continue
    spawnSync('launchctl', ['bootout', `${DOMAIN}/${old}`], { stdio: 'ignore' })
    for (let i = 0; i < 20 && loaded(old); i++) await sleep(250)
    if (existsSync(oldPlist)) unlinkSync(oldPlist)
    console.log(`Retired the old service (${old}).`)
  }
  const moved = migrateHome()
  if (moved) console.log(`Moved ${moved} to ${HOME} (the old path still works).`)

  mkdirSync(LOGS, { recursive: true })
  mkdirSync(dirname(PLIST), { recursive: true })

  // Only configuration travels into the plist. Secrets do not: the file sits
  // in ~/Library/LaunchAgents, readable by anything running as you. The
  // ElevenLabs key is picked up from ~/.claude.json, as it is for the bridge.
  const env = {
    PATH: [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: homedir(),
    JETT_SERVICE: '1',
    JETT_STAY_AWAKE: process.argv.includes('--no-stay-awake') ? '0' : '1',
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(JETT|EMRYS|JARVIS)_/.test(key) && !(key in env) && value) env[key] = value
  }

  writeFileSync(PLIST, plist({
    Label: LABEL,
    ProgramArguments: [process.execPath, join(ROOT, 'bridge', 'server.mjs')],
    WorkingDirectory: ROOT,
    EnvironmentVariables: env,
    RunAtLoad: true,
    KeepAlive: true,
    // A crash loop — the port taken, a syntax error mid-edit — retries every
    // ten seconds rather than as fast as launchd can spawn.
    ThrottleInterval: 10,
    StandardOutPath: OUT_LOG,
    StandardErrorPath: ERR_LOG,
  }))

  // Replace rather than stack: bootout whatever was loaded before, quietly.
  //
  // bootout returns before the old process has gone, and bootstrapping over a
  // service that is still on its way out fails with "5: Input/output error" —
  // which is exactly what a reinstall, the way to pick up an update, does. So
  // wait for launchd to forget it, and give bootstrap a few tries besides.
  spawnSync('launchctl', ['bootout', `${DOMAIN}/${LABEL}`], { stdio: 'ignore' })
  for (let i = 0; i < 20 && loaded(LABEL); i++) await sleep(250)
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('launchctl', ['bootstrap', DOMAIN, PLIST], { stdio: 'pipe' })
      break
    } catch (err) {
      if (attempt < 5) {
        await sleep(1000)
        continue
      }
      console.error(`launchctl refused the service: ${String(err.stderr || err.message).trim()}`)
      process.exit(1)
    }
  }

  process.stdout.write('Starting the always-on core')
  for (let i = 0; i < 30; i++) {
    const h = await probe('/health')
    if (h?.service) {
      console.log(' — running.')
      await installApp()
      console.log('')
      return status()
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`\nIt did not come up. The reason will be in ${ERR_LOG}:`)
  printTail(ERR_LOG, 20)
  process.exit(1)
}

/**
 * Jett, the Mac app: his window, his dot in the menu bar, and ⌥ to talk from
 * any app. Optional — the core also serves the same interface to a browser at
 * http://localhost:4180 — so a failure here is reported and the install
 * carries on.
 */
async function installApp() {
  if (process.argv.includes('--no-app') || process.argv.includes('--no-helper')) return
  try {
    process.stdout.write('Mac app… ')
    const retired = retireLegacy()
    const rebuilt = buildApp()
    await startApp(plist)
    console.log(rebuilt ? `built and running (${APP}).` : 'running.')
    if (retired.length) console.log(`  Replaced ${retired.join(' and ')} — the app carries the ⌥ key itself now.`)
    if (rebuilt) {
      console.log(
        '  First run: allow the microphone and speech recognition when macOS asks. Nothing\n' +
          '  else is needed — hold ⌥ Option on its own, in any app, and talk.',
      )
    }
    if (!process.argv.includes('--quiet')) openApp()
  } catch (err) {
    console.log(`not installed — ${err.message}`)
  }
}

async function uninstall() {
  removeApp()
  const out = spawnSync('launchctl', ['bootout', `${DOMAIN}/${LABEL}`], { encoding: 'utf8' })
  const removed = existsSync(PLIST)
  if (removed) unlinkSync(PLIST)
  console.log(
    out.status === 0 || removed
      ? `The always-on core is stopped and will not start at login. ${HOME} is untouched.`
      : 'The always-on core was not installed.',
  )
}

/**
 * Stop the core and let launchd start it again, on the code now on disk.
 *
 * Not while a job is running, unless forced: a briefing cut off half-way is
 * worse than a restart a minute later.
 */
async function restart() {
  const label = [LABEL, ...LEGACY_LABELS].find((l) => loaded(l))
  if (!label) {
    console.log('The always-on core is not installed, so there is nothing to restart. `npm run service:install` starts it.')
    process.exit(1)
  }
  const before = await probe('/status')
  const busy = (before?.jobs ?? []).filter((job) => job.running).map((job) => job.name)
  if (busy.length && !process.argv.includes('--force')) {
    console.log(`A job is running (${busy.join(', ')}). Try again in a minute, or add --force to cut it short.`)
    process.exit(1)
  }
  spawnSync('launchctl', ['kickstart', '-k', `${DOMAIN}/${label}`], { stdio: 'ignore' })
  for (let i = 0; i < 120; i++) {
    await sleep(250)
    const now = await probe('/status')
    if (now?.ok && now.started !== before?.started) {
      console.log('The core has restarted.')
      return
    }
  }
  console.log('The core did not come back within 30 seconds. `npm run service:logs` shows why.')
  process.exit(1)
}

async function status() {
  const listed = spawnSync('launchctl', ['print', `${DOMAIN}/${LABEL}`], { encoding: 'utf8' })
  if (listed.status !== 0) {
    console.log('Service: not installed. `npm run service:install` to start it.')
  } else {
    const state = listed.stdout.match(/^\s*state = (.+)$/m)?.[1] ?? 'unknown'
    const pid = listed.stdout.match(/^\s*pid = (\d+)$/m)?.[1]
    const lastExit = listed.stdout.match(/^\s*last exit code = (.+)$/m)?.[1]
    console.log(`Service: ${state}${pid ? ` (pid ${pid})` : ''}${lastExit && lastExit !== '(never exited)' ? ` · last exit ${lastExit}` : ''}`)
  }

  const s = await probe('/status')
  if (!s) {
    console.log(`Bridge:  not answering on port ${PORT}.`)
    return
  }
  console.log(`Bridge:  answering on port ${PORT}${s.service ? '' : ' (from a terminal, not the service)'}`)
  console.log(`App:     ${s.app ?? 'not built — `npm run service:install` builds it'}`)
  console.log(`Models:  voice ${s.models.voice.model} · deep ${s.models.deep.model} · fast ${s.models.fast.model}`)
  console.log(`Memory:  ${s.home}`)
  const h = s.helper
  console.log(
    `Mac app: ${
      !h?.connected
        ? appRunning() ? 'running, not connected yet' : 'not running — open Jett from Launchpad, or `npm run service:install`'
        : h.ready ? 'ready — ⌥ works from any app' : `running, waiting on ${h.missing.join(', ')}`
    }`,
  )
  if (s.brain) {
    console.log(
      `Brain:   ${s.brain.items} items, ${s.brain.digested} summarised` +
        (s.brain.pending ? `, ${s.brain.pending} to go` : '') +
        ` · ${s.brain.sources.map((x) => `${x.name} ${x.items}`).join(', ')}`,
    )
  }
  if (s.voice) console.log(`Voice:   ${s.voice.ready ? `natural (${s.voice.default})` : `browser fallback${s.voice.failed ? ` — ${s.voice.failed}` : ' — loading'}`}`)
  for (const job of s.jobs) {
    const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never')
    console.log(
      `Job:     ${job.name} — ${job.enabled ? `next ${when(job.nextRun)}` : 'paused'}` +
        ` · last ${when(job.lastRun)}${job.lastStatus ? ` (${job.lastStatus})` : ''}` +
        (job.running ? ' · running now' : ''),
    )
  }
  if (s.unread.length) console.log(`Unread:  ${s.unread.map((u) => u.title).join(', ')}`)
}

async function logs() {
  if (process.argv.includes('--follow')) {
    spawn('tail', ['-n', '40', '-F', OUT_LOG, ERR_LOG], { stdio: 'inherit' })
    return
  }
  console.log(`── ${OUT_LOG}`)
  printTail(OUT_LOG, 40)
  console.log(`── ${ERR_LOG}`)
  printTail(ERR_LOG, 20)
}

// ---------------------------------------------------------------------------

/**
 * Build the face the core serves at http://localhost:4180, so the app icon
 * opens what this folder holds today. Run on every install — which is also
 * how an update is picked up.
 *
 * The hand-tracking runtime is copied out of node_modules first, as
 * `npm start` does, because the build only takes what is in public/.
 */
function buildInterface() {
  const wasmFrom = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
  const wasmTo = join(ROOT, 'public', 'mediapipe')
  if (existsSync(wasmFrom) && !existsSync(join(wasmTo, 'vision_wasm_internal.wasm'))) {
    cpSync(wasmFrom, wasmTo, { recursive: true })
  }

  process.stdout.write('Building the interface… ')
  const built = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (built.status !== 0) {
    console.error(`failed.\n${built.stderr || built.stdout}`)
    process.exit(1)
  }
  console.log('done.')
}

// Declarations rather than consts: the command at the top runs before the
// module body below it has been evaluated.
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Whether launchd still knows a service. */
function loaded(label = LABEL) {
  return spawnSync('launchctl', ['print', `${DOMAIN}/${label}`], { stdio: 'ignore' }).status === 0
}

async function probe(path) {
  try {
    const res = await fetch(`http://localhost:${PORT}${path}`, { signal: AbortSignal.timeout(1500) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

function printTail(file, lines) {
  try {
    console.log(readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n') || '(empty)')
  } catch {
    console.log('(no log yet)')
  }
}

/** A property list from a plain object: strings, booleans, numbers, arrays, dicts. */
function plist(obj) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const value = (v, pad) => {
    if (typeof v === 'boolean') return `${pad}<${v}/>`
    if (typeof v === 'number') return `${pad}<integer>${v}</integer>`
    if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => value(x, pad + '  ')).join('\n')}\n${pad}</array>`
    if (v && typeof v === 'object') {
      const body = Object.entries(v)
        .map(([k, x]) => `${pad}  <key>${esc(k)}</key>\n${value(x, pad + '  ')}`)
        .join('\n')
      return `${pad}<dict>\n${body}\n${pad}</dict>`
    }
    return `${pad}<string>${esc(v)}</string>`
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n${value(obj, '')}\n</plist>\n`
  )
}
