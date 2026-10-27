/**
 * Words, for searching.
 *
 * The second brain is searched with BM25 over plain text — no embeddings, no
 * vector store. It is fast enough to run before every single turn without
 * anyone noticing, it is predictable, and with a model on the other end that
 * can rephrase and search again it finds what matters. What makes plain text
 * search work this well is what goes into it: every item carries a summary, the
 * questions it answers, and its atoms (see digest.mjs), so the words a person
 * would actually use to ask are already in the index.
 */

const STOP = new Set(
  `a about above after again against all am an and any are aren't as at be because been
  before being below between both but by can can't cannot could couldn't did didn't do does
  doesn't doing don't down during each few for from further had hadn't has hasn't have
  haven't having he he'd he'll he's her here here's hers herself him himself his how how's
  i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my
  myself no nor not of off on once only or other ought our ours ourselves out over own same
  shan't she she'd she'll she's should shouldn't so some such than that that's the their
  theirs them themselves then there there's these they they'd they'll they're they've this
  those through to too under until up very was wasn't we we'd we'll we're we've were weren't
  what what's when when's where where's which while who who's whom why why's with won't
  would wouldn't you you'd you'll you're you've your yours yourself yourselves
  also just like get got please tell show give find pull up open look know want need make
  hey emrys jarvis okay ok yeah yes thanks thank really could would something anything
  me mine us ya gonna wanna let lets right now doing going fine good great well sure think
  thing things stuff bit lot much many maybe actually kind sort mean said say says go
  hello hi morning evening afternoon night today tonight tomorrow yesterday
  use using write put into word words`.split(/\s+/),
)

/**
 * A light stemmer. Porter is overkill for this and mangles names; this folds
 * the plural and tense endings that actually stop "invoice" finding "invoices"
 * and "meeting" finding "meetings", and leaves short words and names alone.
 */
export function stem(word) {
  if (word.length <= 4) return word
  if (word.endsWith('ies') && word.length > 5) return word.slice(0, -3) + 'y'
  if (word.endsWith('sses')) return word.slice(0, -2)
  if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3)
  if (word.endsWith('ed') && word.length > 5 && !word.endsWith('eed')) return word.slice(0, -2)
  if (word.endsWith('es') && /(ch|sh|x|ss|zz)es$/.test(word)) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) {
    return word.slice(0, -1)
  }
  return word
}

/** Lowercase terms, stop words out, stemmed. Numbers are kept — they are often the point. */
export function terms(text) {
  const out = []
  const words = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .match(/[a-z0-9][a-z0-9'’]*/g)
  if (!words) return out
  for (let w of words) {
    w = w.replace(/['’]s$/, '').replace(/['’]/g, '')
    if (w.length < 2 || STOP.has(w)) continue
    out.push(stem(w))
  }
  return out
}

/**
 * BM25 over weighted fields.
 *
 * A document is several fields — title, summary, questions, atoms, body — and a
 * hit in the title is worth more than a hit in the body. Rather than score each
 * field separately, term frequencies are summed with the field's weight
 * (BM25F-lite), which keeps one inverted index and one pass per query.
 */
export class Bm25 {
  constructor({ k1 = 1.2, b = 0.72 } = {}) {
    this.k1 = k1
    this.b = b
    this.docs = new Map() // id -> { tf: Map<term, weight>, len }
    this.df = new Map() // term -> doc count
    this.totalLen = 0
  }

  get size() {
    return this.docs.size
  }

  /** fields: [[text, weight], ...] */
  set(id, fields) {
    this.remove(id)
    const tf = new Map()
    let len = 0
    for (const [text, weight] of fields) {
      if (!text) continue
      for (const t of terms(text)) {
        tf.set(t, (tf.get(t) ?? 0) + weight)
        len += weight
      }
    }
    this.docs.set(id, { tf, len })
    this.totalLen += len
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
  }

  remove(id) {
    const doc = this.docs.get(id)
    if (!doc) return
    this.docs.delete(id)
    this.totalLen -= doc.len
    for (const t of doc.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1
      if (n <= 0) this.df.delete(t)
      else this.df.set(t, n)
    }
  }

  idf(term) {
    const n = this.docs.size
    const df = this.df.get(term) ?? 0
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  /**
   * Scores for every document matching at least one query term, plus how many
   * distinct query terms each one matched — a single common word matching is
   * weak evidence, and the caller uses `matched` to tell.
   */
  score(query) {
    const q = [...new Set(terms(query))]
    const out = new Map()
    if (!q.length || !this.docs.size) return { scores: out, terms: q }
    const avg = this.totalLen / this.docs.size || 1
    const idfs = q.map((t) => this.idf(t))
    for (const [id, doc] of this.docs) {
      let s = 0
      let matched = 0
      for (let i = 0; i < q.length; i++) {
        const f = doc.tf.get(q[i])
        if (!f) continue
        matched++
        s += idfs[i] * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.len) / avg)))
      }
      if (s > 0) out.set(id, { score: s, matched })
    }
    return { scores: out, terms: q }
  }
}

/** The sentence in `text` that shares the most terms with the query — the snippet. */
export function bestSentence(text, query, max = 220) {
  const want = new Set(terms(query))
  if (!text) return ''
  const sentences = String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => s.trim().length > 12)
  let best = sentences[0] ?? ''
  let top = -1
  for (const s of sentences.slice(0, 400)) {
    const hits = terms(s).filter((t) => want.has(t)).length
    if (hits > top) {
      top = hits
      best = s
    }
  }
  return best.length > max ? best.slice(0, max - 1) + '…' : best
}
