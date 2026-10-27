/**
 * The voice, in a thread of its own.
 *
 * Kokoro — an 82M-parameter neural text-to-speech model — running on the CPU
 * through onnxruntime. On Apple silicon at full precision it speaks about eight
 * times faster than real time, so a ten-word sentence is ready in a few hundred
 * milliseconds, and it sounds like a person rather than a screen reader.
 *
 * It runs in a worker because generating a sentence keeps a core busy for that
 * long, and the main thread is pumping the conversation's tokens to the
 * browser: blocking it would stall the very answer being spoken.
 */

import { parentPort } from 'node:worker_threads'
import { KokoroTTS } from 'kokoro-js'

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'

let tts = null

/** 16-bit PCM WAV — what every browser plays without a decoder dance. */
function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

async function load() {
  const started = Date.now()
  tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'cpu' })
  // The first generation pays for graph optimisation. Pay it now, not on the
  // first thing anyone says.
  await tts.generate('Ready.', { voice: 'bm_george' })
  parentPort.postMessage({ type: 'ready', ms: Date.now() - started, voices: Object.keys(tts.voices ?? {}) })
}

parentPort.on('message', async (msg) => {
  if (msg?.type !== 'speak') return
  try {
    if (!tts) throw new Error('voice not loaded')
    const audio = await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed ?? 1 })
    const buf = wav(audio.audio, audio.sampling_rate)
    parentPort.postMessage({ type: 'audio', id: msg.id, wav: buf }, [buf.buffer])
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(err?.message ?? err) })
  }
})

load().catch((err) => parentPort.postMessage({ type: 'failed', message: String(err?.message ?? err) }))
