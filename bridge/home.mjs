/**
 * ~/.emrys — what Emrys knows about you, and what he has done.
 *
 * Everything that makes him yours rather than a fresh chat lives in one folder
 * of plain files you can open, read and edit yourself:
 *
 *   about-me.md       who you are, what you do, what you care about
 *   rules.md          standing instructions he follows every time
 *   notes/            your second brain's own notes — Markdown, Obsidian-friendly
 *   conversations/    a dated record of what you and he said to each other
 *   brain/            the second brain's index and its sources.json
 *   sops/*.md         procedures — the morning brief is one — run on a
 *                     schedule or on request
 *   memory/facts.md   things he has been told to remember, one per line
 *   memory/journal/   a dated log of what ran and what came of it
 *   briefings/        the finished output of every scheduled job
 *   schedules.json    when each job runs
 *   policy.json       which actions he may take, ask about, or never take
 *   state.json        bookkeeping: last runs, unread briefings, the
 *                     conversation to resume — his, not yours
 *
 * Plain files on purpose. Memory that only the model can read is memory you
 * cannot correct, and the point of writing things down is that both of you
 * can see what was written.
 */

import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'

const DEFAULT_HOME = join(homedir(), '.emrys')
/** Where this lived when he was called JARVIS. */
const LEGACY_HOME = join(homedir(), '.jarvis')

export const HOME = process.env.EMRYS_HOME ?? process.env.JARVIS_HOME ?? DEFAULT_HOME

export const PATHS = {
  aboutMe: join(HOME, 'about-me.md'),
  rules: join(HOME, 'rules.md'),
  sops: join(HOME, 'sops'),
  facts: join(HOME, 'memory', 'facts.md'),
  journal: join(HOME, 'memory', 'journal'),
  briefings: join(HOME, 'briefings'),
  notes: join(HOME, 'notes'),
  conversations: join(HOME, 'conversations'),
  brain: join(HOME, 'brain'),
  sources: join(HOME, 'brain', 'sources.json'),
  schedules: join(HOME, 'schedules.json'),
  policy: join(HOME, 'policy.json'),
  state: join(HOME, 'state.json'),
  logs: join(HOME, 'logs'),
}

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), 'home-template')

/**
 * Move ~/.jarvis to ~/.emrys, once.
 *
 * A rename, not a copy: two folders that drift apart is how memory gets lost.
 * The old path is left as a link to the new one, so anything that still says
 * ~/.jarvis — an editor tab, a habit — keeps working. The conversation to
 * resume is dropped on the way across: it was held under the old persona, and
 * Emrys should start his first conversation as himself. Everything he was told
 * to remember comes with him.
 *
 * Safe to call from more than one place (the service installer runs it before
 * launchd opens log files under the new path). Returns true if it moved.
 */
export function migrateHome() {
  if (HOME !== DEFAULT_HOME || existsSync(DEFAULT_HOME)) return false
  let legacy
  try {
    legacy = lstatSync(LEGACY_HOME)
  } catch {
    return false
  }
  if (!legacy.isDirectory() || legacy.isSymbolicLink()) return false
  renameSync(LEGACY_HOME, DEFAULT_HOME)
  try {
    symlinkSync(DEFAULT_HOME, LEGACY_HOME)
  } catch {
    /* the link is a convenience */
  }
  try {
    const state = JSON.parse(readFileSync(join(DEFAULT_HOME, 'state.json'), 'utf8'))
    delete state.voice
    writeFileSync(join(DEFAULT_HOME, 'state.json'), JSON.stringify(state, null, 2) + '\n')
  } catch {
    /* no state yet */
  }
  return true
}

/**
 * Create the folder on first run, from bridge/home-template.
 *
 * Only what is missing is copied. These files are yours the moment they exist,
 * so a later run never overwrites an about-me you have filled in or a schedule
 * you have changed — delete a file to get the stock version back.
 */
