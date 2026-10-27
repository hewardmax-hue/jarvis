/**
 * Emrys’s own voice, served by the core.
 *
 * The browser asks for one sentence at a time (POST /speak) and plays the WAV
 * that comes back; the next sentence is generated while this one plays. When
 * the model is not ready — the first ever start downloads it, about 330MB — or
 * it fails, /health says so and the browser speaks with the system voice
 * instead, so he is never silent.
 */

import { Worker } from 'node:worker_threads'

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

export const DEFAULT_VOICE = process.env.EMRYS_VOICE ?? 'bm_george'

export function createVoice({ log = console.log } = {}) {
  let worker = null
  let ready = false
  let failed = null
  let restarts = 0
  let seq = 0
  const pending = new Map()
  /** One sentence at a time: onnxruntime already uses every core for one. */
  let chain = Promise.resolve()

  function boot() {
    if (process.env.EMRYS_VOICE_ENGINE === 'off') {
      failed = 'disabled'
      return
    }
    worker = new Worker(new URL('./voice-worker.mjs', import.meta.url))
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        ready = true
        failed = null
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
    if (!ready || !worker) return Promise.reject(new Error(failed ?? 'voice not ready'))
    const known = VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE
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
        worker.postMessage({ type: 'speak', id, text: String(text).slice(0, 1200), voice: known, speed })
      })
    const job = chain.then(run, run)
    chain = job.catch(() => {})
    return job
  }

  return {
    start: boot,
    speak,
    get ready() {
      return ready
    },
    status: () => ({ engine: 'kokoro', ready, failed, voices: VOICES, default: DEFAULT_VOICE }),
  }
}
