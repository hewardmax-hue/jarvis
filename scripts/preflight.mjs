/**
 * Preflight: every live chain in Jett, run for real, with a verdict.
 *
 *   npm run preflight
 *
 * Not unit tests and not mocks. It talks to the Jett that is running: the core
 * on :8787 and the app it serves on :4180, the models behind them, the voice,
 * the Mac app's ears, the second brain and the workshop's sealed stage. Each
 * check prints a tick, a cross or a warning; a cross comes with the command
 * that fixes it, and any cross makes the exit code non-zero. A missing voice,
 * missing ears and a missing local brain are warnings: Jett works without them.
 *
 * It is careful with what is yours. Its questions go over a quiet connection
 * (`?check=1`) that is not a window: nothing reaches the conversation log, the
 * conversation you left is not picked up, and it cannot change the model, the
 * brain, the schedule or the bench. The one note it writes it removes again.
 * The browser it opens is a headless Chrome on a throwaway profile, not yours.
 * The questions are real ones to real models, so a run spends a little usage.
 *
 * Every check is here because the design promises it or because it broke once.
 * When something breaks that preflight did not catch, its check goes at the
 * bottom of the list.
 */

import '../bridge/env.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import http from 'node:http'
import { homedir, tmpdir, totalmem, userInfo } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.JETT_PORT ?? process.env.JETT_BRIDGE_PORT ?? 8787)
const APP_PORT = Number(process.env.JETT_APP_PORT ?? 4180)
const CORE = `http://localhost:${PORT}`
const APP = `http://localhost:${APP_PORT}`
/** An origin Jett has never heard of, for the doors that must stay shut. */
const STRANGER = 'https://example.com'
const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]
/** Spoken and then heard back. Plain words: no numbers, no names, nothing spelt two ways. */
const SENTENCE = 'Please remember to water the garden before breakfast tomorrow morning.'

// ---------------------------------------------------------------------------
// The verdict

const colour = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, text) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text)
const MARKS = { pass: paint(32, '✓'), fail: paint(31, '✗'), warn: paint(33, '!'), skip: paint(2, '–') }
const tally = { pass: 0, fail: 0, warn: 0 }
/** Measured in this run, in seconds. Null is a part that could not be measured. */
const budget = { hear: null, think: null, speak: null }
const spent = { usd: 0 }

/** Something Jett works without, or a check that could not be made. Counted, but not a failure. */
class Warn extends Error {
  constructor(message, fix = '') {
    super(message)
    this.fix = fix
  }
}

/** A check that does not apply here. Printed, not counted. */
class Skip extends Error {}

/** A failure that knows its own fix. */
const broken = (message, fix) => Object.assign(new Error(message), { fix })

/** Run one check and print its line. `run` returns the detail, or throws. */
async function check(name, run) {
  let kind = 'pass'
  let detail = ''
  let fix = ''
  try {
    detail = (await run()) ?? ''
  } catch (err) {
    kind = err instanceof Warn ? 'warn' : err instanceof Skip ? 'skip' : 'fail'
    detail = String(err?.message ?? err)
    fix = err?.fix ?? ''
  }
  if (kind !== 'skip') tally[kind]++
  const quiet = kind === 'pass' || kind === 'skip'
  console.log(`${MARKS[kind]} ${name}${detail ? (quiet ? paint(2, ` — ${detail}`) : ` — ${detail}`) : ''}`)
  if (fix) console.log(`    ${fix}`)
}

/** The two closing lines, and the exit code. */
function finish() {
  const part = (n) => (n === null ? 'n/a' : secs(n))
  const known = Object.values(budget).filter((n) => n !== null)
  const total = known.length ? secs(known.reduce((a, b) => a + b, 0)) : 'n/a'
  const partial = known.length && known.length < 3 ? ' for the parts measured' : ''
  console.log()
  if (spent.usd) console.log(paint(2, `The questions in this run cost about $${spent.usd.toFixed(2)} of Claude usage.`))
  console.log(`LATENCY BUDGET: hear ${part(budget.hear)}, think ${part(budget.think)}, speak ${part(budget.speak)}, total ${total}${partial}`)
  console.log(`${tally.pass} pass, ${tally.fail} fail, ${tally.warn} warn`)
  process.exit(tally.fail ? 1 : 0)
}

/** What must be undone however the run ends. */
const undo = []
async function tidy() {
  for (const job of undo.splice(0).reverse()) await job().catch(() => {})
}
process.on('SIGINT', () => tidy().finally(() => process.exit(130)))

// ---------------------------------------------------------------------------
// Small things

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const secs = (n) => `${n.toFixed(n < 10 ? 1 : 0)} s`
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (res) => JSON.parse(res.body.toString('utf8'))
const tilde = (path) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)
const words = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

function clip(text, n = 70) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

