import { useEffect, useState } from 'react'
import { useStore, type Bench, type BenchPart } from '../store'
import { askBench } from '../lib/brain'
import * as workshop from '../lib/workshop'

/**
 * The workshop bench: what he is building, in the middle of the screen.
 *
 * The 3D itself is not drawn here. Every part is code a model wrote, so it runs
 * in a sealed frame the controller owns and puts into the empty box below; this
 * component only draws what goes around it — the name of the build, what he is
 * doing to it this second, a checklist that ticks as each part arrives, and the
 * handful of things that can be done to a build without asking anyone.
 *
 * Everything laid over the stage lets the mouse through, except the buttons, so
 * the build can be turned by dragging anywhere on it.
 */

const LIGHTS: Bench['light'][] = ['studio', 'day', 'sunset', 'night']
const LIGHT_NAME: Record<Bench['light'], string> = { studio: 'Studio', day: 'Daylight', sunset: 'Sunset', night: 'Night' }

const STATE_NAME: Record<BenchPart['state'], string> = {
  writing: 'being written',
  running: 'going on the bench',
  ok: 'built',
  failed: 'would not build',
  repairing: 'being mended',
}

function Mark({ state }: { state: BenchPart['state'] }) {
  if (state === 'ok') {
    return (
      <svg className="bench-mark is-ok" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M2.8 7.4l2.7 2.7 5.7-6" />
      </svg>
    )
  }
  if (state === 'failed') {
    return (
      <svg className="bench-mark is-failed" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
      </svg>
    )
  }
  return <span className={`bench-mark is-busy${state === 'repairing' ? ' is-mending' : ''}`} aria-hidden="true" />
}

/** How long the work under way has been going. A long think is easier to wait out with a clock on it. */
function Clock({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <span className="bench-clock">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </span>
  )
}

export function Workshop() {
  const bench = useStore((s) => s.bench)
  const [printing, setPrinting] = useState(false)
  if (!bench) return null

  const note = (text: string) => useStore.getState().patchBench(bench.id, { note: text })
  const waiting = 'The stage is still starting'
  const working = bench.status === 'building' || bench.status === 'changing'
  const built = bench.parts.filter((p) => p.state === 'ok').length

  const apart = () => {
    if (!workshop.explode(!bench.exploded)) note(waiting)
  }
  const relight = () => {
    const next = LIGHTS[(LIGHTS.indexOf(bench.light) + 1) % LIGHTS.length]
    if (!workshop.light(next)) note(waiting)
  }
  const fit = () => {
    if (!workshop.camera('fit')) note(waiting)
  }
  const print = async () => {
    if (printing) return
    setPrinting(true)
    note('Exporting every piece')
    const out = await workshop.print()
    setPrinting(false)
    // The note belongs to the build that was exported; patchBench drops it if that build has gone.
    note(
      out.ok
        ? `${out.files} ${out.files === 1 ? 'file' : 'files'} saved to Downloads, in “${out.name}”`
        : `Could not export: ${out.error}`,
    )
  }
  const close = () => {
    workshop.drop()
    void askBench('close')
  }

  return (
    <section className={`bench is-${bench.status}`} aria-label="Workshop">
      <div className="bench-host" ref={workshop.mount} />

      <header className="bench-head">
        <h2 className="bench-title">{bench.title || 'On the bench'}</h2>
        <p className={`bench-note${working ? ' is-working' : ''}`} aria-live="polite">
          {working && <span className="bench-mark is-busy" aria-hidden="true" />}
          {working && bench.since > 0 && <Clock since={bench.since} />}
          <span className="bench-note-text">{bench.note || (working ? 'Working' : '')}</span>
        </p>
      </header>

      {bench.parts.length > 0 && (
        <ol className="bench-parts" aria-label={`Parts: ${built} of ${bench.parts.length} built`}>
          {bench.parts.map((part) => (
            <li key={part.name} className={`bench-part is-${part.state}`} title={STATE_NAME[part.state]}>
              <Mark state={part.state} />
              <span className="bench-part-name">{part.label}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="bench-tools">
        <button type="button" onClick={apart} disabled={built === 0} aria-pressed={bench.exploded}>
          {bench.exploded ? 'Put together' : 'Pull apart'}
        </button>
        <button type="button" onClick={relight} title="Change the light">
          {LIGHT_NAME[bench.light]}
        </button>
        <button type="button" onClick={fit} title="Bring the whole build back into view">
          Fit
        </button>
        <button type="button" onClick={() => void print()} disabled={printing || built === 0} title="Export every piece as an STL file">
          {printing ? 'Exporting…' : '3D print'}
        </button>
        <button type="button" className="bench-close" onClick={close} aria-label="Close the workshop" title="Close the workshop">
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </button>
      </div>
    </section>
  )
}
