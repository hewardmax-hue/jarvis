/**
 * The workshop bench.
 *
 * "Build me a mechanical watch." A model writes the thing as a handful of
 * parts — one for each real component — and each part is put on the stage the
 * moment its last line arrives, so the object takes shape in front of the
 * person who asked rather than appearing after a minute of nothing.
 *
 * Three rules hold the whole thing up:
 *
 *   Code a model wrote runs in one place only: the sealed stage in the
 *   interface (see stage.js). Here it is text. It is parsed, stored, sent on
 *   and saved; it is never evaluated in this process.
 *
 *   What the stage says back — "that part ran", "that one threw" — is a report
 *   from a room with untrusted code in it. It is matched against what was
 *   sent, clipped, and used for one thing: deciding whether to ask for a fix.
 *
 *   A change never restarts a build. Parts have names; a change rewrites the
 *   parts it touches under the same names and the stage swaps them where they
 *   stand.
 *
 * One build is on the bench at a time, and the work on it — the build itself,
 * repairs, changes asked for in order — runs one job after another.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { PATHS, journal, readSettings } from '../home.mjs'
import { TIERS } from '../models.mjs'
import { ASK, SORT_SYSTEM, SYSTEM, sortAsk } from './prompt.mjs'

/** A build is a parts list, not a novel: past this the model has lost the thread. */
const MAX_PARTS = 24
const MAX_PART_CHARS = 60_000
/** How long the stage has to say whether a part ran. Its own limit is ten seconds. */
const REPORT_MS = 20_000
/** A stream that says nothing at all for this long is not coming back. */
const QUIET_MS = 120_000
/** A part that fails is rewritten with the error — twice, and then the build goes on without it. */
const MAX_REPAIRS = 2
/** The sorter is there to be quick. If it is not, a guess is better than a wait. */
const SORT_MS = 7_000
const MAX_STL_BYTES = 64 * 1024 * 1024
const MAX_STL_FILES = 64

const clean = (value, n = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

const slug = (value, n = 48) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, n)
    .replace(/-+$/, '')

const pad = (n) => String(n).padStart(2, '0')
const stamp = (d) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

const seconds = (since) => Math.round((Date.now() - since) / 100) / 10

/** A paragraph of the builder's own account of its thinking, cut to one line for the bench. */
const brief = (paragraph) => {
  const line = clean(paragraph, 400)
  if (line.length <= 140) return line
  const cut = line.slice(0, 139)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 100))}…`
}

// ---------------------------------------------------------------------------
// Reading the stream

/**
 * Turns the model's text, as it arrives, into parts.
 *
 * Fed in whatever pieces the network delivers; works a line at a time. A line
 * beginning //@ is a directive; between //@part and //@end everything is the
 * part's code, kept exactly as written. Anything else — a stray sentence, a
 * code fence — is dropped, because nothing outside a part is ever run.
 */
export function createReader(on = {}) {
  let buffer = ''
  let part = null
  let count = 0

  const finish = () => {
    if (!part) return
    const done = part
    part = null
    if (done.over) return on.cut?.(done.name, 'it was far too long')
    const code = done.lines.join('\n').trim()
    if (!code) return on.cut?.(done.name, 'it was empty')
    on.part?.(done.name, done.status, code)
  }

  const line = (raw) => {
    const directive = /^\s*\/\/@(\w+)\s*(.*)$/.exec(raw)
    if (!directive) {
      if (!part || /^\s*```/.test(raw)) return
      part.size += raw.length + 1
      if (part.size > MAX_PART_CHARS) part.over = true
      else part.lines.push(raw)
      return
    }
    const word = directive[1].toLowerCase()
    const rest = directive[2].trim()
    // The model forgot an //@end: the next directive is as good as one.
    if (part) finish()
    if (word === 'part') {
      const bar = rest.indexOf('|')
      const name = slug(bar === -1 ? rest : rest.slice(0, bar))
      if (!name || ++count > MAX_PARTS) return
      part = { name, status: clean(bar === -1 ? '' : rest.slice(bar + 1), 80), lines: [], size: 0, over: false }
      on.writing?.(part.name, part.status)
    } else if (word === 'title') {
      if (rest) on.title?.(clean(rest, 80))
    } else if (word === 'say') {
      if (rest) on.say?.(clean(rest, 400))
    } else if (word === 'wait') {
      if (rest) on.wait?.(clean(rest, 80))
    } else if (word === 'remove') {
      const name = slug(rest)
      if (name) on.remove?.(name)
    }
  }

  return {
    push(text) {
      buffer += text
      let at
      while ((at = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, at).replace(/\r$/, ''))
        buffer = buffer.slice(at + 1)
      }
    },
    /** The stream is over. A part still open was cut off mid-line: half a part is no part. */
    end() {
      if (buffer) line(buffer)
      buffer = ''
      if (part) {
        const name = part.name
        part = null
        on.cut?.(name, 'it was cut off before it was finished')
      }
    },
  }
}

