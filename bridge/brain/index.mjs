/**
 * The second brain.
 *
 * One searchable pile of everything that is yours — what Emrys was told to
 * remember, what the two of you said, the briefings he wrote, your own notes,
 * and the documents in the folders you point him at — and a habit of looking
 * in it before answering.
 *
 * It is built the way that actually holds up in daily use rather than the way
 * that demos well:
 *
 *   Connectors   each source is scanned for what is new or changed since the
 *                last pass, and only that is read. Every item is stamped with
 *                its date. Sources are rescanned on a timer and the ones Emrys
 *                writes to are watched, so the brain keeps itself current.
 *   Digest       every item is read once by the cheapest model and given a
 *                summary, the questions it answers, tags, entities and atoms
 *                (see digest.mjs). Searching those finds things raw text
 *                would miss.
 *   BM25         plain text search over all of it, title and summary weighted
 *                above body. Fast enough to run before every turn.
 *   Recency      newer items get a boost, so last month's price beats the one
 *                from two years ago when both match.
 *   Graph        items, the folders they live in and the people and projects
 *                they mention, drawn as a map the interface can fly around.
 *
 * Everything lives in ~/.emrys/brain as plain JSON. Deleting index.json makes
 * the brain rebuild itself from the sources on the next start.
 */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { HOME, PATHS, localDate } from '../home.mjs'
import { Bm25, bestSentence, terms } from './text.mjs'
import { READERS, extractText, kindOf, titleFrom, wikiLinks } from './extract.mjs'
import { digestBatch, excerpt } from './digest.mjs'

const INDEX_FILE = join(PATHS.brain, 'index.json')
const INDEX_VERSION = 2

const DAY = 86_400_000
/** Items shorter than this are their own summary; a model call would add nothing. */
const SHORT = 360
/** A file still being written to is digested once it has been quiet this long. */
const SETTLE_MS = 8 * 60_000
const RESCAN_MS = 15 * 60_000
const DIGEST_BATCH = 6

const DEFAULT_SOURCES = {
  '//':
    'What the second brain reads. Emrys\'s own memory, conversations, briefings and notes are ' +
    'always included; "folders" adds yours. Each folder is read for documents (Markdown, text, ' +
    'Word, PDF, PowerPoint, Excel; Pages and Keynote by name only), skipping code projects, ' +
    'hidden folders and anything matching "exclude". Every item is summarised once by Claude ' +
    'Haiku so it can be found by what it means, not just the words in it — set "digest" to ' +
    'false to keep file contents on this Mac and index them by their words alone. Saved ' +
    'changes are picked up within a minute.',
  folders: [
    { name: 'Desktop', path: '~/Desktop', enabled: true },
    { name: 'Documents', path: '~/Documents', enabled: true },
    { name: 'Downloads', path: '~/Downloads', enabled: false },
  ],
  exclude: ['node_modules', 'Library', 'Applications', 'dist', 'build', 'venv', '.venv', '__pycache__', 'Photos Library.photoslibrary'],
  maxFilesPerFolder: 600,
  maxDepth: 6,
  digest: true,
  recencyHalfLifeDays: 120,
}

const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
const sha = (s) => createHash('sha1').update(s).digest('hex')
const idFor = (prefix, key) => `${prefix}:${sha(key).slice(0, 12)}`

/** Built-in sources: Emrys’s own writing. Ordered as they appear in the map. */
const OWN = [
  { name: 'Memory', kind: 'memory' },
  { name: 'Conversations', kind: 'conversation', dir: () => PATHS.conversations },
  { name: 'Notes', kind: 'note', dir: () => PATHS.notes, recursive: true },
  { name: 'Briefings', kind: 'briefing', dir: () => PATHS.briefings },
  { name: 'Journal', kind: 'journal', dir: () => PATHS.journal },
]

