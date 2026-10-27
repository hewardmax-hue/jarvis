import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, phaseColor, type Phase } from '../store'
import { PUSH_TO_TALK } from '../config'

/**
 * Emrys, present.
 *
 * A small orb at the foot of the map: it breathes at rest, follows your voice
 * while you talk and his while he answers, and changes colour with what he is
 * doing. Under it, what he is doing in words, and while you speak, your words
 * as they are heard — so you can see he got it before he answers.
 *
 * Drawn on a small 2D canvas from the store's level, outside React's render
 * cycle, so sixty frames a second of breathing never re-renders a component.
 */

const STATUS: Record<Phase, string> = {
  offline: 'Offline',
  boot: 'Connecting',
  dormant: PUSH_TO_TALK ? 'Hold ⌥ to talk, or type' : 'Say “Emrys”, or type',
  waking: 'Yes?',
  listening: 'Listening',
  thinking: 'Thinking',
  tooling: 'Working',
  speaking: 'Speaking',
}

export function Presence() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const activeTool = useStore((s) => s.activeTool)
  const looking = useStore((s) => s.looking)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const SIZE = 132
    el.width = SIZE * dpr
    el.height = SIZE * dpr
    ctx.scale(dpr, dpr)

    let raf = 0
    let level = 0
    let hue = phaseColor.dormant
    const draw = (t: number) => {
      const st = useStore.getState()
      level += (st.level - level) * 0.25
      hue = st.accent && st.phase === 'dormant' ? st.accent : phaseColor[st.phase]
      const busy = st.phase === 'thinking' || st.phase === 'tooling'
      const time = t / 1000
      const breathe = 0.5 + 0.5 * Math.sin(time * (busy ? 3.2 : 1.1))
      const r = 24 + level * 12 + breathe * (busy ? 3 : 2)
      const c = SIZE / 2

      ctx.clearRect(0, 0, SIZE, SIZE)
      // Halo.
      // Kept inside the canvas: a glow cut off by its own edge shows as a square.
      const reach = Math.min(r * 2.2, c - 1)
      const halo = ctx.createRadialGradient(c, c, r * 0.3, c, c, reach)
      halo.addColorStop(0, withAlpha(hue, 0.38 + level * 0.3))
      halo.addColorStop(1, withAlpha(hue, 0))
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(c, c, reach, 0, Math.PI * 2)
      ctx.fill()
      // Body.
      const body = ctx.createRadialGradient(c - r * 0.3, c - r * 0.35, r * 0.1, c, c, r)
      body.addColorStop(0, 'rgba(255,255,255,0.95)')
      body.addColorStop(0.35, withAlpha(hue, 0.95))
      body.addColorStop(1, withAlpha(hue, 0.15))
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.arc(c, c, r, 0, Math.PI * 2)
      ctx.fill()
      // Thinking: two arcs chasing each other round the edge.
      if (busy) {
        ctx.lineWidth = 1.6
        ctx.strokeStyle = withAlpha(hue, 0.85)
        for (const k of [0, Math.PI]) {
          ctx.beginPath()
          ctx.arc(c, c, r + 9, time * 2.4 + k, time * 2.4 + k + 1.1)
          ctx.stroke()
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  const status = looking
    ? `Looking — ${looking}`
    : phase === 'tooling' && activeTool
      ? activeTool.replace(/[_-]/g, ' ')
      : STATUS[phase]

  return (
    <div className={`presence presence-${phase}`}>
      <canvas ref={canvas} className="presence-orb" style={{ width: 132, height: 132 }} />
      <div className="presence-status">{status}</div>
      <AnimatePresence>
        {caption && (
          <motion.div
            className="presence-caption"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {caption}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** "#9fb4ff" + 0.4 -> "rgba(159,180,255,0.4)". Anything else passes through opaque. */
function withAlpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return color
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`
}