// ---------------------------------------------------------------------------
// One turn of a model, as text

/**
 * Ask once, hear the answer as it is written.
 *
 * No tools, no files, no session kept: text in, text out. Resolves when the
 * turn is over, however it ended — { streamed, cost, error, thought }.
 *
 * The builder thinks before it writes, and on a build with many parts that is
 * most of the wait. `onThought` asks for its own summary of that thinking and
 * is handed it a paragraph at a time, so the bench has something true to show
 * meanwhile; `thought` is how many seconds went by before the first word.
 */
async function once(model, prompt, { system = SYSTEM, effort = 'low', signal, onText, onThought, tokens = '48000' } = {}) {
  const abort = new AbortController()
  const onAbort = () => abort.abort()
  if (signal?.aborted) abort.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  let streamed = 0
  let cost = 0
  let error = null
  let quiet = null
  const began = Date.now()
  let wrote = 0
  let musing = ''
  const heard = () => {
    clearTimeout(quiet)
    quiet = setTimeout(() => {
      error = 'the model went quiet'
      abort.abort()
    }, QUIET_MS)
  }
  heard()

  try {
    const session = query({
      prompt,
      options: {
        systemPrompt: system,
        model,
        effort,
        ...(onThought ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
        cwd: tmpdir(),
        settingSources: [],
        tools: [],
        // Nothing but the model: without this the account's own connectors ride
        // along on every call — some fifty thousand tokens of tools it may not use.
        mcpServers: {},
        strictMcpConfig: true,
        maxTurns: 1,
        persistSession: false,
        permissionMode: 'default',
        includePartialMessages: true,
        abortController: abort,
        env: tokens ? { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: tokens } : process.env,
        canUseTool: async () => ({ behavior: 'deny', message: 'No tools at the bench.' }),
      },
    })
    for await (const msg of session) {
      heard()
      if (msg.type === 'stream_event') {
        const event = msg.event
        const delta = event?.type === 'content_block_delta' ? event.delta : null
        if (delta?.type === 'text_delta' && delta.text) {
          wrote ||= Date.now()
          streamed += delta.text.length
          onText?.(delta.text)
        } else if (delta?.type === 'thinking_delta' && delta.thinking && onThought && !wrote) {
          musing += delta.thinking
          const end = musing.lastIndexOf('\n\n')
          if (end < 0) continue
          const whole = musing.slice(0, end).split(/\n{2,}/).map(brief).filter(Boolean)
          musing = musing.slice(end + 2)
          if (whole.length) onThought(whole.at(-1))
        }
      } else if (msg.type === 'result') {
        cost = msg.total_cost_usd ?? 0
        if (msg.is_error || msg.subtype !== 'success') {
          // The text of a failure is not something the model wrote for the bench.
          error = clean(msg.subtype === 'success' ? msg.result : msg.subtype, 200) || 'it failed'
        } else if (!streamed && msg.result) {
          streamed = msg.result.length
          onText?.(msg.result)
        }
        break
      }
    }
  } catch (err) {
    if (!error) error = abort.signal.aborted ? 'stopped' : clean(err?.message, 200) || 'it failed'
  } finally {
    clearTimeout(quiet)
    signal?.removeEventListener('abort', onAbort)
  }
  return { streamed, cost, error, thought: wrote ? Math.round((wrote - began) / 100) / 10 : null }
}

/**
 * Does this model answer at all? One word asked for, one word back.
 *
 * Preflight's question, put by the core itself: a model that answers a script
 * in a terminal but not the service that has to use it is the failure worth
 * catching.
 */
export async function answers(model, effort = 'low') {
  const began = Date.now()
  let said = ''
  const out = await once(model, 'Reply with the single word: ready', {
    system: 'You answer with one word and nothing else.',
    effort,
    tokens: '',
    onText: (text) => (said += text),
  })
  return {
    model,
    ok: !out.error && /ready/i.test(said),
    said: clean(said, 60),
    seconds: Math.round((Date.now() - began) / 100) / 10,
    cost: out.cost,
    error: out.error ?? (said ? '' : 'it said nothing'),
  }
}

// ---------------------------------------------------------------------------
// Sorting a sentence

/**
 * A small model kept on the line while a build is open.
 *
 * Sorting a sentence is a one-word job, and almost all of what it costs to ask
 * a model from here is starting the process that asks. So that is done once,
 * when the bench opens, and each sentence after that is one more message to a
 * session already listening. Measured on this machine: six or seven seconds
 * cold, about a second and a half warm — nearly all of that the model's own
 * time to its first word.
 */
function createSorter() {
  let live = null

  const start = () => {
    const s = { inbox: [], deliver: null, over: false, pending: null, turns: 0, abort: new AbortController() }
    const messages = async function* () {
      while (!s.over) {
        const text =
          s.inbox.shift() ??
          (await new Promise((resolve) => {
            s.deliver = resolve
          }))
        if (s.over || text == null) return
        yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
      }
    }
    const end = () => {
      s.over = true
      s.deliver?.(null)
      s.pending?.('')
      s.pending = null
      if (live === s) live = null
    }
    s.stop = () => {
      end()
      s.abort.abort()
    }
    ;(async () => {
      try {
        const session = query({
          prompt: messages(),
          options: {
            systemPrompt: SORT_SYSTEM,
            model: TIERS.fast.model,
            effort: TIERS.fast.effort,
            cwd: tmpdir(),
            settingSources: [],
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            persistSession: false,
            permissionMode: 'default',
            abortController: s.abort,
            canUseTool: async () => ({ behavior: 'deny', message: 'No tools at the bench.' }),
          },
        })
        for await (const msg of session) {
          if (msg.type !== 'result') continue
          const done = s.pending
          s.pending = null
          done?.(msg.subtype === 'success' && !msg.is_error ? (msg.result ?? '') : '')
        }
      } catch {
        /* stopped, or it fell over: either way the next sentence starts another */
      } finally {
        end()
      }
    })()
    return s
  }

  let line = Promise.resolve()

  return {
    /** Have it listening before it is needed. */
    warm() {
      live ??= start()
    },
    stop() {
      live?.stop()
    },
    /** One sentence in, one line back — or '' if it took too long, and a fresh session for next time. */
    ask(prompt, ms) {
      const turn = line.then(
        () =>
          new Promise((resolve) => {
            const s = (live ??= start())
            const timer = setTimeout(() => {
              s.stop()
              resolve('')
            }, ms)
            s.pending = (text) => {
              clearTimeout(timer)
              // A long session is a slow one: after a while, begin again.
              if (++s.turns >= 24) s.stop()
              resolve(text)
            }
            if (s.deliver) {
              const deliver = s.deliver
              s.deliver = null
              deliver(prompt)
            } else {
              s.inbox.push(prompt)
            }
          }),
      )
      line = turn.catch(() => {})
      return turn
    },
  }
}

const KINDS = new Set(['change', 'talk', 'new', 'other'])

function readSort(text) {
  for (const raw of String(text).split('\n')) {
    const cells = raw.split('|').map((cell) => cell.trim())
    const kind = cells[0].toLowerCase().replace(/[^a-z]/g, '')
    if (!KINDS.has(kind)) continue
    return { kind, line: clean(cells[1], 160), what: clean(cells[2], 200) }
  }
  return null
}

/** With no model to ask: the plain cases, and "not mine" for the rest. */
function guessSort(said) {
  const s = said.toLowerCase().trim()
  const please = s.replace(/^(please|now|and|then|ok(ay)?|right|so)[ ,]+/, '').replace(/^(can|could|would) you /, '')
  if (/^(build|make|design|model) me (a|an|another) /.test(please)) {
    return { kind: 'new', line: 'Clearing the bench.', what: please.replace(/^\w+ me /, '') }
  }
  if (
    /^(make|paint|add|remove|take|change|turn|give|swap|replace|put|colou?r|resize|shrink|enlarge|scale|move|rotate|widen|thicken|round|polish|engrave|delete|lose|fix|get rid of|i want (it|the)|let'?s (make|add|paint|change))\b/.test(
      please,
    )
  ) {
    return { kind: 'change', line: 'On it.', what: '' }
  }
  if (/^(what|how|why|which|where|who|is|are|does|do|tell me|explain)\b/.test(please) && /\b(it|its|this|that|these|those)\b/.test(please)) {
    return { kind: 'talk', line: '', what: '' }
  }
  return { kind: 'other', line: '', what: '' }
}

// ---------------------------------------------------------------------------
// The bench

/**
 * @param {object} with
 * @param {object} with.activity   the activity log (see activity.mjs)
 * @param {(frame: object) => void} with.emit   tell every open interface
 * @param {(line: string) => void} [with.note]  something the conversation should know next time it is asked
 */
export function createBench({ activity, emit, note = () => {} }) {
  /** The build that is open, if one is. */
  let bench = null
  const jobs = []
  let running = null
  /** Set once the first-choice model has failed and the stand-in has worked. */
  let standIn = null
  const sorter = createSorter()

  const tell = (b, frame) => {
    if (b.closed) return
    try {
      emit({ type: 'workshop', id: b.id, ...frame })
    } catch (err) {
      // A window that cannot be told is not a reason to stop building.
      console.error('[workshop] could not send a frame:', err?.message ?? err)
    }
  }

  const builder = () => standIn ?? process.env.JETT_MODEL_BUILD ?? (readSettings().buildModel || 'claude-fable-5-2')

  const busyWith = (b) => running?.b === b || jobs.some((job) => job.b === b)

  // -- parts ---------------------------------------------------------------

  const report = (ms) => {
    let settle
    const promise = new Promise((done) => {
      settle = done
    })
    const timer = setTimeout(() => settle(null), ms)
    return {
      promise,
      settle(value) {
        clearTimeout(timer)
        settle(value)
      },
    }
  }

  /** Send a part to the stage and wait to hear how it went. */
  function deliver(b, name, status, code, { repair = false } = {}) {
    if (b.closed) return null
    let part = b.parts.get(name)
    if (!part) {
      if (b.parts.size >= MAX_PARTS) return null
      part = { name, status: '', code: '', good: null, ok: null, error: null, repairs: 0, n: 0, gaveUp: false, report: null }
      b.parts.set(name, part)
    }
    part.report?.settle(null)
    if (status) part.status = status
    part.code = code
    part.ok = null
    part.error = null
    if (!repair) {
      part.repairs = 0
      part.gaveUp = false
    }
    part.n = ++b.n
    part.report = report(REPORT_MS)
    if (b.firstPart == null) b.firstPart = seconds(b.started)
    tell(b, { op: 'part', name, status: part.status, code, n: part.n })
    return part
  }

  /** What the stage said about a part. Untrusted: matched, clipped, and used only to decide on a repair. */
  function ran({ id, name, n, ok, message, late } = {}) {
    const b = bench
    if (!b || b.id !== id || typeof name !== 'string') return
    const part = b.parts.get(name)
    if (!part || part.n !== n || part.gaveUp) return
    const text = clean(message, 400)
    if (late) {
      // It ran, and then something it left running threw.
      if (part.ok !== true) return
      part.ok = false
      part.error = text || 'it failed while running'
      if (!busyWith(b)) enqueue({ kind: 'mend', b })
      return
    }
    if (part.ok !== null) return
    part.ok = ok === true
    part.error = part.ok ? null : text || 'it did not run'
    if (part.ok) part.good = part.code
    part.report?.settle(part.ok)
  }

  const reports = (b) => Promise.all([...b.parts.values()].map((part) => part.report?.promise))

  const standing = (b) => [...b.parts.values()].filter((part) => part.good || part.ok === null)
  const fallen = (b) => [...b.parts.values()].filter((part) => !part.good && part.ok === false)

  // -- the model -----------------------------------------------------------

  /** One turn of the builder, read into parts as it is written. */
  async function write(b, job, prompt, on) {
    const turn = async (model) => {
      const reader = createReader(on)
      const out = await once(model, prompt, {
        signal: job.abort.signal,
        onText: (text) => reader.push(text),
        onThought: on.thought,
      })
      reader.end()
      b.cost += out.cost
      return out
    }
    let model = builder()
    let out = await turn(model)
    if (!out.streamed && !job.abort.signal.aborted && model !== TIERS.deep.model) {
      console.log(`[workshop] ${model} wrote nothing (${out.error ?? 'no reason given'}) — trying ${TIERS.deep.model}`)
      model = TIERS.deep.model
      out = await turn(model)
      if (out.streamed) standIn = model
    }
    b.model = model
    return out
  }

  /** Rewrite whatever failed, with the error, until it runs or has had its chances. */
  async function mend(b, job) {
    for (;;) {
      await reports(b)
      if (b.closed || job.abort.signal.aborted) return
      const part = [...b.parts.values()].find((p) => p.ok === false && !p.gaveUp)
      if (!part) return
      if (part.repairs >= MAX_REPAIRS) {
        part.gaveUp = true
        const message = part.error
        // A failed replacement never took the old one down: the last version that ran still stands.
        if (part.good) {
          part.code = part.good
          part.ok = true
        }
        tell(b, { op: 'failed', name: part.name, message, standing: Boolean(part.good) })
        continue
      }
      part.repairs++
      b.repairs++
      tell(b, { op: 'work', what: 'repair', name: part.name, attempt: part.repairs })
      const before = part.n
      await write(b, job, ASK.repair(b, part), {
        // Whatever it calls it, a repair turn writes the one part it was given.
        part: (_name, _status, code) => {
          if (part.n === before) deliver(b, part.name, part.status, code, { repair: true })
        },
      })
    }
  }

  // -- jobs ----------------------------------------------------------------

  function finish(b, what, started) {
    if (b.closed) return
    save(b)
    const failed = fallen(b).map((part) => part.name)
    tell(b, {
      op: 'done',
      what,
      seconds: seconds(started),
      firstPart: b.firstPart,
      parts: standing(b).length,
      failed,
      repairs: b.repairs,
      cost: Math.round(b.cost * 1000) / 1000,
      idle: !jobs.some((job) => job.b === b),
    })
  }

  const RUN = {
    async build(b, job) {
      const act = activity.put({ kind: 'build', agent: 'Workshop', title: `Build ${b.request}`, status: 'running' })
      b.activity = act
      tell(b, { op: 'work', what: 'build' })
      const out = await write(b, job, ASK.build(b), {
        thought: (line) => tell(b, { op: 'thinking', line }),
        title: (title) => {
          b.title = title
          tell(b, { op: 'title', title })
        },
        writing: (name, status) => tell(b, { op: 'writing', name, status }),
        part: (name, status, code) => deliver(b, name, status, code),
        cut: (name, why) => tell(b, { op: 'failed', name, message: why, standing: b.parts.get(name)?.good != null }),
        say: (line) => {
          b.say = line
          tell(b, { op: 'say', line })
        },
      })
      const written = seconds(b.started)
      if (b.closed) return activity.update(act, { status: 'stopped' })

      if (!b.parts.size) {
        const why = out.error ?? 'nothing came back'
        console.log(`[workshop] "${b.request}" — no parts (${why})`)
        activity.update(act, { status: 'error', detail: why })
        tell(b, { op: 'error', message: why, line: "That one didn't make it onto the bench. Ask me again in a moment." })
        if (bench === b) shut(b, { quiet: true })
        return
      }

      await mend(b, job)
      if (b.closed) return activity.update(act, { status: 'stopped' })

      b.seconds = seconds(b.started)
      if (!b.title) b.title = b.request.replace(/^./, (c) => c.toUpperCase())
      finish(b, 'build', b.started)
      const count = standing(b).length
      const lost = fallen(b).length
      const summary =
        `${count} part${count === 1 ? '' : 's'}` +
        (out.thought ? `, thought for ${out.thought}s` : '') +
        `, first on the bench at ${b.firstPart}s, written in ${written}s, standing in ${b.seconds}s` +
        (b.repairs ? `, ${b.repairs} repair${b.repairs === 1 ? '' : 's'}` : '') +
        (lost ? `, ${lost} left off` : '')
      console.log(`[workshop] "${b.title}" — ${summary} · ${b.model} · $${b.cost.toFixed(3)}`)
      activity.update(act, { status: 'done', title: `Built ${b.title}`, detail: summary, cost: b.cost })
      try {
        journal(`Workshop: built "${b.title}" — ${count} parts in ${b.seconds}s.`)
      } catch {
        /* the build stands whether or not the diary took the line */
      }
      note(
        `The workshop bench now shows a 3D model they asked you to build: "${b.title}" (${count} parts). ` +
          `It is on screen. They can ask to change it, pull it apart, 3D print it, or close it — the workshop handles those itself.`,
      )
    },

    async change(b, job) {
      const started = Date.now()
      const act = activity.put({ kind: 'build', agent: 'Workshop', title: `Change: ${job.said}`, status: 'running' })
      tell(b, { op: 'work', what: 'change', said: job.said })
      const touched = new Set()
      // What it says about the change is held until the stage has run it: "now
      // copper" is only true once the copper part is standing.
      let closing = ''
      const out = await write(b, job, ASK.change(b, job.said), {
        thought: (line) => tell(b, { op: 'thinking', line }),
        wait: (line) => tell(b, { op: 'wait', line }),
        writing: (name, status) => tell(b, { op: 'writing', name, status }),
        part: (name, status, code) => {
          if (deliver(b, name, status, code)) touched.add(name)
        },
        remove: (name) => {
          if (!b.parts.delete(name)) return
          touched.add(name)
          tell(b, { op: 'remove', name })
        },
        cut: (name, why) => tell(b, { op: 'failed', name, message: why, standing: b.parts.get(name)?.good != null }),
        say: (line) => {
          closing = line
        },
      })
      if (b.closed) return activity.update(act, { status: 'stopped' })
      if (!out.streamed) {
        activity.update(act, { status: 'error', detail: out.error ?? 'nothing came back' })
        tell(b, { op: 'say', line: "I couldn't make that change. It's as it was." })
        return finish(b, 'change', started)
      }
      await mend(b, job)
      if (b.closed) return activity.update(act, { status: 'stopped' })
      const lost = [...touched].filter((name) => b.parts.get(name)?.gaveUp)
      if (lost.length) {
        const names = lost.map((name) => name.replace(/-/g, ' ')).join(' and ')
        tell(b, {
          op: 'say',
          line:
            lost.length === touched.size
              ? "That change wouldn't run, so I've left it as it was."
              : `That's done, except the ${names}, which wouldn't run. I've left that as it was.`,
        })
      } else if (closing) {
        tell(b, { op: 'say', line: closing })
      }
      b.changes.push(job.said)
      finish(b, 'change', started)
      const detail = touched.size ? `Rewrote ${[...touched].join(', ')}` : 'Nothing needed rewriting'
      console.log(`[workshop] change "${job.said}" — ${detail.toLowerCase()} in ${seconds(started)}s`)
      activity.update(act, { status: 'done', detail, cost: b.cost })
    },

    /** Something that was running on the stage broke after the build was done. */
    async mend(b, job) {
      const started = Date.now()
      await mend(b, job)
      finish(b, 'repair', started)
    },
  }

  async function pump() {
    if (running) return
    const job = jobs.shift()
    if (!job) return
    if (job.b.closed) return pump()
    running = job
    job.began = Date.now()
    try {
      await RUN[job.kind](job.b, job)
    } catch (err) {
      console.error(`[workshop] ${job.kind} failed:`, err)
      tell(job.b, { op: 'done', what: job.kind, idle: !jobs.some((next) => next.b === job.b), failed: [], parts: standing(job.b).length })
    } finally {
      running = null
      pump()
    }
  }

  function enqueue(job) {
    job.abort = new AbortController()
    jobs.push(job)
    pump()
  }

  /** A question about what is on the bench. It changes nothing, so it need not wait its turn. */
  async function talk(b, said) {
    const job = { abort: new AbortController() }
    b.talks.add(job)
    tell(b, { op: 'work', what: 'talk', said })
    let line = ''
    try {
      await write(b, job, ASK.talk(b, said), {
        say: (text) => {
          line = line ? `${line} ${text}` : text
        },
      })
    } finally {
      b.talks.delete(job)
    }
    tell(b, { op: 'say', line: line || "I couldn't get you an answer on that one.", talk: true })
  }

  // -- keeping builds ------------------------------------------------------

  function save(b) {
    const parts = standing(b).map((part) => ({ name: part.name, status: part.status, code: part.good ?? part.code }))
    if (!parts.length) return
    try {
      mkdirSync(PATHS.builds, { recursive: true })
      const file = join(PATHS.builds, `${b.id}.json`)
      const data = {
        id: b.id,
        title: b.title || b.request,
        request: b.request,
        said: b.said,
        at: b.at,
        model: b.model,
        parts,
        changes: b.changes,
        say: b.say,
        seconds: b.seconds,
        firstPart: b.firstPart,
        repairs: b.repairs,
        cost: Math.round(b.cost * 1000) / 1000,
      }
      writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2))
      renameSync(`${file}.tmp`, file)
    } catch (err) {
      console.error('[workshop] could not save the build:', err.message)
    }
  }

  const fresh = (id, request, said) => ({
    id,
    request,
    said,
    title: '',
    at: new Date().toISOString(),
    started: Date.now(),
    model: '',
    parts: new Map(),
    changes: [],
    say: '',
    seconds: null,
    firstPart: null,
    repairs: 0,
    cost: 0,
    n: 0,
    closed: false,
    talks: new Set(),
    exported: new Set(),
    activity: null,
  })

  /** The bench as it stands, for an interface that was not there when it happened. */
  function snapshot() {
    const b = bench
    if (!b) return null
    return {
      type: 'workshop',
      op: 'restore',
      id: b.id,
      title: b.title || b.request,
      request: b.request,
      status: !busyWith(b) ? 'ready' : running?.b === b && running.kind === 'build' ? 'building' : 'changing',
      // How long the work under way has been going, so a window that joins late counts from the start.
      working: running?.b === b ? Date.now() - running.began : 0,
      parts: [...b.parts.values()]
        .filter((part) => part.good || part.ok !== false)
        .map((part) => ({ name: part.name, status: part.status, code: part.ok === false ? part.good : part.code, n: part.n })),
    }
  }

  /** Put the newest saved build back on the bench. No model is asked anything. */
  function last() {
    let newest = null
    try {
      for (const name of readdirSync(PATHS.builds)) {
        if (!name.endsWith('.json')) continue
        const at = statSync(join(PATHS.builds, name)).mtimeMs
        if (!newest || at > newest.at) newest = { name, at }
      }
    } catch {
      return null
    }
    if (!newest) return null
    let data
    try {
      data = JSON.parse(readFileSync(join(PATHS.builds, newest.name), 'utf8'))
    } catch {
      return null
    }
    const id = newest.name.slice(0, -'.json'.length)
    if (bench?.id === id) {
      emit(snapshot())
      return bench
    }
    const parts = (Array.isArray(data.parts) ? data.parts : []).filter(
      (part) => part && typeof part.name === 'string' && typeof part.code === 'string' && part.code.length <= MAX_PART_CHARS,
    )
    if (!parts.length) return null
    close()
    const b = fresh(id, clean(data.request) || 'a build', clean(data.said))
    b.title = clean(data.title, 80) || b.request
    b.at = typeof data.at === 'string' ? data.at : b.at
    b.model = clean(data.model, 80)
    b.changes = (Array.isArray(data.changes) ? data.changes : []).filter((c) => typeof c === 'string').slice(-40)
    b.say = clean(data.say, 400)
    b.seconds = Number(data.seconds) || null
    b.firstPart = Number(data.firstPart) || 0
    for (const part of parts.slice(0, MAX_PARTS)) {
      const name = slug(part.name)
      if (!name) continue
      b.parts.set(name, {
        name,
        status: clean(part.status, 80),
        code: part.code,
        good: part.code,
        ok: true,
        error: null,
        repairs: 0,
        n: ++b.n,
        gaveUp: false,
        report: null,
      })
    }
    bench = b
    sorter.warm()
    emit(snapshot())
    console.log(`[workshop] back on the bench: "${b.title}" (${b.parts.size} parts)`)
    note(`The workshop bench shows a 3D model built earlier and just reopened: "${b.title}". The workshop handles changes to it itself.`)
    return b
  }

  // -- opening and closing -------------------------------------------------

  function shut(b, { quiet = false, keep = false } = {}) {
    b.closed = true
    if (running?.b === b) running.abort.abort()
    for (const job of b.talks) job.abort.abort()
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].b === b) jobs.splice(i, 1)
    for (const part of b.parts.values()) part.report?.settle(null)
    if (bench === b) bench = null
    if (!keep) sorter.stop()
    if (!quiet) emit({ type: 'workshop', op: 'closed', id: b.id })
  }

  /** Clear the bench. True if there was something on it. */
  function close() {
    const b = bench
    if (!b) return false
    shut(b)
    note('The workshop bench has been cleared: nothing is on it now.')
    return true
  }

  /** Start a build from nothing. Whatever was on the bench is cleared first. */
  function build(said, what) {
    const request = clean(what || said, 300)
    if (!request) return null
    if (bench) shut(bench, { keep: true })
    const b = fresh(`${stamp(new Date())}-${slug(request, 40) || 'build'}`, request, clean(said, 300))
    bench = b
    sorter.warm()
    emit({ type: 'workshop', op: 'opened', id: b.id, request: b.request, title: b.request.replace(/^./, (c) => c.toUpperCase()) })
    enqueue({ kind: 'build', b })
    return b
  }

  /**
   * Something was said while a build is open. Whose is it?
   * Resolves to { kind, line, what }: the caller says the line, and takes the
   * sentence back if the kind is 'other'. Everything else is already in hand.
   */
  async function hear(said) {
    const b = bench
    const sentence = clean(said, 600)
    if (!b || !sentence) return { kind: 'other', line: '', what: '' }
    const busy = busyWith(b)
    const started = Date.now()
    const read = readSort(await sorter.ask(sortAsk(b, sentence, busy), SORT_MS))
    const sorted = read ?? guessSort(sentence)
    console.log(`[workshop] "${sentence.slice(0, 60)}" → ${sorted.kind}${read ? '' : ' (guessed)'} in ${seconds(started)}s`)
    // The bench was cleared, or another build begun, while the sentence was being sorted.
    if (b.closed || bench !== b) return { kind: 'other', line: '', what: '' }

    if (sorted.kind === 'change') {
      if (busy && !/queue/i.test(sorted.line)) sorted.line = `Queued. ${sorted.line}`.trim()
      enqueue({ kind: 'change', b, said: sentence })
    } else if (sorted.kind === 'talk') {
      sorted.line = ''
      talk(b, sentence).catch((err) => console.error('[workshop] talk failed:', err))
    } else if (sorted.kind === 'new') {
      build(sentence, sorted.what || sentence)
    } else {
      sorted.line = ''
    }
    return sorted
  }

  // -- 3D printing ---------------------------------------------------------

  /**
   * Write one piece of the open build into Downloads as an STL.
   *
   * The bytes come from the stage, by way of the interface, so nothing about
   * them is taken on trust: the folder is named here, from the build this
   * process is holding; the file name has to be a plain one; and the bytes have
   * to be exactly the shape of a binary STL, which leaves no room for them to
   * be anything else.
   */
  function exportFile(id, file, bytes) {
    const b = bench
    if (!b || b.id !== id) throw new Error('That build is not on the bench.')
    if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}\.stl$/.test(file) || file.includes('..')) {
      throw new Error('Not an STL file name.')
    }
    if (!Buffer.isBuffer(bytes) || bytes.length < 84 || bytes.length > MAX_STL_BYTES) throw new Error('Not an STL file.')
    if (bytes.length !== 84 + 50 * bytes.readUInt32LE(80)) throw new Error('Not an STL file.')
    if (!b.exported.has(file) && b.exported.size >= MAX_STL_FILES) throw new Error('Too many files for one build.')

    const downloads = join(homedir(), 'Downloads')
    const name =
      (b.title || b.request)
        .replace(/[^A-Za-z0-9 _-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
        .trim() || 'Jett build'
    const folder = resolve(downloads, name)
    const path = resolve(folder, file)
    if (!folder.startsWith(downloads + sep) || !path.startsWith(folder + sep)) throw new Error('Not a place to save to.')
    mkdirSync(folder, { recursive: true })
    if (!realpathSync(folder).startsWith(realpathSync(downloads) + sep)) throw new Error('Not a place to save to.')
    writeFileSync(path, bytes)
    b.exported.add(file)
    return { folder, name, files: b.exported.size }
  }

  return {
    build,
    hear,
    ran,
    last,
    close,
    snapshot,
    exportFile,
    /** Which model writes the builds, as things stand now. */
    get model() {
      return builder()
    },
    get open() {
      return bench ? { id: bench.id, title: bench.title || bench.request, busy: busyWith(bench) } : null
    },
    /** Are there builds to go back to? */
    get kept() {
      try {
        return existsSync(PATHS.builds) && readdirSync(PATHS.builds).some((name) => name.endsWith('.json'))
      } catch {
        return false
      }
    },
  }
}