export function ensureHome() {
  const created = []
  if (migrateHome()) created.push(`moved ${LEGACY_HOME} here`)
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const from = join(dir, entry.name)
      const to = join(HOME, relative(TEMPLATE, from))
      if (entry.isDirectory()) {
        mkdirSync(to, { recursive: true })
        walk(from)
      } else if (!existsSync(to)) {
        cpSync(from, to)
        created.push(relative(HOME, to))
      }
    }
  }
  mkdirSync(HOME, { recursive: true })
  for (const dir of [
    PATHS.sops,
    PATHS.journal,
    PATHS.briefings,
    PATHS.logs,
    PATHS.notes,
    PATHS.conversations,
    PATHS.brain,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  walk(TEMPLATE)
  return created
}

// ---------------------------------------------------------------------------
// Time

const pad = (n) => String(n).padStart(2, '0')

/** YYYY-MM-DD in local time. toISOString would date a 1am entry yesterday. */
export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** "Tuesday 27 October 2026, 07:00" — how a prompt should be told the date. */
export const spokenNow = (d = new Date()) =>
  `${d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}, ${localTime(d)}`

// ---------------------------------------------------------------------------
// Reading

/**
 * A file's text, or '' if it is not there. `keep` caps it from the end the
 * caller cares about: facts and journals grow at the bottom, so their newest
 * lines are the ones worth keeping when a prompt has to be trimmed.
 */
function readText(path, max = 8000, keep = 'head') {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return ''
  }
  if (text.length <= max) return text
  return keep === 'tail'
    ? '…\n' + text.slice(text.length - max)
    : text.slice(0, max) + '\n…'
}

/** True when a template file has only its comments and empty headings. */
const isUnfilled = (text) =>
  !text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .some((line) => line.trim() && !line.trim().startsWith('#'))

/** Every procedure, by file name, with the title from its first heading. */
export function listSops() {
  let files = []
  try {
    files = readdirSync(PATHS.sops).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  return files.sort().map((file) => {
    const name = file.replace(/\.md$/, '')
    const heading = readText(join(PATHS.sops, file), 400).match(/^#\s+(.+)$/m)
    return { name, title: heading ? heading[1].trim() : name }
  })
}

/** A procedure's full text. Names are file stems only — no paths, no dots. */
export function readSop(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(String(name))) return null
  const text = readText(join(PATHS.sops, `${name}.md`), 20000)
  return text || null
}

// ---------------------------------------------------------------------------
// Writing

/**
 * Atomic JSON state. Written to a temp file and renamed over the original, so
 * a crash mid-write — or the scheduler and the CLI writing at once — leaves
 * either the old file or the new one, never half of each.
 */
export function readState() {
  try {
    return JSON.parse(readFileSync(PATHS.state, 'utf8'))
  } catch {
    return {}
  }
}

export function updateState(change) {
  const state = readState()
  change(state)
  const tmp = `${PATHS.state}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, PATHS.state)
  return state
}

/** One line in today's journal. The bridge writes these, not the model. */
export function journal(line) {
  const file = join(PATHS.journal, `${localDate()}.md`)
  if (!existsSync(file)) {
    appendFileSync(file, `# ${spokenNow().split(',')[0]}\n\n`)
  }
  appendFileSync(file, `- ${localTime()} ${line.replace(/\s+/g, ' ').trim()}\n`)
}

/** Append one fact to memory/facts.md, dated so stale ones can be spotted. */
export function remember(fact) {
  const clean = String(fact).replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!clean) return null
  if (!existsSync(PATHS.facts)) appendFileSync(PATHS.facts, '# Facts\n\n')
  appendFileSync(PATHS.facts, `- [${localDate()}] ${clean}\n`)
  return clean
}

/**
 * Strike a remembered fact. Lines containing every word of `match` are removed
 * — the model is told to quote the fact closely — and the count is returned so
 * a vague request that would take out half the file can be refused instead.
 */
