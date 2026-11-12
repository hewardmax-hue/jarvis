/**
 * The workshop, from the app's side: the go-between for the core's bench,
 * which decides what gets built, and the sealed stage, which draws it.
 *
 * Three rules hold here.
 *
 * Code the builder wrote is only ever a string in this file. It is handed to
 * the stage — a frame with no origin, no network and no way back but
 * postMessage — and run there. Nothing in the app evaluates it.
 *
 * What the stage says is untrusted. A part can make the stage say anything, so
 * every message from it is matched against what was asked for, clipped, and
 * used for nothing but ticks, crosses and repairs.
 *
 * A change never restarts a build. Parts are kept by name and by version, so a
 * new version replaces one part on the stage and the rest stay where they are.
 * Only a stage that has stopped answering is thrown away, and then everything
 * that ran before is put back.
 */
import { BRIDGE_HTTP_URL } from '../config'
import { useStore, type Bench, type BenchPart } from '../store'
import { askBench, sendBench, watchBench, type BenchFrame } from './brain'

export type Light = Bench['light']
export type View = 'stop' | 'spin' | 'top' | 'front' | 'back' | 'side' | 'flip' | 'in' | 'out' | 'fit'

export type Printed = { ok: true; name: string; folder: string; files: number } | { ok: false; error: string }

type Hooks = {
  /** A line the bench wants said. `talk` marks the answer to a question asked over the build. */
  say: (line: string, talk: boolean) => void
}

/** A part as the app holds it: the newest version, and the last one known to run. */
type Kept = {
  name: string
  label: string
  code: string
  /** The version, counted by the core. A report is only worth anything with it. */
  n: number
  /** How version `n` ran: null until the stage has said. */
  ok: boolean | null
  /** The last version that ran, to fall back on when the stage has to be rebuilt. */
  good: string | null
  /** Whether the core has heard how version `n` ran. */
  told: boolean
}

const STAGE_PATH = '/workshop/stage.html'
const PING_MS = 3000
/** Unanswered pings before the stage counts as frozen: longer than any honest part takes to run. */
const MISSED = 4
const START_MS = 15000
const MAX_RELOADS = 3
/** A stage that has answered for this long has earned a clean slate. */
const STEADY_MS = 60000
const PRINT_MS = 30000
const MAX_FILES = 64
const MAX_BYTES = 64 * 1024 * 1024
const STL_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}\.stl$/
const FROZE = 'the stage froze while this part ran — a loop that never ends, or far too much geometry'

let hooks: Hooks = { say() {} }
/** The build on the bench; '' when it is clear. */
let build = ''
/**
 * The builder thinks before it writes, and says what it is thinking about as
 * it goes: those lines are the note until its first word arrives. This is the
 * work it is thinking about, '' once it has started writing.
 */
let musing: '' | 'build' | 'change' = ''
const parts = new Map<string, Kept>()
/**
 * What the stage has been given and has not yet answered for, oldest first.
 * It runs one part at a time and answers once for each, in order, so the
 * oldest entry with a name is the one an answer with that name is about.
 * `tell` is whether the core is waiting to hear.
 */
let sent: Array<{ name: string; n: number; tell: boolean }> = []
let host: HTMLElement | null = null
let frame: HTMLIFrameElement | null = null
let ready = false
let loadedAt = 0
let unanswered = 0
let reloads = 0
/** The spare name the stage is loaded under after a freeze; '' for the usual address. */
let spare = ''
let printing: ((files: unknown) => void) | null = null

const store = () => useStore.getState()
const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/**
 * Where the stage is loaded from: the core, under the loopback name the app is
 * *not* using. Same machine, same file, but a different site as far as the
 * browser is concerned, which is what gets the frame a process of its own
 * where the browser has one to give. The app's policy only names the core's
 * usual address, so anywhere else it is the copy the app's own server keeps.
 *
 * A frozen stage leaves its process hung for half a minute after the frame is
 * gone, and a new frame from the same site is put straight back into it. So
 * the stage that replaces it comes from a name nothing has used: any
 * `*.localhost` is this Mac to a browser that keeps frames apart.
 */