export function readSources() {
  if (!existsSync(PATHS.sources)) {
    mkdirSync(dirname(PATHS.sources), { recursive: true })
    writeFileSync(PATHS.sources, JSON.stringify(DEFAULT_SOURCES, null, 2) + '\n')
  }
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(PATHS.sources, 'utf8'))
  } catch {
    raw = {}
  }
  const folders = (Array.isArray(raw.folders) ? raw.folders : DEFAULT_SOURCES.folders)
    .filter((f) => f && typeof f.path === 'string' && f.enabled !== false)
    .map((f) => ({ name: String(f.name || basename(expand(f.path))), path: expand(f.path) }))
  return {
    folders,
    exclude: new Set(Array.isArray(raw.exclude) ? raw.exclude : DEFAULT_SOURCES.exclude),
    maxFiles: Number(raw.maxFilesPerFolder) || DEFAULT_SOURCES.maxFilesPerFolder,
    maxDepth: Number(raw.maxDepth) || DEFAULT_SOURCES.maxDepth,
    digest: raw.digest !== false,
    halfLife: Number(raw.recencyHalfLifeDays) || DEFAULT_SOURCES.recencyHalfLifeDays,
  }
}

/** Proper-noun phrases, for items too short to digest. "Annika Phillips", "LSE". */
function quickEntities(text) {
  const out = new Set()
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|[A-Z]{2,6})\b/g
  for (const m of String(text).matchAll(re)) {
    const e = m[1]
    if (/^(The|This|That|When|What|Who|And|But|For|Mon|Tue|Wed|Thu|Fri|Sat|Sun|I|AM|PM|OK)\b/.test(e)) continue
    out.add(e)
  }
  return [...out].slice(0, 6)
}

/** The date an item is about: an ISO date in its name or first line, else its mtime. */
function dateOf(name, text, mtimeMs) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name) ?? /\[(\d{4}-\d{2}-\d{2})\]/.exec(String(text).slice(0, 200))
  if (m) return new Date(`${m[1]}T12:00:00`).toISOString()
  return new Date(mtimeMs || Date.now()).toISOString()
}

