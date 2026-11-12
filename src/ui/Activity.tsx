import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { stopJob, type Step } from '../lib/brain'

/**
 * What he and his agents are doing.
 *
 * The conversation shows what was said; this shows the work. At the top, what
 * is running right now — Jett on your question, an agent he handed a piece to,
 * a scheduled job — each with the step it is on, how long it has been at it,
 * and a way to stop it. Below, every step in order under the question or job
 * it was taken for: what was searched, what was read, what came back. A row
 * opens to show exactly what the tool was given and what it returned.
 */

const isOpen = (s: Step) => s.status === 'running' || s.status === 'waiting'
const isWork = (s: Step) => s.kind === 'turn' || s.kind === 'agent' || s.kind === 'job'

type Tree = { roots: Step[]; kids: Map<string, Step[]>; byId: Map<string, Step> }

function arrange(steps: Step[]): Tree {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const kids = new Map<string, Step[]>()
  const roots: Step[] = []
  for (const s of steps) {
    if (s.parent && byId.has(s.parent)) {
      const list = kids.get(s.parent)
      if (list) list.push(s)
      else kids.set(s.parent, [s])
    } else roots.push(s)
  }
  return { roots, kids, byId }
}

/** The step a piece of work is on: the newest one still open beneath it, else the newest. */
function current(tree: Tree, id: string): Step | null {
  let open: Step | null = null
  let last: Step | null = null
  const walk = (parent: string) => {
    for (const s of tree.kids.get(parent) ?? []) {
      last = s
      if (isOpen(s)) open = s
      walk(s.id)
    }
  }
  walk(id)
  return open ?? last
}

/** The turn or job a step belongs to, however deep it is. */
function rootOf(tree: Tree, step: Step): Step {
  let s = step
  while (s.parent && tree.byId.has(s.parent)) s = tree.byId.get(s.parent)!
  return s
}