function ago(at) {
  const m = Math.round((Date.now() - at) / 60_000)
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

/** The local model the size of this Mac's memory suits. */
function modelForThisMac() {
  const gb = totalmem() / 2 ** 30
  return gb >= 24 ? 'gemma4:12b' : gb >= 16 ? 'qwen3.5:9b' : 'gemma2:2b'
}

/**
 * One HTTP request, exactly as written.
 *
 * Raw on purpose: the Origin header is set or left out by the caller, and the
 * path goes out untouched — `fetch` would tidy `/../` away before it was sent,
 * and those are the requests the security checks exist to make.
 */
function request(base, path, { method = 'GET', origin, headers = {}, body, timeout = 15_000 } = {}) {
  const at = new URL(base)
  return new Promise((done, failed) => {
    const began = performance.now()
    let first = 0
    const req = http.request(
      { host: at.hostname, port: at.port, path, method, timeout, headers: { ...(origin ? { origin } : {}), ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => {
          first ||= performance.now() - began
          chunks.push(chunk)
        })
        res.on('error', failed)
        res.on('end', () => {
          const total = performance.now() - began
          done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), first: (first || total) / 1000, total: total / 1000 })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeout / 1000} s`)))
    req.on('error', failed)
    req.end(body)
  })
}

/** Every file under a folder, as full paths. Hidden files and the folders named in `skip` are left out. */
function walk(dir, skip = []) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skip.includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, skip))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** The file changed most recently among these, and when. */
function newest(paths) {
  let best = { path: '', at: 0 }
  for (const path of paths) {
    const at = statSync(path).mtimeMs
    if (at > best.at) best = { path, at }
  }
  return best
}

const listing = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : [])

/** How long a WAV runs and how loud it is (0 to 1), or a throw if it is not one. */
function readWav(bytes) {
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('what came back is not a WAV file')
  }
  let fmt = null
  let data = null
  for (let at = 12; at + 8 <= bytes.length && !data; ) {
    const id = bytes.toString('latin1', at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    if (id === 'fmt ') {
      fmt = { float: bytes.readUInt16LE(at + 8) === 3, channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) }
    }
    // A streamed WAV may not know its own length; what is left is the sound.
    if (id === 'data') data = bytes.subarray(at + 8, size && at + 8 + size <= bytes.length ? at + 8 + size : bytes.length)
    at += 8 + size + (size % 2)
  }
  if (!fmt || !data || !fmt.rate || !fmt.channels) throw new Error('the WAV that came back has no sound in it')
  const width = fmt.bits / 8
  const sample = fmt.float
    ? (i) => data.readFloatLE(i)
    : width === 1
      ? (i) => (data[i] - 128) / 128
      : (i) => data.readIntLE(i, width) / 2 ** (fmt.bits - 1)
  const stride = width * fmt.channels
  const frames = Math.floor(data.length / stride)
  let sum = 0
  for (let f = 0; f < frames; f++) sum += sample(f * stride) ** 2
  return { seconds: frames / fmt.rate, level: Math.sqrt(sum / Math.max(1, frames)) }
}

// ---------------------------------------------------------------------------
// A quiet connection to the core

/**
 * Open a quiet connection, the way the app opens its own but marked `?check=1`.
 *
 * Every frame is kept from the first, so a `wait` finds one that arrived before
 * anyone was waiting for it.
 */
function openCore(origin = APP) {
  return new Promise((done, failed) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?check=1`, { origin })
    const seen = []
    const listeners = new Set()
    const core = {
      seen,
      send: (msg) => ws.send(JSON.stringify(msg)),
      close: () => ws.close(),
      listen(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      /** The first frame `accept` takes, whether it is already here or still to come. */
      wait(accept, ms, what) {
        const had = seen.find(accept)
        if (had) return Promise.resolve(had)
        return new Promise((got, late) => {
          const timer = setTimeout(() => {
            stop()
            late(new Error(`${what} did not come within ${Math.round(ms / 1000)} s`))
          }, ms)
          const stop = core.listen((msg) => {
            if (!accept(msg)) return
            clearTimeout(timer)
            stop()
            got(msg)
          })
        })
      },
      /** One of the core's own checks, by name. */
      check(op, extra = {}, ms = 30_000) {
        const id = randomBytes(4).toString('hex')
        core.send({ type: 'check', id, op, ...extra })
        return core.wait((msg) => msg.type === 'check_reply' && msg.id === id, ms, `the core's answer to its "${op}" check`)
      },
    }
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      seen.push(msg)
      for (const fn of [...listeners]) fn(msg)
    })
    ws.on('unexpected-response', (_req, res) => failed(new Error(`the core refused the connection (${res.statusCode})`)))
    ws.on('error', failed)
    ws.on('open', () => done(core))
  })
}

/** Ask a question the way the app does, and time the answer. */
function ask(core, text, ms = 90_000) {
  const id = `pf-${randomBytes(4).toString('hex')}`
  return new Promise((done, failed) => {
    const began = performance.now()
    const since = () => (performance.now() - began) / 1000
    const out = { text: '', hits: [], first: 0, total: 0, cost: 0 }
    const end = (settle, value) => {
      clearTimeout(timer)
      stop()
      settle(value)
    }
    const timer = setTimeout(() => end(failed, new Error(`no answer within ${ms / 1000} s`)), ms)
    const stop = core.listen((msg) => {
      if (msg.type === 'error') return end(failed, new Error(`the core answered with an error: ${clip(msg.message, 160)}`))
      if (msg.ask !== id) return
      if (msg.type === 'recall') out.hits = msg.hits ?? []
      else if (msg.type === 'text') out.first ||= since()
      else if (msg.type === 'done') {
        out.total = since()
        out.first ||= out.total
        out.text = msg.text ?? ''
        out.cost = msg.costUsd ?? 0
        end(done, out)
      }
    })
    core.send({ type: 'ask', text, id })
  })
}

async function benchState(core) {
  const id = randomBytes(4).toString('hex')
  core.send({ type: 'workshop', op: 'state', id })
  const got = await core.wait((msg) => msg.type === 'workshop_reply' && msg.id === id, 10_000, 'the bench')
  return { open: Boolean(got.ok), title: got.title ?? '' }
}

// ---------------------------------------------------------------------------
// A browser of its own

/**
 * Start a headless Chrome on a throwaway profile and drive it over its
 * debugging socket. Nothing of the user's own browser is opened or read.
 */