function stageUrl(): string {
  try {
    const url = new URL(STAGE_PATH, BRIDGE_HTTP_URL)
    const here = window.location.hostname
    const loopback = ['localhost', '127.0.0.1']
    if (url.port === '8787' && loopback.includes(url.hostname) && loopback.includes(here)) {
      url.hostname = spare || (here === 'localhost' ? '127.0.0.1' : 'localhost')
      return url.href
    }
  } catch {
    // Fall through to the app's own copy.
  }
  return STAGE_PATH
}

/** A new stage. The old one, and whatever was stuck in it, goes with its element. */
function load() {
  if (!host) return
  frame?.remove()
  ready = false
  unanswered = 0
  sent = []
  loadedAt = Date.now()
  const el = document.createElement('iframe')
  // Scripts and nothing else. With no origin of its own it has no storage, no
  // cookies, and no way to reach into the app that holds it.
  el.setAttribute('sandbox', 'allow-scripts')
  el.setAttribute('referrerpolicy', 'no-referrer')
  el.title = 'Workshop stage'
  el.className = 'bench-stage'
  el.src = stageUrl()
  host.appendChild(el)
  frame = el
}

/** Give the stage somewhere to live, or take it away. */
export function mount(el: HTMLElement | null) {
  if (el === host) return
  host = el
  if (el) return load()
  frame?.remove()
  frame = null
  ready = false
  sent = []
}

function post(msg: Record<string, unknown>): boolean {
  if (!ready || !frame?.contentWindow) return false
  // The stage has no origin to name, so '*' it is; nothing sent to it is a secret.
  frame.contentWindow.postMessage(msg, '*')
  return true
}

function run(part: Kept, code: string, tell: boolean) {
  if (post({ op: 'part', name: part.name, code })) sent.push({ name: part.name, n: part.n, tell })
}

const show = (part: Kept, state: BenchPart['state']) => store().putBenchPart(build, { name: part.name, label: part.label, state })

/** A fresh stage has nothing on it: put back every part that ran, and run the ones that have not yet. */
function replay() {
  const bench = store().bench
  post({ op: 'reset' })
  if (bench) post({ op: 'light', to: bench.light })
  for (const part of [...parts.values()].sort((a, b) => a.n - b.n)) {
    if (part.ok === false) {
      if (part.good) run(part, part.good, false)
    } else run(part, part.code, !part.told)
  }
  if (bench?.status === 'ready') post({ op: 'built' })
  if (bench?.exploded) post({ op: 'explode', on: true })
}

/** A new version of a part, or a new part. */
function take(name: string, label: string, code: string, n: number) {
  const was = parts.get(name)
  const part: Kept = { name, label: label || was?.label || name, code, n, ok: null, good: was?.good ?? null, told: false }
  parts.set(name, part)
  show(part, 'running')
  // Before the stage is up this sends nothing, and `replay` runs it once it is.
  run(part, code, true)
}

/** The builder has started writing: its thinking is no longer the news. */
function wrote() {
  if (!musing) return
  store().patchBench(build, { note: musing === 'build' ? 'Putting it together' : 'Making the change' })
  musing = ''
}

function open(id: string, request: string, title: string, status: Bench['status'], working = 0) {
  build = id
  musing = ''
  parts.clear()
  // Anything the stage still owes an answer for belongs to the build before:
  // keep its place in the line, so the answer is matched and thrown away.
  for (const entry of sent) entry.tell = false
  reloads = 0
  store().setBench({
    id,
    title: title || request,
    request,
    status,
    parts: [],
    exploded: false,
    light: 'studio',
    note: '',
    since: status === 'building' || status === 'changing' ? Date.now() - working : 0,
  })
  post({ op: 'reset' })
  post({ op: 'light', to: 'studio' })
}

