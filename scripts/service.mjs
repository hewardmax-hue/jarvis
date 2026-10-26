/**
 * The always-on core: the bridge as a macOS launchd agent.
 *
 *   npm run service:install     build the interface, start it now and at every login
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

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'com.jarvis.core'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const HOME = process.env.JARVIS_HOME ?? join(homedir(), '.jarvis')
const LOGS = join(HOME, 'logs')
const OUT_LOG = join(LOGS, 'core.log')
const ERR_LOG = join(LOGS, 'core.err.log')
const DOMAIN = `gui/${userInfo().uid}`
const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

const command = process.argv[2]

if (process.platform !== 'darwin') {
  console.error('The always-on service uses launchd, so it is macOS only. Run `npm run bridge` under your own process manager instead.')
  process.exit(1)
}

const actions = { install, uninstall, status, logs }
if (!actions[command]) {
  console.error('Usage: node scripts/service.mjs install | uninstall | status | logs [--follow]')
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

  mkdirSync(LOGS, { recursive: true })
  mkdirSync(dirname(PLIST), { recursive: true })

  buildInterface()

  // Only configuration travels into the plist. Secrets do not: the file sits
  // in ~/Library/LaunchAgents, readable by anything running as you. The
  // ElevenLabs key is picked up from ~/.claude.json, as it is for the bridge.
  const env = {
    PATH: [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: homedir(),
    JARVIS_SERVICE: '1',
    JARVIS_STAY_AWAKE: process.argv.includes('--no-stay-awake') ? '0' : '1',
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('JARVIS_') && !(key in env) && value) env[key] = value
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
  for (let i = 0; i < 20 && loaded(); i++) await sleep(250)
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
      console.log(' — running.\n')
      return status()
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`\nIt did not come up. The reason will be in ${ERR_LOG}:`)
  printTail(ERR_LOG, 20)
  process.exit(1)
}

async function uninstall() {
  const out = spawnSync('launchctl', ['bootout', `${DOMAIN}/${LABEL}`], { encoding: 'utf8' })
  const removed = existsSync(PLIST)
  if (removed) unlinkSync(PLIST)
  console.log(
    out.status === 0 || removed
      ? 'The always-on core is stopped and will not start at login. ~/.jarvis is untouched.'
      : 'The always-on core was not installed.',
  )
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

/** Whether launchd still knows the service. */
function loaded() {
  return spawnSync('launchctl', ['print', `${DOMAIN}/${LABEL}`], { stdio: 'ignore' }).status === 0
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