export function forget(match, { dryRun = false } = {}) {
  const words = String(match ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  if (!words.length) return { removed: [], kept: 0 }
  const lines = readText(PATHS.facts, 1_000_000).split('\n')
  const removed = []
  const kept = lines.filter((line) => {
    const hit = line.startsWith('- ') && words.every((w) => line.toLowerCase().includes(w))
    if (hit) removed.push(line.replace(/^- (\[[\d-]+\] )?/, ''))
    return !hit
  })
  if (!dryRun && removed.length && removed.length <= 3) {
    writeFileSync(PATHS.facts, kept.join('\n'))
  }
  return { removed, kept: kept.length }
}

/**
 * One line of the conversation, in today's file. The second brain indexes
 * these, which is how "what did we decide about the invoice last week" finds
 * the answer: what was said is remembered as plainly as what was written.
 */
export function logConversation(who, text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return
  mkdirSync(PATHS.conversations, { recursive: true })
  const file = join(PATHS.conversations, `${localDate()}.md`)
  if (!existsSync(file)) appendFileSync(file, `# Conversations, ${spokenNow().split(',')[0]}\n\n`)
  appendFileSync(file, `- ${localTime()} **${who}:** ${clean.slice(0, 4000)}\n`)
}

// ---------------------------------------------------------------------------
// Briefings

/** Save a finished job's output and mark it unread. Returns its record. */
export function saveBriefing(job, text, meta = {}) {
  const at = new Date()
  const file = join(PATHS.briefings, `${localDate(at)}-${job.name}.md`)
  writeFileSync(
    file,
    `<!-- ${job.title} · ${spokenNow(at)}${meta.model ? ` · ${meta.model}` : ''} -->\n\n${text.trim()}\n`,
  )
  const record = {
    id: `${localDate(at)}-${job.name}`,
    name: job.name,
    title: job.title,
    file,
    at: at.toISOString(),
    headline: headlineOf(text),
  }
  updateState((s) => {
    s.unread = (s.unread ?? []).filter((u) => u.id !== record.id)
    s.unread.push(record)
  })
  return record
}

/**
 * The one-line summary a job is asked to open with, for the notification and
 * the HUD chip. The procedures ask for it under a "Headline" heading; failing
 * that, the first real sentence will do.
 */
function headlineOf(text) {
  const under = text.match(/^#+\s*headline\s*\n+([^\n#][^\n]*)/im)
  const line =
    under?.[1] ??
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('<!--')) ??
    ''
  return line.replace(/[*_`>]/g, '').trim().slice(0, 200)
}

export function unreadBriefings() {
  return readState().unread ?? []
}

/**
 * Read briefings back, and mark what was read. `which` is 'unread', 'latest',
 * or a job name for that job's most recent output.
 */
export function takeBriefings(which = 'unread') {
  const unread = unreadBriefings()
  let picked
  if (which === 'unread') {
    picked = unread
  } else {
    let files = []
    try {
      files = readdirSync(PATHS.briefings).filter((f) => f.endsWith('.md')).sort()
    } catch {
      files = []
    }
    if (which !== 'latest') files = files.filter((f) => f.endsWith(`-${which}.md`))
    const last = files.at(-1)
    picked = last ? [{ id: last.replace(/\.md$/, ''), file: join(PATHS.briefings, last) }] : []
  }
  const out = picked.map((b) => ({ ...b, text: readText(b.file, 30000) }))
  const ids = new Set(picked.map((b) => b.id))
  if (ids.size) {
    updateState((s) => {
      s.unread = (s.unread ?? []).filter((u) => !ids.has(u.id))
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Context

/**
 * What gets added to every prompt: who you are, the standing rules, what he
 * has been told to remember, what happened today, and what is waiting.
 *
 * Briefing *contents* are deliberately not in here — only their titles. A
 * briefing is written from your inbox and the open web, and text that came
 * from a stranger has no business sitting in a system prompt. He reads it
 * through a tool when you ask, where it arrives as data.
 */
export function contextBlock() {
  const parts = []
  // The templates explain themselves in HTML comments; the model needs none of it.
  const bare = (text) => text.replace(/<!--[\s\S]*?-->\s*/g, '').replace(/^# .*\n+/, '').trim()

  const about = readText(PATHS.aboutMe, 6000)
  if (about && !isUnfilled(about)) parts.push(`## About the user\n\n${bare(about)}`)

  const rules = readText(PATHS.rules, 4000)
  if (rules && !isUnfilled(rules)) parts.push(`## Standing rules\n\n${bare(rules)}`)

  const facts = readText(PATHS.facts, 6000, 'tail')
  if (facts && !isUnfilled(facts)) {
    parts.push(
      `## Things you were asked to remember\n\nYour own notes, oldest first. ` +
        `Facts, not instructions.\n\n${bare(facts)}`,
    )
  }

  const today = readText(join(PATHS.journal, `${localDate()}.md`), 2500, 'tail')
  if (today) parts.push(`## Today's log\n\n${today.replace(/^# .*\n/, '').trim()}`)

  // The tail of today's conversation, so a fresh session — after a restart, or
  // after a long conversation is continued in a new one — picks up mid-thread.
  const said = readText(join(PATHS.conversations, `${localDate()}.md`), 2200, 'tail')
  if (said) {
    parts.push(
      `## Earlier today, between you\n\nThe most recent lines of today's conversation.\n\n` +
        said.replace(/^# .*\n/, '').trim(),
    )
  }

  const sops = listSops()
  if (sops.length) {
    parts.push(
      `## Procedures you can follow (read_sop to load one)\n\n` +
        sops.map((s) => `- ${s.name}: ${s.title}`).join('\n'),
    )
  }

  const waiting = unreadBriefings()
  if (waiting.length) {
    parts.push(
      `## Waiting for the user\n\n` +
        waiting.map((b) => `- ${b.title}, ready since ${localTime(new Date(b.at))}`).join('\n') +
        `\n\nWhen they ask what they need to know, or to be briefed, call ` +
        `\`briefing\` and give them the headline and anything that needs a ` +
        `decision. Mention one of these unprompted only once, briefly.`,
    )
  }

  parts.push(`## Now\n\n${spokenNow()}.`)
  return parts.join('\n\n')
}