/** The bench as the core has it. For a build already here only what differs is touched. */
function restore(f: BenchFrame) {
  const status = f.status === 'building' || f.status === 'changing' ? f.status : 'ready'
  const working = Math.max(0, Number(f.working) || 0)
  if (f.id !== build) open(f.id, text(f.request), text(f.title), status, working)
  else {
    const since = status === 'ready' ? 0 : store().bench?.since || Date.now() - working
    store().patchBench(build, { title: text(f.title) || text(f.request), status, since })
  }
  const seen = new Set<string>()
  for (const p of Array.isArray(f.parts) ? f.parts : []) {
    if (!p || typeof p.name !== 'string' || typeof p.code !== 'string') continue
    seen.add(p.name)
    const n = Number(p.n) || 0
    if (parts.get(p.name)?.n === n) continue
    take(p.name, text(p.status, 80), p.code, n)
  }
  for (const name of [...parts.keys()]) if (!seen.has(name)) discard(name)
  if (status === 'ready') post({ op: 'built' })
}

function discard(name: string) {
  parts.delete(name)
  store().dropBenchPart(build, name)
  post({ op: 'remove', name })
}

/** A turn of the builder is over: nothing on the list should still be spinning without a reason. */
function settle() {
  for (const shown of store().bench?.parts ?? []) {
    const part = parts.get(shown.name)
    // Announced, and then never written.
    if (!part) store().dropBenchPart(build, shown.name)
    else if (part.ok !== null) show(part, part.ok || part.good ? 'ok' : 'failed')
  }
}

function onBench(f: BenchFrame) {
  if (f.op === 'opened') return open(f.id, text(f.request), text(f.title), 'building')
  if (f.op === 'restore') return restore(f)
  if (!build || f.id !== build) return
  const name = typeof f.name === 'string' ? f.name : ''
  const part = parts.get(name)
  switch (f.op) {
    case 'work':
      if (f.what === 'build') {
        musing = 'build'
        store().patchBench(build, { status: 'building', note: 'Working out the parts', since: Date.now() })
      } else if (f.what === 'change') {
        musing = 'change'
        store().patchBench(build, { status: 'changing', note: 'Working on the change', since: Date.now() })
      } else if (f.what === 'repair' && part) {
        show(part, 'repairing')
        store().patchBench(build, { note: `Mending ${part.label.toLowerCase()}` })
      }
      return
    case 'thinking':
      if (musing) store().patchBench(build, { note: text(f.line, 160) })
      return
    case 'title':
      wrote()
      return store().patchBench(build, { title: text(f.title) || store().bench?.title })
    case 'wait':
      musing = ''
      return store().patchBench(build, { note: text(f.line, 80) })
    case 'writing':
      wrote()
      if (!name) return
      return store().putBenchPart(build, { name, label: text(f.status, 80) || part?.label || name, state: 'writing' })
    case 'part':
      wrote()
      if (!name || typeof f.code !== 'string') return
      return take(name, text(f.status, 80), f.code, Number(f.n) || 0)
    case 'remove':
      wrote()
      return discard(name)
    case 'failed':
      if (!part) return
      // A replacement that would not run never took the old one down.
      if (f.standing === true && part.good) {
        part.code = part.good
        part.ok = true
        part.told = true
        show(part, 'ok')
      } else {
        part.ok = false
        part.told = true
        show(part, 'failed')
      }
      return
    case 'say':
      return hooks.say(text(f.line, 600), f.talk === true)
    case 'done': {
      settle()
      if (f.idle !== true) return
      const took = Math.round(Number(f.seconds) || 0)
      const failed = Array.isArray(f.failed) ? f.failed.length : 0
      const note = failed
        ? `${failed} ${failed === 1 ? 'part' : 'parts'} would not build`
        : f.what === 'build' && took
          ? `Built in ${took} seconds`
          : ''
      musing = ''
      store().patchBench(build, { status: 'ready', note, since: 0 })
      post({ op: 'built' })
      return
    }
    case 'closed':
      return drop()
    case 'error':
      // The core has already cleared its bench; there is nothing here to keep.
      drop()
      return hooks.say(text(f.line, 300), false)
  }
}