async function openBrowser(binary) {
  const profile = mkdtempSync(join(tmpdir(), 'jett-preflight-'))
  const child = spawn(
    binary,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  let socket = null
  const close = async () => {
    try {
      socket?.close()
    } catch {}
    if (child.exitCode === null) {
      const gone = new Promise((done) => child.once('exit', done))
      child.kill()
      await Promise.race([gone, sleep(3000)])
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100)
    if (!existsSync(portFile)) throw new Error('the browser did not start')
    const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n')
    socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    await new Promise((done, failed) => {
      socket.once('open', done)
      socket.once('error', failed)
    })
  } catch (err) {
    await close()
    throw err
  }

  let n = 0
  const waiting = new Map()
  socket.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    const call = waiting.get(msg.id)
    if (!call) return
    waiting.delete(msg.id)
    if (msg.error) call.failed(new Error(msg.error.message))
    else call.done(msg.result)
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((done, failed) => {
      const id = ++n
      waiting.set(id, { done, failed })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })

  /** Open a page. `before` is script that runs ahead of the page's own. */
  async function tab(url, before = '') {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('Runtime.enable', {}, sessionId)
    if (before) await send('Page.addScriptToEvaluateOnNewDocument', { source: before }, sessionId)
    await send('Page.navigate', { url }, sessionId)
    const run = async (expression) => {
      const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text)
      return out.result.value
    }
    const until = async (expression, ms, what) => {
      const end = Date.now() + ms
      // A page that is still loading throws; that is a no, not an error.
      while (!(await run(expression).catch(() => false))) {
        if (Date.now() > end) throw new Error(`gave up waiting for ${what}`)
        await sleep(200)
      }
    }
    return { run, until }
  }

  return { tab, close }
}

/**
 * Counts every way the app can make a sound, from before its first line runs,
 * and notes where it opens its line to the core.
 */
const SOUND_COUNTERS = `(() => {
  const made = (window.__preflightSound = { speech: 0, played: 0, browserVoice: 0, cues: 0 })
  const lines = (window.__preflightLines = [])
  window.__preflightSpent = 0
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(target, args) {
      lines.push(String(args[0]))
      const line = new target(...args)
      line.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'done' && typeof msg.costUsd === 'number') window.__preflightSpent += msg.costUsd
        } catch {}
      })
      return line
    },
  })
  const fetched = window.fetch
  window.fetch = function (input) {
    try {
      if (/\\/(?:speak|tts)(?:[?#]|$)/.test(String(input?.url ?? input))) made.speech++
    } catch {}
    return fetched.apply(this, arguments)
  }
  const count = (proto, name, key) => {
    if (!proto || !Object.hasOwn(proto, name)) return
    const real = proto[name]
    proto[name] = function () {
      made[key]++
      return real.apply(this, arguments)
    }
  }
  count(window.HTMLMediaElement?.prototype, 'play', 'played')
  count(window.SpeechSynthesis?.prototype, 'speak', 'browserVoice')
  count(window.AudioScheduledSourceNode?.prototype, 'start', 'cues')
  count(window.AudioBufferSourceNode?.prototype, 'start', 'cues')
})()`

/** Type a line into the app's message box and send it. */
const typed = (line) => `(() => {
  const box = document.querySelector('.convo textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(line)})
  box.dispatchEvent(new Event('input', { bubbles: true }))
  box.form.requestSubmit()
})()`

/**
 * Mount the workshop's stage the way the app does, run one hand-written part
 * in it, then have the stage try every way out and say what happened.
 */
const stageTrial = (src) => `new Promise((done) => {
  const out = { ready: false, pong: false, ran: null, seal: null, trouble: [] }
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;border:0;z-index:99999'
  const post = (msg) => frame.contentWindow.postMessage(msg, '*')
  const hear = (event) => {
    const msg = event.data
    if (event.source !== frame.contentWindow || msg?.from !== 'jett-stage') return
    if (msg.type === 'ready') {
      out.ready = true
      post({ op: 'ping' })
    } else if (msg.type === 'pong') {
      out.pong = true
      post({ op: 'part', name: 'preflight', code: 'W.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()))' })
    } else if (msg.type === 'ran') {
      out.ran = msg
      post({ op: 'probe' })
    } else if (msg.type === 'seal') {
      out.seal = msg
      end()
    } else if (['fault', 'refused', 'lost'].includes(msg.type)) {
      out.trouble.push(msg.type + (msg.message ? ': ' + msg.message : ''))
    }
  }
  const end = () => {
    clearTimeout(timer)
    removeEventListener('message', hear)
    frame.remove()
    done(out)
  }
  const timer = setTimeout(end, 30000)
  addEventListener('message', hear)
  frame.src = ${JSON.stringify(src)}
  document.body.appendChild(frame)
})`

// ---------------------------------------------------------------------------
// The checks

/** Why the ears could not be tried, and what would change that. Any other reason is a failure. */
const EARS = [
  [/not running/, 'Jett.app is the ears. `npm run service:install` builds it and opens it at every login.'],
  [/older one/, '`npm run service:install` rebuilds Jett.app with this in it.'],
  [/not allowed yet/, 'Allow Jett under System Settings › Privacy & Security › Speech Recognition, then run this again.'],
  [/no recogniser/, 'macOS has no speech recogniser to offer just now. It usually needs a network connection.'],
]
const MODEL_ENV = { fast: 'JETT_MODEL_FAST', voice: 'JETT_MODEL', deep: 'JETT_MODEL_DEEP' }
const SOUNDS = {
  speech: 'asked the core for speech',
  played: 'played audio',
  browserVoice: "used the browser's own voice",
  cues: 'played an interface cue',
}