export function createBrain({ log = console.log, model = 'claude-haiku-5-5' } = {}) {
  const events = new EventEmitter()
  /** id -> record. See `upsert` for the shape. */
  const records = new Map()
  const bm = new Bm25()
  let sources = readSources()
  let graphCache = null
  let version = 0
  let saveTimer = null
  let scanning = false
  let digesting = false
  let busyUntil = 0
  let lastScan = null
  let lastError = null
  const sourceStats = new Map()
  const digestFailures = new Map()

  // -- persistence ----------------------------------------------------------

  function load() {
    try {
      const raw = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))
      if (raw.version !== INDEX_VERSION) return
      for (const r of raw.records ?? []) {
        records.set(r.id, r)
        index(r)
      }
      lastScan = raw.lastScan ?? null
    } catch {
      /* first run, or a corrupt index — it rebuilds */
    }
  }

  function save() {
    if (saveTimer) return
    saveTimer = setTimeout(async () => {
      saveTimer = null
      const tmp = `${INDEX_FILE}.${process.pid}.tmp`
      try {
        mkdirSync(PATHS.brain, { recursive: true })
        await writeFile(
          tmp,
          JSON.stringify({ version: INDEX_VERSION, lastScan, records: [...records.values()] }),
        )
        renameSync(tmp, INDEX_FILE)
      } catch (err) {
        log(`[brain] could not save the index: ${err.message}`)
      }
    }, 2500)
    saveTimer.unref?.()
  }

  const changed = () => {
    graphCache = null
    version++
    save()
    events.emit('change', version)
  }

  // -- indexing -------------------------------------------------------------

  function index(r) {
    const d = r.digest
    bm.set(r.id, [
      [r.title, 3],
      [r.hub?.replace(/\//g, ' '), 1],
      [d?.summary, 2],
      [d?.questions?.join(' '), 2],
      [[...(d?.tags ?? []), ...(d?.entities ?? r.entities ?? [])].join(' '), 2],
      [d?.atoms?.join(' '), 1.5],
      [r.text, 1],
    ])
  }

  /**
   * Insert or refresh one item. Returns true when its content changed — which
   * is what queues it for a fresh digest.
   */
  function upsert(r) {
    const prev = records.get(r.id)
    const hash = sha(`${r.title}\n${r.text}`)
    if (prev && prev.hash === hash && prev.hub === r.hub) {
      if (prev.mtime !== r.mtime) prev.mtime = r.mtime
      return false
    }
    const short = (r.text ?? '').length < SHORT
    const record = {
      id: r.id,
      kind: r.kind,
      title: r.title,
      hub: r.hub,
      path: r.path ?? null,
      date: r.date,
      mtime: r.mtime ?? Date.now(),
      size: r.size ?? (r.text ?? '').length,
      hash,
      text: r.text ?? '',
      links: r.links ?? [],
      entities: short ? quickEntities(r.text) : prev?.entities ?? [],
      // A short item needs no model to summarise it; a changed long one keeps
      // its old digest until the new one lands, so search never goes blind.
      digest: short ? null : prev?.digest ?? null,
      digestHash: short ? hash : prev?.digestHash ?? null,
    }
    records.set(record.id, record)
    index(record)
    return true
  }

  function drop(id) {
    if (!records.delete(id)) return false
    bm.remove(id)
    return true
  }

  // -- connectors -----------------------------------------------------------

  /** memory/facts.md, one item per fact, plus the profile and the rules. */
  async function scanMemory() {
    const seen = new Set()
    let dirty = false
    const facts = await readFile(PATHS.facts, 'utf8').catch(() => '')
    for (const line of facts.split('\n')) {
      const m = /^- (?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.+)$/.exec(line.trim())
      if (!m) continue
      const text = m[2].trim()
      const id = idFor('fact', text)
      seen.add(id)
      dirty =
        upsert({
          id,
          kind: 'fact',
          title: text.length > 90 ? text.slice(0, 88) + '…' : text,
          hub: 'Memory',
          path: PATHS.facts,
          date: m[1] ? new Date(`${m[1]}T12:00:00`).toISOString() : new Date().toISOString(),
          text,
        }) || dirty
    }
    for (const [file, title] of [
      [PATHS.aboutMe, 'About you'],
      [PATHS.rules, 'Standing rules'],
    ]) {
      const raw = await readFile(file, 'utf8').catch(() => '')
      const text = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
      const hasBody = text.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))
      if (!hasBody) continue
      const id = idFor('profile', file)
      seen.add(id)
      const info = await stat(file).catch(() => null)
      dirty =
        upsert({ id, kind: 'profile', title, hub: 'Memory', path: file, date: new Date(info?.mtimeMs ?? Date.now()).toISOString(), mtime: info?.mtimeMs, text }) || dirty
    }
    for (const r of [...records.values()]) {
      if ((r.kind === 'fact' || r.kind === 'profile') && !seen.has(r.id)) dirty = drop(r.id) || dirty
    }
    sourceStats.set('Memory', { name: 'Memory', path: dirname(PATHS.facts), items: seen.size, kind: 'memory' })
    return dirty
  }

  /**
   * Walk a folder for documents. Breadth-first with a depth cap, skipping
   * hidden folders, excluded names, app bundles and anything that is a code
   * repository — a .git folder means the files inside are source, not notes,
   * and the user has better tools for those.
   */
  async function walk(root, { maxDepth, exclude, onlyText = false }) {
    const found = []
    const queue = [[root, 0]]
    while (queue.length) {
      const [dir, depth] = queue.shift()
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      if (depth > 0 && entries.some((e) => e.name === '.git')) continue
      for (const e of entries) {
        if (e.name.startsWith('.') || exclude.has(e.name)) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (/\.(app|photoslibrary|bundle|framework|xcodeproj|pkg)$/i.test(e.name)) continue
          if (depth < maxDepth) queue.push([full, depth + 1])
        } else if (e.isFile()) {
          const k = kindOf(e.name)
          if (onlyText ? k === 'md' || k === 'txt' || k === 'markdown' : READERS[k]) found.push(full)
        }
      }
    }
    return found
  }

  /** Read files in small parallel groups — extraction spawns processes. */
  async function eachLimited(items, n, fn) {
    let i = 0
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++])
    })
    await Promise.all(workers)
  }

  /**
   * One folder source. Only files whose size or mtime moved are read again,
   * so a rescan of an unchanged Desktop costs a directory walk and nothing
   * else.
   */
  async function scanFolder({ name, root, kind, recursive = true, onlyText = false, hubOf }) {
    const files = recursive
      ? await walk(root, { maxDepth: sources.maxDepth, exclude: sources.exclude, onlyText })
      : (await readdir(root).catch(() => []))
          .filter((f) => !f.startsWith('.') && /\.(md|txt)$/i.test(f))
          .map((f) => join(root, f))
    const infos = []
    for (const path of files) {
      const info = await stat(path).catch(() => null)
      if (info?.isFile()) infos.push({ path, mtime: info.mtimeMs, size: info.size })
    }
    // Newest first, so a cap keeps what is current rather than what is oldest.
    infos.sort((a, b) => b.mtime - a.mtime)
    const keep = infos.slice(0, sources.maxFiles)
    const seen = new Set()
    let dirty = false
    await eachLimited(keep, 3, async ({ path, mtime, size }) => {
      const id = idFor(kind === 'file' ? 'file' : kind, path)
      seen.add(id)
      const prev = records.get(id)
      if (prev && prev.mtime === mtime && prev.size === size) return
      const text = size > 60 * 1024 * 1024 ? '' : await extractText(path)
      const file = basename(path)
      const plain = file.replace(/\.[^.]+$/, '')
      const changedNow = upsert({
        id,
        kind,
        title: kind === 'file' ? plain : titleFrom(text, plain),
        hub: hubOf(path),
        path,
        date: dateOf(file, text, mtime),
        mtime,
        size,
        text,
        links: kind === 'note' ? wikiLinks(text) : [],
      })
      // Same words, new mtime: remember the stat so it is not read again.
      const r = records.get(id)
      r.mtime = mtime
      r.size = size
      dirty = changedNow || dirty
    })
    for (const r of [...records.values()]) {
      if (r.kind === kind && r.hub?.split('/')[0] === name && !seen.has(r.id)) dirty = drop(r.id) || dirty
    }
    sourceStats.set(name, { name, path: root, items: seen.size, found: infos.length, kind })
    return dirty
  }

  const hubWithin = (name, root) => (path) => {
    const rel = relative(root, dirname(path))
    if (!rel || rel.startsWith('..')) return name
    // Two levels of folder is enough structure for a map; deeper collapses up.
    return [name, ...rel.split(sep).slice(0, 2)].join('/')
  }

  async function scanAll(reason = 'scan') {
    if (scanning) return
    scanning = true
    const started = Date.now()
    sources = readSources()
    let dirty = false
    try {
      dirty = (await scanMemory()) || dirty
      for (const own of OWN.filter((o) => o.dir)) {
        const root = own.dir()
        mkdirSync(root, { recursive: true })
        dirty =
          (await scanFolder({
            name: own.name,
            root,
            kind: own.kind,
            recursive: Boolean(own.recursive),
            onlyText: true,
            hubOf: own.recursive ? hubWithin(own.name, root) : () => own.name,
          })) || dirty
      }
      const live = new Set(['Memory', ...OWN.map((o) => o.name)])
      for (const f of sources.folders) {
        if (!existsSync(f.path)) continue
        live.add(f.name)
        dirty =
          (await scanFolder({ name: f.name, root: f.path, kind: 'file', hubOf: hubWithin(f.name, f.path) })) || dirty
      }
      // A folder taken out of sources.json takes its items with it.
      for (const r of [...records.values()]) {
        if (r.kind === 'file' && !live.has(r.hub?.split('/')[0])) dirty = drop(r.id) || dirty
      }
      for (const name of [...sourceStats.keys()]) if (!live.has(name)) sourceStats.delete(name)
      lastScan = new Date().toISOString()
      lastError = null
      log(`[brain] ${reason}: ${records.size} items in ${Date.now() - started}ms${dirty ? ' (changed)' : ''}`)
    } catch (err) {
      lastError = String(err?.message ?? err)
      log(`[brain] scan failed: ${lastError}`)
    } finally {
      scanning = false
    }
    if (dirty) changed()
    void digestPending()
  }

  /** Rescan just Emrys’s own writing — after he remembers something, say. */
  async function scanOwn() {
    let dirty = await scanMemory()
    for (const own of OWN.filter((o) => o.dir)) {
      const root = own.dir()
      dirty =
        (await scanFolder({
          name: own.name,
          root,
          kind: own.kind,
          recursive: Boolean(own.recursive),
          onlyText: true,
          hubOf: own.recursive ? hubWithin(own.name, root) : () => own.name,
        })) || dirty
    }
    if (dirty) changed()
    void digestPending()
    return dirty
  }

  // -- digest ---------------------------------------------------------------

  const needsDigest = (r, now) =>
    sources.digest &&
    r.digestHash !== r.hash &&
    (r.text?.length ?? 0) >= SHORT &&
    now - (r.mtime ?? 0) > ((r.kind === 'conversation' || r.kind === 'journal') ? SETTLE_MS : 0) &&
    (digestFailures.get(r.id) ?? 0) < 3

  async function digestPending() {
    if (digesting) return
    digesting = true
    try {
      for (;;) {
        // Never compete with a turn in progress for the machine or the account.
        if (Date.now() < busyUntil) {
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }
        const now = Date.now()
        const todo = [...records.values()]
          .filter((r) => needsDigest(r, now))
          // Emrys’s own material first, then the newest documents.
          .sort((a, b) => (a.kind === 'file') - (b.kind === 'file') || b.mtime - a.mtime)
          .slice(0, DIGEST_BATCH)
        if (!todo.length) break
        const docs = todo.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          date: r.date.slice(0, 10),
          where: r.hub,
          text: excerpt(r.text, todo.length > 3 ? 3000 : 5000),
        }))
        let got
        try {
          got = await digestBatch(docs, { model })
        } catch (err) {
          lastError = `digest: ${err?.message ?? err}`
          log(`[brain] ${lastError}`)
          got = new Map()
        }
        let landed = 0
        for (const r of todo) {
          const d = got.get(r.id)
          const live = records.get(r.id)
          if (!live) continue
          if (!d) {
            digestFailures.set(r.id, (digestFailures.get(r.id) ?? 0) + 1)
            continue
          }
          live.digest = { ...d, at: new Date().toISOString() }
          live.digestHash = r.hash
          live.entities = d.entities
          index(live)
          landed++
        }
        if (landed) changed()
        if (!landed && !got.size) await new Promise((r) => setTimeout(r, 20_000))
      }
    } finally {
      digesting = false
    }
  }

  // -- search ---------------------------------------------------------------

  const publicRecord = (r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    hub: r.hub,
    date: r.date,
    path: r.path,
  })

  function search(q, { limit = 8, kinds = null } = {}) {
    const { scores, terms: qt } = bm.score(q)
    const now = Date.now()
    const hits = []
    for (const [id, { score, matched }] of scores) {
      const r = records.get(id)
      if (!r || (kinds && !kinds.includes(r.kind))) continue
      const age = Math.max(0, (now - Date.parse(r.date)) / DAY)
      // Recency weighting: a fresh item is worth up to a third more than a stale
      // one with the same words in it. Profile and rules never go stale.
      const fresh = r.kind === 'profile' ? 1 : 0.75 + 0.25 * Math.pow(0.5, age / sources.halfLife)
      hits.push({ r, score: score * fresh, matched })
    }
    hits.sort((a, b) => b.score - a.score)
    return {
      terms: qt,
      hits: hits.slice(0, limit).map(({ r, score, matched }) => {
        const d = r.digest
        const pool = [d?.summary, ...(d?.atoms ?? []), r.text].filter(Boolean).join('\n')
        return {
          ...publicRecord(r),
          score: Math.round(score * 100) / 100,
          matched,
          summary: d?.summary ?? (r.text.length < SHORT ? r.text : ''),
          snippet: bestSentence(pool, q),
        }
      }),
    }
  }

  /**
   * What to put in front of the model before it answers — or nothing.
   *
   * Cheap enough to run on every turn, so the bar is about precision: most
   * things said to an assistant are not about the notes, and a weak match
   * stapled to "how are you" is noise the model then has to ignore. A hit has
   * to match well in absolute terms, be close to the best one, and — for a
   * question of any length — share more than one word with it.
   */
  function recallFor(text, limit = 4) {
    const { hits, terms: qt } = search(text, { limit: 8 })
    if (!hits.length || !qt.length) return []
    const top = hits[0].score
    const floor = qt.length === 1 ? 4 : 3
    if (top < floor) return []
    return hits
      .filter((h) => h.score >= top * 0.45 && (qt.length < 2 || h.matched >= 2))
      .slice(0, limit)
  }

  function get(id) {
    const r = records.get(id)
    if (!r) return null
    return {
      ...publicRecord(r),
      text: r.text,
      digest: r.digest,
      entities: r.entities,
      links: r.links,
      size: r.size,
      neighbours: neighboursOf(id),
    }
  }

  // -- graph ----------------------------------------------------------------

  /** Normalised entity key, so "Annika" and "annika" are one person on the map. */
  const entKey = (e) => e.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  function buildGraph() {
    const nodes = []
    const links = []
    const at = new Map()
    const add = (n) => {
      at.set(n.id, nodes.length)
      nodes.push(n)
    }
    const link = (a, b) => {
      if (at.has(a) && at.has(b) && a !== b) links.push([at.get(a), at.get(b)])
    }

    add({ id: 'core', label: 'Emrys', kind: 'core', group: 'core' })

    // Hubs: every source, and every folder that holds something.
    const hubs = new Set()
    for (const r of records.values()) {
      const parts = (r.hub ?? 'Memory').split('/')
      for (let i = 1; i <= parts.length; i++) hubs.add(parts.slice(0, i).join('/'))
    }
    for (const name of [...OWN.map((o) => o.name), ...sources.folders.map((f) => f.name)]) {
      if (sourceStats.get(name)?.items || [...records.values()].some((r) => r.hub?.split('/')[0] === name)) hubs.add(name)
    }
    for (const h of [...hubs].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const parts = h.split('/')
      add({ id: `hub:${h}`, label: parts.at(-1), kind: 'hub', group: parts[0], depth: parts.length })
      link(parts.length === 1 ? 'core' : `hub:${parts.slice(0, -1).join('/')}`, `hub:${h}`)
    }

    // Items.
    const byTitle = new Map()
    for (const r of records.values()) {
      add({ id: r.id, label: r.title, kind: r.kind, group: (r.hub ?? 'Memory').split('/')[0], date: r.date.slice(0, 10) })
      link(`hub:${r.hub ?? 'Memory'}`, r.id)
      byTitle.set(r.title.toLowerCase(), r.id)
      if (r.path) byTitle.set(basename(r.path).replace(/\.[^.]+$/, '').toLowerCase(), r.id)
    }
    for (const r of records.values()) for (const l of r.links ?? []) link(r.id, byTitle.get(l))

    // Entities — the people, projects and places that tie items together. Only
    // ones mentioned in two or more places earn a node, or one a fact names.
    const ents = new Map()
    for (const r of records.values()) {
      for (const e of r.entities ?? []) {
        const k = entKey(e)
        if (k.length < 2) continue
        const slot = ents.get(k) ?? { label: e, ids: new Set(), fact: false }
        slot.ids.add(r.id)
        if (r.kind === 'fact') slot.fact = true
        ents.set(k, slot)
      }
    }
    const keep = [...ents.entries()]
      .filter(([, s]) => s.ids.size >= 2 || s.fact)
      .sort((a, b) => b[1].ids.size - a[1].ids.size)
      .slice(0, 160)
    for (const [k, s] of keep) {
      const id = `ent:${k}`
      add({ id, label: s.label, kind: 'entity', group: 'entity', weight: s.ids.size })
      for (const rid of s.ids) link(id, rid)
    }

    return { version, nodes, links }
  }

  function graph() {
    if (!graphCache) graphCache = buildGraph()
    return graphCache
  }

  function neighboursOf(id) {
    const g = graph()
    const idx = g.nodes.findIndex((n) => n.id === id)
    if (idx === -1) return []
    const out = []
    for (const [a, b] of g.links) {
      const other = a === idx ? b : b === idx ? a : -1
      if (other !== -1) out.push({ id: g.nodes[other].id, label: g.nodes[other].label, kind: g.nodes[other].kind })
    }
    return out.slice(0, 40)
  }

  // -- writing --------------------------------------------------------------

  const slug = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'note'

  /** A new note in the vault, or appended to one of the same title. */
  async function writeNote({ title, body, folder = '' }) {
    const safeFolder = String(folder ?? '')
      .split(/[\\/]+/)
      .map(slug)
      .filter((p) => p && p !== 'note')
      .join('/')
    const dir = join(PATHS.notes, safeFolder)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${slug(title)}.md`)
    const stamp = `*${localDate()}*`
    if (existsSync(file)) {
      const prev = await readFile(file, 'utf8')
      await writeFile(file, `${prev.trimEnd()}\n\n${stamp}\n\n${String(body).trim()}\n`)
    } else {
      await writeFile(file, `# ${String(title).trim()}\n\n${stamp}\n\n${String(body).trim()}\n`)
    }
    await scanOwn()
    return { path: file, id: idFor('note', file) }
  }

  // -- life -----------------------------------------------------------------

  const watchers = []
  function watchOwn() {
    let timer = null
    const poke = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void scanOwn(), 1500)
    }
    // Markdown only: state.json and the logs change on every turn and are not
    // anything the brain reads.
    const onChange = (_event, file) => {
      if (!file || /\.(md|markdown|txt)$/i.test(String(file))) poke()
    }
    for (const dir of [PATHS.notes, dirname(PATHS.facts), PATHS.briefings, PATHS.conversations, HOME]) {
      try {
        mkdirSync(dir, { recursive: true })
        watchers.push(watch(dir, { recursive: dir === PATHS.notes }, onChange))
      } catch {
        /* polling covers it */
      }
    }
  }

  function start() {
    load()
    if (records.size) log(`[brain] loaded ${records.size} items`)
    void scanAll('first scan')
    watchOwn()
    setInterval(() => void scanAll('rescan'), RESCAN_MS).unref()
    // sources.json edits apply within a minute.
    let sourcesSeen = existsSync(PATHS.sources) ? readFileSync(PATHS.sources, 'utf8') : ''
    setInterval(() => {
      const now = existsSync(PATHS.sources) ? readFileSync(PATHS.sources, 'utf8') : ''
      if (now !== sourcesSeen) {
        sourcesSeen = now
        void scanAll('sources changed')
      }
    }, 60_000).unref()
  }

  function status() {
    const all = [...records.values()]
    const now = Date.now()
    return {
      items: all.length,
      digested: all.filter((r) => r.digest || (r.text?.length ?? 0) < SHORT).length,
      pending: all.filter((r) => needsDigest(r, now)).length,
      digest: sources.digest ? model : 'off',
      scanning,
      digesting,
      lastScan,
      lastError,
      sources: [...sourceStats.values()],
      graph: { version, nodes: graph().nodes.length, links: graph().links.length },
    }
  }

  /** A sentence for the system prompt: what the brain holds, so Emrys knows to use it. */
  function overview() {
    const counts = {}
    for (const r of records.values()) counts[r.hub?.split('/')[0] ?? 'Memory'] = (counts[r.hub?.split('/')[0] ?? 'Memory'] ?? 0) + 1
    return Object.entries(counts)
      .map(([k, n]) => `${k} (${n})`)
      .join(', ')
  }

  return {
    start,
    search,
    recallFor,
    get,
    graph,
    status,
    overview,
    writeNote,
    scanOwn,
    rescan: () => scanAll('requested'),
    /** Hold digesting off while a turn is being answered. */
    busy: (ms = 20_000) => {
      busyUntil = Date.now() + ms
    },
    idle: () => {
      busyUntil = 0
    },
    on: (ev, fn) => events.on(ev, fn),
    get version() {
      return version
    },
    terms,
  }
}