/** How a part ran, as the stage tells it. */
function onRan(m: Record<string, unknown>) {
  const name = typeof m.name === 'string' ? m.name : ''
  const part = parts.get(name)
  const message = text(m.message, 400)
  if (m.late === true) {
    // It ran, and then something it left running threw. The core decides what to do about it.
    if (!part || part.ok !== true) return
    part.ok = false
    sendBench({ op: 'ran', build, name, n: part.n, ok: false, message, late: true })
    return
  }
  const at = sent.findIndex((entry) => entry.name === name)
  if (at < 0) return
  const [entry] = sent.splice(at, 1)
  if (!entry.tell) return
  const ok = m.ok === true
  sendBench({ op: 'ran', build, name, n: entry.n, ok, message, late: false })
  // A newer version may have arrived while this one ran; that one gets its own answer.
  if (!part || part.n !== entry.n) return
  part.told = true
  part.ok = ok
  if (ok) {
    part.good = part.code
    show(part, 'ok')
  }
  // A failure keeps its spinner: the core is about to mend it, or say that it can't.
}

function onStage(event: MessageEvent) {
  if (!frame || event.source !== frame.contentWindow) return
  const m = event.data
  if (!m || typeof m !== 'object' || m.from !== 'jett-stage' || typeof m.type !== 'string') return
  switch (m.type) {
    case 'ready':
      ready = true
      unanswered = 0
      return replay()
    case 'pong':
      unanswered = 0
      // The limit is on a stage that keeps stopping, not on every stop there has ever been.
      if (reloads && Date.now() - loadedAt > STEADY_MS) reloads = 0
      return
    case 'ran':
      return onRan(m)
    case 'apart':
      if (m.moved === true) store().patchBench(build, { exploded: m.on === true })
      return
    case 'stl': {
      const done = printing
      printing = null
      return done?.(m.files)
    }
    case 'lost':
      // The graphics card took the picture away. Nobody's fault; start a new one.
      return again(false)
    case 'fault':
    case 'refused':
      return console.warn('[workshop] stage:', m.type, text(m.message ?? m.what, 300))
  }
}

/** Throw the stage away and start another. `frozen` when it stopped answering, which has a culprit. */
function again(frozen: boolean) {
  const hung = frozen ? sent[0] : undefined
  if (hung) {
    // One part runs at a time in there, so the oldest unanswered one is what hung it.
    const part = parts.get(hung.name)
    if (hung.tell) sendBench({ op: 'ran', build, name: hung.name, n: hung.n, ok: false, message: FROZE, late: false })
    if (part && hung.tell && part.n === hung.n) {
      part.ok = false
      part.told = true
    } else if (part && !hung.tell) {
      // It was being put back, and froze the stage doing it. It does not go back again.
      part.ok = false
      part.good = null
      show(part, 'failed')
    }
  }
  if (++reloads > MAX_RELOADS) {
    frame?.remove()
    frame = null
    ready = false
    sent = []
    return store().patchBench(build, { status: 'error', note: 'The stage keeps stopping. Close it and ask again.' })
  }
  if (frozen) spare = `bench-${Math.random().toString(36).slice(2, 10)}.localhost`
  load()
}

/** Is the stage still there? A part with a loop that never ends takes the whole frame with it. */
function beat() {
  const bench = store().bench
  if (!bench || !frame || bench.status === 'error' || document.hidden) {
    unanswered = 0
    return
  }
  if (!ready) {
    if (Date.now() - loadedAt > START_MS) {
      // A browser that cannot find a spare name gets the usual address back.
      spare = ''
      again(false)
    }
    return
  }
  if (unanswered >= MISSED) return again(true)
  unanswered++
  post({ op: 'ping' })
}

