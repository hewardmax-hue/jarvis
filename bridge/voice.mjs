/**
 * Jett’s own voice, served by the core.
 *
 * The browser asks for one sentence at a time (POST /speak) and plays the WAV
 * that comes back; the next sentence is generated while this one plays. When
 * the model is not ready — the first ever start downloads it, about 330MB — or
 * it fails, /health says so and the browser speaks with the system voice
 * instead, so he is never silent.
 *
 * Two things keep it quick. Every sentence he has said is kept on disk under
 * its hash, so "Done." and "Right away." — the lines he says all day — cost a
 * file read the second time. And an idle engine is nudged every ten minutes,
 * because one that has sat untouched for an hour is paged out, and the first
 * sentence after it is the one that would stall.
 */

import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from './home.mjs'

const CACHE = join(PATHS.cache, 'voice')
/** Short lines repeat; a paragraph of an answer never will. */
const CACHE_MAX_CHARS = 220
const CACHE_MAX_FILES = 1500
const WARM_AFTER_MS = 10 * 60_000

/** The voices worth offering: natural first, then character. */
export const VOICES = [
  { id: 'bm_george', label: 'George', accent: 'British' },
  { id: 'bm_fable', label: 'Fable', accent: 'British' },
  { id: 'am_michael', label: 'Michael', accent: 'American' },
  { id: 'am_fenrir', label: 'Fenrir', accent: 'American' },
  { id: 'am_puck', label: 'Puck', accent: 'American' },
  { id: 'bm_lewis', label: 'Lewis', accent: 'British' },
  { id: 'bf_emma', label: 'Emma', accent: 'British' },
  { id: 'af_heart', label: 'Heart', accent: 'American' },
  { id: 'af_bella', label: 'Bella', accent: 'American' },
]

export const DEFAULT_VOICE = process.env.JETT_VOICE ?? 'bm_george'

export function createVoice({ log = console.log } = {}) {
  let worker = null
  let ready = false
  let failed = null
  let restarts = 0
  let seq = 0
  const pending = new Map()
  /** One sentence at a time: onnxruntime already uses every core for one. */
  let chain = Promise.resolve()
  let lastUsed = Date.now()
  const stats = { hits: 0, made: 0, warmed: 0 }

  const keyFor = (text, voice, speed) =>
    createHash('sha1').update(`${voice}|${Number(speed).toFixed(2)}|${text}`).digest('hex')

  function cached(key) {
    try {
      const file = join(CACHE, `${key}.wav`)
      const wav = readFileSync(file)
      // Touched on use, so pruning drops what he no longer says.
      const now = new Date()
      utimesSync(file, now, now)
      return wav
    } catch {
      return null
    }
  }

  function keep(key, wav) {
    try {
      mkdirSync(CACHE, { recursive: true })
      const tmp = join(CACHE, `${key}.${process.pid}.tmp`)
      writeFileSync(tmp, wav)
      renameSync(tmp, join(CACHE, `${key}.wav`))
      if (++stats.made % 100 === 0) prune()
    } catch {
      // A cache that cannot be written is only a cache.
    }
  }

  function prune() {
    try {
      const files = readdirSync(CACHE)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => ({ f, at: statSync(join(CACHE, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
      for (const { f } of files.slice(CACHE_MAX_FILES)) unlinkSync(join(CACHE, f))
    } catch {
      // nothing to prune
    }
  }

  function boot() {
    if (process.env.JETT_VOICE_ENGINE === 'off') {
      failed = 'disabled'
      return
    }
    worker = new Worker(new URL('./voice-worker.mjs', import.meta.url))
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        ready = true
        failed = null
        lastUsed = Date.now()
        log(`[voice] natural voice ready in ${msg.ms}ms`)
      } else if (msg.type === 'failed') {
        failed = msg.message
        log(`[voice] natural voice unavailable: ${msg.message}`)
      } else if (msg.type === 'audio' || msg.type === 'error') {
        const slot = pending.get(msg.id)
        if (!slot) return
        pending.delete(msg.id)
        if (msg.type === 'audio') slot.resolve(Buffer.from(msg.wav))
        else slot.reject(new Error(msg.message))
      }
    })
    worker.on('error', (err) => log(`[voice] worker error: ${err.message}`))
    worker.on('exit', (code) => {
      ready = false
      for (const slot of pending.values()) slot.reject(new Error('voice worker stopped'))
      pending.clear()
      if (code !== 0 && restarts < 3) {
        restarts++
        log(`[voice] worker exited (${code}); restarting`)
        setTimeout(boot, 1000 * restarts)
      }
    })
  }

  /**
   * `alive` is asked just before generation starts: a sentence from an answer
   * that was interrupted while it waited in line is skipped, not spoken late.
   */
  function speak(text, voice = DEFAULT_VOICE, speed = 1, alive = () => true) {
    const known = VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE
    const line = String(text).slice(0, 1200)
    const cacheable = line.length <= CACHE_MAX_CHARS
    const key = cacheable ? keyFor(line, known, speed) : ''
    if (cacheable) {
      const wav = cached(key)
      if (wav) {
        stats.hits++
        return Promise.resolve(wav)
      }
    }
    if (!ready || !worker) return Promise.reject(new Error(failed ?? 'voice not ready'))
    return generate(line, known, speed, alive).then((wav) => {
      if (cacheable) keep(key, wav)
      return wav
    })
  }

  function generate(text, known, speed, alive) {
    lastUsed = Date.now()
    const run = () =>
      new Promise((resolve, reject) => {
        if (!alive()) return reject(new Error('cancelled'))
        const id = ++seq
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('voice timed out'))
        }, 20_000)
        pending.set(id, {
          resolve: (b) => (clearTimeout(timer), resolve(b)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        })
        worker.postMessage({ type: 'speak', id, text, voice: known, speed })
      })
    const job = chain.then(run, run)
    chain = job.catch(() => {})
    return job
  }

  /** A word nobody hears, so the next sentence somebody does starts at once. */
  function keepWarm() {
    if (!ready || !worker || Date.now() - lastUsed < WARM_AFTER_MS) return
    const began = Date.now()
    generate('Ready.', DEFAULT_VOICE, 1, () => true).then(
      () => {
        stats.warmed++
        const ms = Date.now() - began
        if (ms > 1500) log(`[voice] warmed after idling (${ms}ms — it had gone cold)`)
      },
      () => {},
    )
  }

  return {
    start: () => {
      boot()
      setInterval(keepWarm, 60_000).unref()
    },
    speak,
    get ready() {
      return ready
    },
    status: () => ({ engine: 'kokoro', ready, failed, voices: VOICES, default: DEFAULT_VOICE, cache: { ...stats } }),
  }
}