function took(ms: number) {
  if (ms < 950) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const oneLine = (s: string | undefined, n = 90) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** Re-render once a second while something is running, for the timers. */
function useTick(on: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => set((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
}

const STATUS: Record<Step['status'], string> = {
  running: 'Working',
  waiting: 'Waiting for your yes',
  done: 'Done',
  error: 'Failed',
  denied: 'Not allowed',
  stopped: 'Stopped',
}

function Mark({ status }: { status: Step['status'] }) {
  return <span className={`act-mark is-${status}`} title={STATUS[status]} aria-label={STATUS[status]} />
}

function who(step: Step) {
  if (step.kind === 'turn') return 'Jett'
  if (step.kind === 'job') return 'Scheduled job'
  return step.agent
}

function stepLine(step: Step | null) {
  if (!step) return 'Thinking'
  if (step.kind === 'agent') return `${step.agent} — ${oneLine(step.title, 60)}`
  const detail = oneLine(step.detail, 70)
  return detail ? `${step.title} — ${detail}` : step.title
}

/** What is running right now, for the strip above the composer and the cards here. */
export function useWork() {
  const steps = useStore((s) => s.steps)
  return useMemo(() => {
    const tree = arrange(steps)
    const work = steps.filter((s) => isWork(s) && isOpen(s))
    return { tree, work }
  }, [steps])
}

function stop(tree: Tree, step: Step, onStop: () => void) {
  const root = rootOf(tree, step)
  if (root.kind === 'job' && root.job) stopJob(root.job)
  else onStop()
}

function Card({ step, tree, onStop }: { step: Step; tree: Tree; onStop: () => void }) {
  const now = current(tree, step.id)
  return (
    <div className={`act-card is-${step.status}`}>
      <div className="act-card-top">
        <Mark status={step.status} />
        <span className="act-who">{who(step)}</span>
        <span className="act-time">{took(Date.now() - step.at)}</span>
        <button className="act-stop" onClick={() => stop(tree, step, onStop)} title="Stop this">
          Stop
        </button>
      </div>
      <div className="act-task">{step.kind === 'turn' ? `“${oneLine(step.title, 140)}”` : oneLine(step.title, 140)}</div>
      <div className="act-now">
        {step.status === 'waiting' ? 'Waiting for your yes' : stepLine(now && now.id !== step.id ? now : null)}
      </div>
      {step.note && <div className="act-note">{step.note.slice(-220)}</div>}
    </div>
  )
}

function Row({ step, tree, depth }: { step: Step; tree: Tree; depth: number }) {
  const [open, setOpen] = useState(false)
  const kids = tree.kids.get(step.id) ?? []
  const group = step.kind === 'turn' || step.kind === 'job'
  const [folded, setFolded] = useState(false)
  const more = Boolean(step.detail || step.input || step.result || step.note)
  const shownInput = step.input && step.input.trim() !== (step.detail ?? '').trim() ? step.input : ''

  return (
    <div className={`act-row kind-${step.kind} is-${step.status}${group ? ' is-group' : ''}`} style={{ marginLeft: depth ? 14 : 0 }}>
      <button
        className="act-line"
        onClick={() => (group && kids.length ? setFolded((f) => !f) : more && setOpen((o) => !o))}
        onDoubleClick={() => group && more && setOpen((o) => !o)}
        title={group ? 'Click to fold · double-click for the detail' : more ? 'Click for exactly what was sent and what came back' : undefined}
      >
        <Mark status={step.status} />
        <span className="act-title">
          {group && <span className="act-clock">{clock(step.at)}</span>}
          {step.kind === 'agent' && <span className="act-badge">{step.agent}</span>}
          {step.kind === 'job' && <span className="act-badge">Job</span>}
          <span className="act-name">{step.kind === 'turn' ? `“${oneLine(step.title, 120)}”` : step.title}</span>
          {!group && step.kind !== 'agent' && step.detail && <span className="act-detail">{oneLine(step.detail, 80)}</span>}
        </span>
        <span className="act-took">
          {isOpen(step) ? took(Date.now() - step.at) : step.ms != null ? took(step.ms) : ''}
        </span>
      </button>

      {group && !folded && step.result && !isOpen(step) && (
        <button className="act-said" onClick={() => setOpen((o) => !o)}>
          {step.status === 'error' ? 'Failed: ' : step.kind === 'turn' ? 'Jett: ' : ''}
          {open ? step.result : oneLine(step.result, 150)}
        </button>
      )}

      {open && !group && (
        <div className="act-more">
          {step.detail && (
            <>
              <div className="act-label">{step.kind === 'agent' ? 'Asked to' : step.kind === 'recall' ? 'Recalled' : 'With'}</div>
              <pre>{step.detail}</pre>
            </>
          )}
          {shownInput && (
            <>
              <div className="act-label">Exactly what was sent</div>
              <pre>{shownInput}</pre>
            </>
          )}
          {step.note && (
            <>
              <div className="act-label">Said while working</div>
              <pre>{step.note}</pre>
            </>
          )}
          {step.result && (
            <>
              <div className="act-label">{step.status === 'error' ? 'Went wrong' : 'Came back'}</div>
              <pre>{step.result}</pre>
            </>
          )}
          {step.tool && <div className="act-tool">{step.tool}</div>}
        </div>
      )}

      {!folded && kids.length > 0 && (
        <div className="act-kids">
          {kids.map((k) => (
            <Row key={k.id} step={k} tree={tree} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export function Activity({ onStop }: { onStop: () => void }) {
  const { tree, work } = useWork()
  const scroller = useRef<HTMLDivElement>(null)
  const count = useStore((s) => s.steps.length)
  useTick(work.length > 0)

  // Follow the work down, unless the user has scrolled up to read.
  const first = useRef(true)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (near || first.current) el.scrollTop = el.scrollHeight
    first.current = false
  }, [count, work.length])

  return (
    <div className="act">
      <div className="act-running">
        {work.length === 0 ? (
          <div className="act-idle">
            <span className="act-mark is-idle" />
            Nothing running. Jett is standing by.
          </div>
        ) : (
          work.map((s) => <Card key={s.id} step={s} tree={tree} onStop={onStop} />)
        )}
      </div>

      <div className="act-scroll" ref={scroller}>
        {tree.roots.length === 0 ? (
          <p className="act-empty">
            Ask Jett for something and every step he takes appears here as it happens — what he searched, what he read,
            which agent he handed a piece to, and exactly what came back.
          </p>
        ) : (
          tree.roots.map((s) => <Row key={s.id} step={s} tree={tree} depth={0} />)
        )}
      </div>
    </div>
  )
}

/**
 * One line of the same thing, for the conversation: what is running right now.
 * Click it for the whole picture.
 */
export function NowStrip({ onOpen, onStop }: { onOpen: () => void; onStop: () => void }) {
  const { tree, work } = useWork()
  useTick(work.length > 0)
  if (!work.length) return null
  // The deepest thing running says the most: an agent rather than the turn that started it.
  const step = work[work.length - 1]
  const now = current(tree, step.id)
  return (
    <div className="now">
      <button className="now-line" onClick={onOpen} title="See everything he is doing">
        <Mark status={step.status} />
        <span className="now-who">{who(step)}</span>
        <span className="now-what">
          {step.status === 'waiting' ? 'waiting for your yes' : stepLine(now && now.id !== step.id ? now : step.kind === 'turn' ? null : step)}
        </span>
        <span className="now-time">{took(Date.now() - step.at)}</span>
        {work.length > 1 && <span className="now-more">+{work.length - 1}</span>}
      </button>
      <button className="act-stop" onClick={() => stop(tree, step, onStop)} title="Stop this">
        Stop
      </button>
    </div>
  )
}