/** A quiet connection, or a throw: preflight asks nothing over a line that is not one. */
async function quietLine() {
  const core = await openCore()
  const hello = await core.wait((msg) => msg.type === 'ready', 10_000, "the core's greeting")
  if (!hello.quiet) {
    core.close()
    throw broken('the core opened an ordinary window where a quiet line was asked for', '`npm run service:restart` puts it on the code that is on disk.')
  }
  core.hello = hello
  return core
}

/** Whether a WebSocket to the core opens at all. */
function opens(path, origin) {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://localhost:${PORT}${path}`, origin ? { origin } : {})
    ws.on('open', () => {
      ws.close()
      done(true)
    })
    ws.on('unexpected-response', () => done(false))
    ws.on('error', () => done(false))
  })
}

async function main() {
  console.log(`Jett preflight, ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`)
  console.log()

  let health = null
  let status = null
  let C = null
  let Q = null

  await check('The core is up', async () => {
    try {
      health = json(await request(CORE, '/health'))
      status = json(await request(CORE, '/status'))
    } catch {
      throw broken(`nothing is answering on port ${PORT}`, '`npm run service:install` keeps it running from login. `npm start` runs it for now.')
    }
    if (!status.started) {
      throw broken('it is running code from before preflight existed', '`npm run service:restart` puts it on the code that is on disk.')
    }
    // Two lines: one writes the test note, the other is asked about it. A note
    // is also handed to the next question on the line that wrote it, which
    // would let the recall check pass without anything being recalled.
    C = await quietLine()
    Q = await quietLine()
    undo.push(async () => {
      C.close()
      Q.close()
    })
    return `port ${PORT}, started ${ago(Date.parse(status.started))}${status.service ? ', kept running by launchd' : ''}`
  })
  if (!Q) {
    await tidy()
    return finish()
  }

  const home = status.home
  const notes = join(home, 'notes')
  const before = {
    notes: listing(notes),
    builds: listing(join(home, 'builds')),
    bench: await benchState(C).catch(() => null),
  }
  const shelf = await C.wait((msg) => msg.type === 'brain_state', 5000, 'which brain is in use').catch(() => null)
  const local = shelf?.mode === 'local'
  const tier = C.hello.tier
  let settings = {}
  try {
    settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
  } catch {}

  let served = false
  await check('The app is being served', async () => {
    const fix = '`npm run build`, then `npm run service:restart`: the core serves the app once it is built.'
    const page = await request(APP, '/').catch(() => null)
    if (!page) throw broken(`nothing is answering on port ${APP_PORT}`, fix)
    if (page.status !== 200 || !/<title>[^<]*Jett/i.test(page.body.toString('utf8'))) {
      throw broken(`port ${APP_PORT} answered, but not with Jett`, fix)
    }
    served = true
    return APP
  })

  await check('The second brain loads', async () => {
    const graph = json(await request(CORE, '/brain/graph', { origin: APP }))
    const state = json(await request(CORE, '/brain/status', { origin: APP }))
    if (!graph.nodes?.length) throw broken('its map came back empty', `Notes live in ${tilde(notes)}.`)
    const size = `${graph.nodes.length} nodes, ${graph.links?.length ?? 0} links`
    if (state.lastError) throw new Warn(`${size}, but its last scan reported: ${clip(state.lastError, 120)}`)
    return `${size}${state.pending ? `, ${state.pending} still to be digested` : ''}`
  })

  await check('The local brain', async () => {
    const got = await C.check('local')
    if (got.error) throw new Error(got.error)
    const wanted = process.env.JETT_LOCAL_MODEL || settings.localModel || ''
    const pull = `ollama pull ${modelForThisMac()}`
    if (got.ok) return `${got.model} is installed${local ? ' and doing the thinking' : '; Claude is doing the thinking'}`
    if (got.reason === 'missing-model' && wanted) {
      throw broken(`the model named in your settings, ${wanted}, is not in Ollama`, `ollama pull ${wanted}`)
    }
    if (local) throw broken('Jett is set to think locally, and there is no local brain to think with', 'Start Ollama, or tell Jett "go cloud".')
    if (got.reason === 'not-running') {
      throw new Warn('none on this Mac, so Jett thinks with Claude', `Optional. Install Ollama from ollama.com, then: ${pull}`)
    }
    throw new Warn('Ollama is running, but has no model for conversation', pull)
  })

  let proven = ''
  await check('Jett answers a real question', async () => {
    // The agent takes a few seconds to start on a new line. That is start-up,
    // not thinking, so it is waited out before the clock starts.
    await Q.wait((msg) => msg.type === 'ready' && !('tier' in msg), 25_000, 'the agent').catch(() => {})
    const got = await ask(Q, 'Reply in one short sentence: what is seven plus five?')
    spent.usd += got.cost
    if (!/\b12\b|twelve/i.test(got.text)) throw new Error(`asked what seven plus five is, it said "${clip(got.text)}"`)
    budget.think = got.first
    if (!local) proven = tier
    const model = local ? shelf.model : (status.models?.[tier]?.model ?? tier)
    return `"${clip(got.text, 40)}" from ${model}, first word in ${secs(got.first)}, all of it in ${secs(got.total)}`
  })

  // Every model Jett can reach for, each asked for one word. The one that has
  // just answered a real question has nothing left to prove.
  const which = ['fast', 'voice', 'deep', 'build'].filter((w) => w !== proven)
  const replies = await Promise.all(
    which.map((w) => C.check('model', { which: w }, 120_000).catch((err) => ({ ok: false, error: err.message }))),
  )
  for (const [i, w] of which.entries()) {
    const got = replies[i]
    const name = w === 'build' ? 'The workshop builder answers' : `The ${status.models?.[w]?.label ?? w} model answers`
    await check(name, () => {
      spent.usd += got.cost ?? 0
      const id = got.model ?? status.models?.[w]?.model ?? 'the model'
      if (got.ok) return `${id}, ${secs(got.seconds)}`
      const fix =
        w === 'build'
          ? `"buildModel" in ${tilde(join(home, 'settings.json'))} names it. Empty means the default. Then \`npm run service:restart\`.`
          : `${MODEL_ENV[w]} names it, if you have set one. Otherwise check that \`claude\` is signed in.`
      throw broken(`${id} did not answer: ${clip(got.error || `it said "${got.said}"`, 140)}`, fix)
    })
  }

  const voice = health.voice ?? {}
  const speak = (text) =>
    request(CORE, '/speak', {
      method: 'POST',
      origin: APP,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      timeout: 60_000,
    })

  await check('The voice speaks', async () => {
    if (!voice.ready) {
      if (voice.failed) throw new Warn(`it did not load: ${clip(voice.failed, 120)}`, '`npm run service:logs` shows why. Jett answers in text meanwhile.')
      throw new Warn('it is still loading. Jett answers in text until it has')
    }
    // A sentence it has not said before, so the answer is made now and not remembered.
    const res = await speak(`Preflight voice check, number ${1000 + Math.floor(Math.random() * 9000)}.`)
    if (res.status === 503) throw new Warn('it is not ready. Jett answers in text until it is')
    if (res.status !== 200) throw new Error(`asked to speak, the core answered ${res.status}`)
    const wav = readWav(res.body)
    if (wav.seconds < 0.5) throw new Error(`what came back is only ${wav.seconds.toFixed(2)} s long`)
    if (wav.level < 0.003) throw new Error(`${secs(wav.seconds)} came back, and all of it is silence`)
    budget.speak = res.first
    const name = voice.voices?.find((v) => v.id === voice.default)?.label ?? voice.default
    return `${voice.engine}, ${name}: ${secs(wav.seconds)} of sound, first byte in ${secs(res.first)}`
  })

  await check('The loop: spoken, heard, the same words back', async () => {
    let got = await C.check('loop', { text: SENTENCE }, 60_000)
    if (!got.ok && health.stt && voice.ready) {
      // No ears on this Mac, but there are ears in the cloud: use those.
      try {
        const said = await speak(SENTENCE)
        const began = performance.now()
        const heard = await request(CORE, '/stt', { method: 'POST', origin: APP, headers: { 'content-type': 'audio/wav' }, body: said.body, timeout: 60_000 })
        if (said.status === 200 && heard.status === 200) got = { ok: true, heard: json(heard).text ?? '', hear: (performance.now() - began) / 1000 }
      } catch {}
    }
    if (!got.ok) {
      const why = got.why || got.error || 'no reason given'
      const hint = EARS.find(([shape]) => shape.test(why))
      if (hint) throw new Warn(`not tested: ${why}`, hint[1])
      if (!voice.ready) throw new Warn('not tested: there is no voice to do the speaking')
      throw new Error(`a sentence was spoken and the ears could not take it down: ${why}`)
    }
    const want = words(SENTENCE)
    const have = new Set(words(got.heard))
    const back = want.filter((word) => have.has(word)).length
    if (back / want.length < 0.8) throw new Error(`said "${SENTENCE}" and heard "${clip(got.heard, 100)}"`)
    budget.hear = got.hear
    return `${back} of ${want.length} words came back, heard in ${secs(got.hear)}`
  })

  // One word no note of yours contains, so a search for it finds this note or nothing.
  const token = `zorvex${randomBytes(3).toString('hex')}`
  let noteFile = ''
  let nodeId = ''
  const search = async () => json(await request(CORE, `/brain/search?q=${token}`, { origin: APP })).hits ?? []

  /**
   * Take the test note out again, and out of the brain's index. Only ever a
   * file inside the notes folder with this run's word in it.
   */
  async function forget() {
    if (!existsSync(notes)) return
    const root = realpathSync(notes)
    const files = new Set(noteFile ? [noteFile] : [])
    // In case the note was written and the answer saying where never arrived.
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name.startsWith('.')) continue
      for (const name of readdirSync(join(root, dir.name))) {
        if (name.startsWith('preflight-check-')) files.add(join(root, dir.name, name))
      }
    }
    let removed = false
    for (const file of files) {
      if (!existsSync(file)) continue
      const real = realpathSync(file)
      if (!real.startsWith(root + sep) || !readFileSync(real, 'utf8').includes(token)) continue
      unlinkSync(real)
      removed = true
      // The folder goes too, if this run made it and nothing else is in it.
      const dir = dirname(real)
      if (dirname(dir) === root && !before.notes.includes(basename(dir)) && !readdirSync(dir).length) rmdirSync(dir)
    }
    if (!removed) return
    await request(CORE, '/brain/rescan', { method: 'POST', origin: APP }).catch(() => {})
    for (let i = 0; i < 30 && (await search().catch(() => [])).length; i++) await sleep(500)
  }
  undo.push(forget)

  await check('A note is remembered at once, then removed', async () => {
    const id = randomBytes(4).toString('hex')
    const text = `Preflight check ${token}: the harbour light is amber.`
    C.send({ type: 'capture', id, kind: 'note', text, said: `note to self, ${text}` })
    const made = await C.wait((msg) => msg.type === 'captured' && msg.id === id, 15_000, 'word that the note was written')
    if (!made.ok) throw new Error(`the note was not written: ${made.error}`)
    nodeId = made.node
    const node = json(await request(CORE, `/brain/node?id=${encodeURIComponent(nodeId)}`, { origin: APP }))
    noteFile = node.path?.startsWith('~') ? join(homedir(), node.path.slice(1)) : (node.path ?? '')
    if (!noteFile || !existsSync(noteFile)) throw new Error('the core says it wrote the note, and there is no file')
    if (!(await search()).some((hit) => hit.id === nodeId)) throw new Error('the note is on disk and a search does not find it')
    const got = await ask(Q, `What colour is the harbour light in my ${token} note? One word.`)
    spent.usd += got.cost
    if (!/amber/i.test(got.text)) throw new Error(`the note was written and can be searched for, but asked about it Jett said "${clip(got.text)}"`)
    const recalled = got.hits.some((hit) => hit.id === nodeId)
    await forget()
    if (existsSync(noteFile)) throw new Error(`the test note could not be removed: ${tilde(noteFile)}`)
    return `written, ${recalled ? 'recalled' : 'looked up'} and answered from in ${secs(got.total)}, then removed`
  })

  let sameAsDisk = false
  await check('What is served is what is on disk', async () => {
    if (!served) throw new Skip('the app is not being served')
    const index = join(DIST, 'index.html')
    if (!existsSync(index)) throw broken('something is being served, and there is no built app on disk', '`npm run build`')
    const linked = [...readFileSync(index, 'utf8').matchAll(/(?:src|href)="(\/[^"?#]+)"/g)].map((m) => m[1])
    const paths = ['/', ...new Set(linked)]
    const wrong = []
    for (const path of paths) {
      const file = join(DIST, path === '/' ? 'index.html' : path)
      const res = await request(APP, path)
      if (res.status !== 200 || !existsSync(file) || sha(res.body) !== sha(readFileSync(file))) wrong.push(path)
    }
    if (wrong.length) {
      throw broken(`${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not what is in dist/`, '`npm run build`, then `npm run service:restart`.')
    }
    sameAsDisk = true
    return `the page and the ${paths.length - 1} files it loads, byte for byte`
  })

  await check('The built app is current', () => {
    const built = join(DIST, 'index.html')
    if (!existsSync(built)) throw broken('the app has not been built', '`npm run build`')
    const source = newest([
      ...walk(join(ROOT, 'src')),
      ...walk(join(ROOT, 'public')),
      join(ROOT, 'index.html'),
      join(ROOT, 'vite.config.ts'),
    ])
    const at = statSync(built).mtimeMs
    if (source.at > at) throw broken(`${relative(ROOT, source.path)} has changed since it was built`, '`npm run build`')
    return `built ${ago(at)}, nothing changed since`
  })

  await check('The core is running the code on disk', () => {
    const code = newest(walk(join(ROOT, 'bridge'), ['home-template']).filter((path) => path.endsWith('.mjs')))
    const started = Date.parse(status.started)
    if (code.at > started) {
      throw broken(
        `${relative(ROOT, code.path)} has changed since the core started`,
        status.service ? '`npm run service:restart`' : 'Stop the core and start it again.',
      )
    }
    return `started ${ago(started)}, nothing changed since`
  })

  await check('Private doors stay shut to strangers', async () => {
    const hello = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello.' }) }
    const tries = [
      ['the brain, asked by nobody in particular', async () => (await request(CORE, '/brain/graph')).status < 400],
      ['the brain, asked by another site', async () => (await request(CORE, '/brain/graph', { origin: STRANGER })).status < 400],
      ['the voice, asked by another site', async () => (await request(CORE, '/speak', { ...hello, origin: STRANGER })).status < 400],
      ['the conversation, opened by another site', () => opens('/?check=1', STRANGER)],
      ["the Mac app's line, opened without its token", () => opens('/helper')],
    ]
    const open = []
    for (const [door, answered] of tries) if (await answered()) open.push(door)
    if (open.length) throw new Error(`answered when it should not have: ${open.join('; ')}`)
    return 'the brain, the voice, the conversation and the Mac app’s line'
  })

  await check('Settings and keys cannot be fetched', async () => {
    const mine = [join(home, 'settings.json'), join(home, 'policy.json'), join(ROOT, '.env'), join(ROOT, 'package.json'), join(ROOT, 'bridge', 'server.mjs')]
    const sums = new Set(mine.filter((file) => existsSync(file)).map((file) => sha(readFileSync(file))))
    const settingsFile = encodeURIComponent(join(home, 'settings.json'))
    const settingsUrl = encodeURIComponent(`file://${join(home, 'settings.json')}`)
    const tries = [
      ...['/settings.json', '/.env', '/policy.json', '/package.json', '/bridge/server.mjs', '/../.env', '/..%2f..%2f.env', '/%2e%2e/%2e%2e/.env', '/assets/../../.env', '/assets/../../package.json'].map(
        (path) => [APP, path],
      ),
      ...[
        '/settings.json',
        '/.env',
        '/policy.json',
        `/file?path=${settingsFile}`,
        `/file?path=${encodeURIComponent(join(ROOT, '.env'))}`,
        `/img?url=${settingsUrl}`,
        `/media?url=${settingsUrl}`,
        `/page?url=${settingsUrl}`,
        '/workshop/../settings.json',
        '/workshop/../server.mjs',
        '/workshop/..%2f..%2fserver.mjs',
        '/workshop/%2e%2e/server.mjs',
      ].map((path) => [CORE, path]),
    ].filter(([base]) => served || base !== APP)
    const leaks = []
    for (const [base, path] of tries) {
      const res = await request(base, path, { origin: APP })
      if (res.status < 400 || sums.has(sha(res.body))) leaks.push(`${new URL(base).port}${decodeURIComponent(path)}`)
    }
    if (leaks.length) {
      throw broken(`CONFIG IS REACHABLE FROM THE BROWSER: ${leaks.join(', ')}`, 'Close every Jett window in a browser until this is fixed.')
    }
    return `${tries.length} ways in were tried and every one was refused`
  })

  await check('No key is in what the browser loads', () => {
    const keyish = /KEY|TOKEN|SECRET/i
    const found = []
    // Values are looked for and never printed: only the name of the variable is.
    const values = new Map()
    const note = (name, value) => {
      if (keyish.test(name) && value && value.length >= 16) values.set(value, name)
    }
    for (const [name, value] of Object.entries(process.env)) note(name, value)
    const env = join(ROOT, '.env')
    if (existsSync(env)) {
      for (const line of readFileSync(env, 'utf8').split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/)
        if (!m) continue
        const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
        if (m[1].startsWith('VITE_') && keyish.test(m[1]) && value) found.push(`${m[1]} is set in .env, and anything named VITE_ is built into the app`)
        note(m[1], value)
      }
    }
    const shapes = [
      ['an Anthropic key', /\bsk-ant-[\w-]{20,}/],
      ['an OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/],
      ['an ElevenLabs key', /\bsk_[a-f0-9]{40,}/],
      ['a Google key', /\bAIza[\w-]{35}\b/],
      ['a Slack token', /\bxox[abp]-[\w-]{20,}/],
    ]
    let read = 0
    for (const file of existsSync(DIST) ? walk(DIST) : []) {
      if (!/\.(?:js|mjs|css|html|json|webmanifest|svg|map|txt)$/.test(file)) continue
      const text = readFileSync(file, 'utf8')
      const where = `dist/${relative(DIST, file)}`
      read++
      for (const [what, shape] of shapes) if (shape.test(text)) found.push(`what looks like ${what} is in ${where}`)
      for (const [value, name] of values) if (text.includes(value)) found.push(`the value of ${name} is in ${where}`)
    }
    if (found.length) {
      throw broken(found.join('; '), 'Take it out of .env (Jett signs in through Claude Code and needs no key in the app), then `npm run build`.')
    }
    return read ? `${read} built files read, no key in any of them` : 'nothing is built yet, and .env holds no key for the app'
  })

  // The last two need a real browser: its own, headless, on a profile that is
  // thrown away afterwards. It is opened on the built app with ?check=1, which
  // an older build would not understand, so an older build is not opened.
  const binary = BROWSERS.find((path) => existsSync(path))
  const quietBuild = () =>
    walk(join(DIST, 'assets')).some((file) => file.endsWith('.js') && /searchParams\.set\(["'`]check["'`]/.test(readFileSync(file, 'utf8')))
  let page = null
  let noPage = null
  if (!served) noPage = new Skip('the app is not being served')
  else if (!sameAsDisk || !quietBuild()) noPage = new Skip('the app being served is older than this check; build it first')
  else if (!binary) noPage = new Warn('not tested: there is no Chrome, Edge or Brave here to open the app in')
  else {
    try {
      const browser = await openBrowser(binary)
      undo.push(browser.close)
      const tab = await browser.tab(`${APP}/?mute=1&check=1`, SOUND_COUNTERS)
      await tab.until(`Boolean(document.querySelector('.convo textarea'))`, 20_000, 'the app to open')
      await tab.until('window.__preflightLines.length > 0', 10_000, 'the app to reach the core')
      const lines = await tab.run('window.__preflightLines')
      if (lines.every((line) => /[?&]check=1(?:&|$)/.test(line))) page = tab
      else noPage = new Error('the app opened an ordinary line to the core from a window marked ?check=1')
    } catch (err) {
      noPage = new Warn(`not tested: the browser would not open the app (${clip(err.message, 100)})`)
    }
  }

  await check('A muted window is silent', async () => {
    if (!page) throw noPage
    // Long enough for the cues the app plays as it opens, if it is going to.
    await sleep(2500)
    await page.run(typed('What is seven plus five? One word.'))
    await page.until(
      `[...document.querySelectorAll('.msg-jett .msg-text')].some((el) => /twelve|\\b12\\b/i.test(el.textContent))`,
      60_000,
      'an answer in the muted window',
    )
    // And for a voice that was going to read the answer out to have started.
    await sleep(3000)
    spent.usd += (await page.run('window.__preflightSpent')) || 0
    const made = await page.run('window.__preflightSound')
    const loud = Object.entries(made)
      .filter(([, n]) => n > 0)
      .map(([what, n]) => `${SOUNDS[what]} (${n})`)
    if (loud.length) throw new Error(`a window opened with ?mute=1 still made sound: it ${loud.join(', ')}`)
    // The control. Unmuted, the same window has to set the same counters off,
    // or their silence a moment ago proved nothing.
    await page.run(typed('unmute'))
    const spoke = await page
      .until('(() => { const s = window.__preflightSound; return s.speech + s.played + s.browserVoice > 0 })()', 12_000, 'it to speak')
      .then(
        () => true,
        () => false,
      )
    if (!spoke) throw new Warn('it was silent while muted, but stayed silent once unmuted too, which proves little')
    return 'it answered without a sound; unmuted, the same window spoke'
  })

  await check('The workshop stage is sealed', async () => {
    const frame = await request(CORE, '/workshop/stage.html', { origin: APP })
    if (frame.status !== 200) throw new Error(`the stage did not load (${frame.status})`)
    const policy = String(frame.headers['content-security-policy'] ?? '')
    const needs = [/(?:^|;)\s*sandbox allow-scripts\s*(?:;|$)/, /default-src 'none'/, /connect-src 'none'/]
    if (!needs.every((need) => need.test(policy))) throw new Error('THE STAGE IS SERVED WITHOUT ITS LOCK: its policy no longer confines it')
    if (!page) {
      if (noPage instanceof Skip) throw noPage
      throw new Warn('its policy is right, but there was no browser to try the lock in')
    }
    const out = await page.run(stageTrial(`${CORE}/workshop/stage.html`))
    const trouble = out.trouble.length ? ` (${clip(out.trouble.join('; '), 120)})` : ''
    if (!out.ready) throw new Error(`the stage never started${trouble}`)
    if (!out.ran?.ok) throw new Error(`a plain cube would not run on it: ${out.ran?.message ?? 'no answer'}${trouble}`)
    if (!out.seal) throw new Error(`asked to try its own lock, the stage did not answer${trouble}`)
    const ways = Object.entries(out.seal.report ?? {})
    const open = ways.filter(([, result]) => result !== 'blocked').map(([way]) => way)
    if (open.length || !ways.length || !out.seal.sealed) throw new Error(`CODE ON THE STAGE CAN REACH OUT: ${open.join(', ') || 'the stage says it is not sealed'}`)
    return `a part ran on it (${out.ran.triangles} triangles) and all ${ways.length} ways out were shut`
  })

  await check('The bench answers', () => {
    if (!before.bench) throw new Error('asked what is on it, the bench did not answer')
    return before.bench.open ? `"${clip(before.bench.title, 40)}" is on it, and was left alone` : 'clear, and waiting for a build'
  })

  await check('Photo builds', () => {
    throw new Skip('not part of this Jett, so there is no image key to look for')
  })

  await check('Nothing is left behind', async () => {
    const left = []
    if (noteFile && existsSync(noteFile)) left.push(`the test note, ${tilde(noteFile)}`)
    if ((await search()).length) left.push('the test note, still in the second brain')
    const builds = listing(join(home, 'builds')).filter(
      (name) => !before.builds.includes(name) && /preflight/i.test(readFileSync(join(home, 'builds', name), 'utf8')),
    )
    if (builds.length) left.push(`a test build, ${builds.join(', ')}`)
    const sounds = listing(join(home, 'logs')).filter((name) => /^preflight-.*\.wav$/.test(name))
    if (sounds.length) left.push(`a recording, ${sounds.join(', ')}`)
    const bench = await benchState(C).catch(() => null)
    if (before.bench && bench && bench.open !== before.bench.open) left.push('the bench is not as it was found')
    if (left.length) throw new Error(left.join('; '))
    return 'no test note, no test build, no recording'
  })

  // Earned: each of these broke once.

  await check("The schedule keeps this Mac's time", () => {
    // Jobs ran an hour early for two days: the clocks had changed and the core, started before, had not noticed.
    const mac = readlinkSync('/etc/localtime').split('zoneinfo/')[1]
    if (!mac || !status.zone) throw new Skip('the time zone could not be read')
    const clock = (zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date())
    if (clock(mac) !== clock(status.zone)) {
      throw broken(
        `the core believes it is ${clock(status.zone)} (${status.zone}), and this Mac says ${clock(mac)} (${mac})`,
        '`npm run service:restart`. Until then scheduled jobs run at the wrong hour.',
      )
    }
    const next = (status.jobs ?? [])
      .filter((job) => job.enabled && job.nextRun)
      .sort((a, b) => Date.parse(a.nextRun) - Date.parse(b.nextRun))[0]
    const when = next && new Date(next.nextRun).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    return `${mac}${next ? `; next up is ${next.title ?? next.name}, ${when}` : ''}`
  })

  await check('Jett starts at login', () => {
    const loaded = (label) => spawnSync('launchctl', ['print', `gui/${userInfo().uid}/${label}`], { stdio: 'ignore' }).status === 0
    if (loaded('com.jett.core')) return 'com.jett.core, restarted by launchd if it stops'
    const old = ['com.emrys.core', 'com.jarvis.core'].find(loaded)
    if (old) throw new Warn(`it does, though still under its old name, ${old}`, '`npm run service:install` moves it to com.jett.core.')
    throw new Warn('not installed: the core is running from a terminal', '`npm run service:install` starts it at every login.')
  })

  await check('The Mac app', () => {
    const app = status.helper ?? {}
    const old = spawnSync('pgrep', ['-x', 'EmrysHelper'], { stdio: 'ignore' }).status === 0
    const install = '`npm run service:install` builds Jett.app, opens it at every login and retires the old helper.'
    if (old) throw new Warn('the old Emrys Helper is still running in its place', install)
    if (!app.connected) throw new Warn('Jett.app is not running, so the talk key only works inside the window', install)
    if (app.missing?.length) throw new Warn(`it is running and waiting on: ${app.missing.join(', ')}`, 'System Settings › Privacy & Security is where those are allowed.')
    return 'running, with the talk key ready in every app'
  })

  await tidy()
  finish()
}

main().catch(async (err) => {
  console.log(`${MARKS.fail} Preflight itself broke — ${err?.stack ?? err}`)
  tally.fail++
  await tidy()
  finish()
})