/** A window that was out of sight was not being timed. */
function onShow() {
  unanswered = 0
  if (!ready) loadedAt = Date.now()
}

/** Clear the bench here. The core is told separately, by whoever decided. */
export function drop() {
  build = ''
  musing = ''
  parts.clear()
  for (const entry of sent) entry.tell = false
  const done = printing
  printing = null
  done?.(null)
  store().setBench(null)
}

/**
 * After the core has been away: is the build on screen still on its bench?
 * It keeps the bench in memory, so a restart clears it — and a build the core
 * no longer has cannot be changed, only looked at, which is worse than gone.
 */
export function recheck() {
  const id = build
  if (!id) return
  void askBench('state').then((answer) => {
    if (!answer.ok && !answer.lost && build === id) drop()
  })
}

// -- what can be done to the build without asking anyone ---------------------

/** Each of these says whether the stage was there to hear it. */
export function camera(to: View): boolean {
  return post({ op: 'camera', to })
}

export function light(to: Light): boolean {
  store().patchBench(build, { light: to })
  return post({ op: 'light', to })
}

export function explode(on: boolean): boolean {
  return post({ op: 'explode', on })
}

/** Only what looks exactly like a list of STL files is passed on; one thing wrong and none of it is. */
function sound(files: unknown): Array<{ name: string; bytes: ArrayBuffer }> | null {
  if (!Array.isArray(files) || files.length > MAX_FILES) return null
  let total = 0
  const names = new Set<string>()
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !STL_NAME.test(file.name) || names.has(file.name)) return null
    if (!(file.bytes instanceof ArrayBuffer) || file.bytes.byteLength < 84) return null
    names.add(file.name)
    total += file.bytes.byteLength
  }
  return total > MAX_BYTES ? null : files
}

/**
 * Every piece as its own STL, into a folder in Downloads named after the build.
 * The stage makes the files and the core writes them; the app only carries
 * them across, because the stage may talk to nobody else and the page may not
 * write to disk.
 */
export async function print(): Promise<Printed> {
  const id = build
  if (!id || !ready) return { ok: false, error: 'the stage is not ready yet' }
  if (printing) return { ok: false, error: 'an export is already under way' }
  const got = await new Promise<unknown>((resolve) => {
    const timer = window.setTimeout(() => {
      printing = null
      resolve(null)
    }, PRINT_MS)
    printing = (files) => {
      window.clearTimeout(timer)
      resolve(files)
    }
    post({ op: 'stl' })
  })
  const files = sound(got)
  if (!files) return { ok: false, error: 'the stage did not hand over the pieces' }
  if (!files.length) return { ok: false, error: 'there is nothing on the bench yet' }
  let saved: { name?: unknown; folder?: unknown } = {}
  for (const file of files) {
    try {
      const res = await fetch(
        `${BRIDGE_HTTP_URL}/workshop/export?build=${encodeURIComponent(id)}&file=${encodeURIComponent(file.name)}`,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file.bytes },
      )
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) return { ok: false, error: text(body?.error, 120) || 'my core would not save it' }
      saved = body
    } catch {
      return { ok: false, error: "I couldn't reach my core" }
    }
  }
  return { ok: true, name: text(saved.name, 80), folder: text(saved.folder, 300), files: files.length }
}

/** Start listening: to the core's bench, and to the stage. Returns how to stop. */
export function startWorkshop(with_: Hooks): () => void {
  hooks = with_
  watchBench(onBench)
  window.addEventListener('message', onStage)
  document.addEventListener('visibilitychange', onShow)
  const timer = window.setInterval(beat, PING_MS)
  return () => {
    window.removeEventListener('message', onStage)
    document.removeEventListener('visibilitychange', onShow)
    window.clearInterval(timer)
    hooks = { say() {} }
  }
}
