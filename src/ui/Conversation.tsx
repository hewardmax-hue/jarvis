import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { decide } from '../lib/approval'
import { KINDS } from '../lib/memory'
import { PUSH_TO_TALK } from '../config'
import { Activity, NowStrip, useWork } from './Activity'

/**
 * The conversation, in writing.
 *
 * Everything said both ways, kept across reloads, with what Jett drew on shown
 * under each answer — the notes he recalled as chips you can click to see on
 * the map, and the tools he used as a quiet line. At the foot, a box to type
 * in: on a call, or anywhere speaking is wrong, typing is the same
 * conversation.
 *
 * The other tab is the work behind it (Activity.tsx): what he and his agents
 * are doing, step by step. The box stays at the foot of both, so whatever is
 * running can be told something new without leaving the view of it.
 */

const SUGGESTIONS = [
  'What do you know about me?',
  "What's on my calendar tomorrow?",
  'Summarise my unread email',
  'What did we talk about yesterday?',
  'Find my notes on the block seminar',
  'Remember that I prefer morning meetings',
  'Look at my screen',
  'Switch to deep mode',
]

function greeting() {
  const h = new Date().getHours()
  return h < 5 ? 'Up late.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'
}

/** "jett_brain · search_brain" -> "Searched your notes". Unknown ones keep their own name. */
function toolLabel(raw: string): string {
  const t = raw.toLowerCase()
  if (t.includes('search_brain') || t.includes('open_note')) return 'Checked your notes'
  if (t.includes('remember')) return 'Remembered'
  if (t.includes('write_note')) return 'Wrote a note'
  if (t.includes('calendar')) return 'Checked your calendar'
  if (t.includes('gmail') || t.includes('mail')) return 'Checked your mail'
  if (t.includes('drive')) return 'Looked in Drive'
  if (t.includes('chrome')) return 'Used your browser'
  if (t.includes('websearch') || t.includes('webfetch')) return 'Searched the web'
  if (t.includes('screen')) return 'Looked at your screen'
  if (t.includes('look') || t.includes('watch')) return 'Used the camera'
  if (/\b(grep|glob|read)\b/.test(t)) return 'Searched your files'
  if (t.includes('bash')) return 'Ran a command'
  if (t.includes('task') || t.includes('agent')) return 'Thought it through'
  return raw.replace(/^.*· /, '').replace(/_/g, ' ')
}

function Approval() {
  const approval = useStore((s) => s.approval)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!approval) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [approval])
  const left = approval ? Math.max(0, Math.ceil((approval.expiresAt - now) / 1000)) : 0
  return (
    <AnimatePresence>
      {approval && (
        <motion.div
          key={approval.id}
          className="approval"
          role="alertdialog"
          aria-label={`Approve ${approval.title}?`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        >
          <div className="approval-head">
            <span className="approval-dot" />
            Okay to do this?
            <span className="approval-clock">{left}s</span>
          </div>
          <div className="approval-title">{approval.title}</div>
          {approval.detail && <pre className="approval-detail">{approval.detail}</pre>}
          <div className="approval-actions">
            <button type="button" className="btn btn-primary" onClick={() => decide(true)}>
              Yes <kbd>Y</kbd>
            </button>
            <button type="button" className="btn" onClick={() => decide(false)}>
              No <kbd>N</kbd>
            </button>
            <span className="approval-hint">{PUSH_TO_TALK ? 'or hold ⌥ and say it' : 'or just say it'}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function Conversation({
  onSend,
  onStop,
  onHold,
  draft,
  setDraft,
}: {
  onSend: (text: string) => void
  onStop: () => void
  onHold: (down: boolean) => void
  draft: string
  setDraft: (s: string) => void
}) {
  const turns = useStore((s) => s.turns)
  const phase = useStore((s) => s.phase)
  const select = useStore((s) => s.select)
  const clearTranscript = useStore((s) => s.clearTranscript)
  const error = useStore((s) => s.error)
  const side = useStore((s) => s.side)
  const setSide = useStore((s) => s.setSide)
  const { work } = useWork()
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  // Whether the view is resting on the latest line. Read from where the user left the scroll, never
  // from the gap after new lines land: an answer that arrives with its sources can add more height
  // in one go than any "near enough" allowance, and the view would stop following for good.
  const pinned = useRef(true)

  // Coming back to the conversation lands on its latest line.
  useEffect(() => {
    const el = scroller.current
    if (!el || side !== 'talk') return
    pinned.current = true
    el.scrollTop = el.scrollHeight
  }, [side])

  // Follow the conversation down, unless the user has scrolled up to read.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [turns, phase])

  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', focus)
    return () => window.removeEventListener('keydown', focus)
  }, [])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSend(text)
  }

  const busy = phase === 'thinking' || phase === 'tooling'

  return (
    <aside className="convo">
      <div className="convo-head">
        <div className="convo-tabs" role="tablist">
          <button role="tab" aria-selected={side === 'talk'} className={side === 'talk' ? 'is-on' : ''} onClick={() => setSide('talk')}>
            Conversation
          </button>
          <button
            role="tab"
            aria-selected={side === 'activity'}
            className={side === 'activity' ? 'is-on' : ''}
            onClick={() => setSide('activity')}
            title="What Jett and his agents are doing, step by step"
          >
            Activity
            {work.length > 0 && <span className="convo-live">{work.length}</span>}
          </button>
        </div>
        {side === 'talk' && turns.length > 0 && (
          <button className="convo-clear" onClick={clearTranscript} title="Clear the conversation shown here (Jett still remembers it)">
            Clear
          </button>
        )}
      </div>

      {side === 'activity' ? (
        <Activity onStop={onStop} />
      ) : (
      <div
        className="convo-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {turns.length === 0 ? (
          <div className="convo-empty">
            <div className="convo-hello">{greeting()}</div>
            <p>{PUSH_TO_TALK ? 'Hold ⌥ Option and talk, or type below.' : 'Say “Jett”, or type below.'}</p>
            <div className="convo-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => onSend(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t) => (
            <div key={t.id} className={`msg msg-${t.role}`}>
              {t.role === 'jett' && <span className="msg-who">Jett</span>}
              <div className="msg-text">{t.text || (busy ? '…' : '')}</div>
              {t.role === 'jett' && (t.sources?.length || t.tools?.length) ? (
                <div className="msg-meta">
                  {t.sources?.map((s) => (
                    <button key={s.id} className="msg-source" onClick={() => select(s.id)} title={`${s.hub ?? ''}`}>
                      <span className="kind-dot" style={{ background: KINDS[s.kind as keyof typeof KINDS]?.color }} />
                      {s.title.length > 34 ? s.title.slice(0, 32) + '…' : s.title}
                    </button>
                  ))}
                  {t.tools && t.tools.length > 0 && (
                    <span className="msg-tools">{[...new Set(t.tools.map(toolLabel))].join(' · ')}</span>
                  )}
                </div>
              ) : null}
            </div>
          ))
        )}
        {busy && turns.at(-1)?.role === 'user' && (
          <div className="msg msg-jett msg-pending">
            <span className="msg-who">Jett</span>
            <div className="typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>
      )}

      {side === 'talk' && <NowStrip onOpen={() => setSide('activity')} onStop={onStop} />}
      <Approval />
      {error && <div className="convo-error">{error}</div>}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <button
          type="button"
          className={`talk${phase === 'listening' ? ' is-on' : ''}`}
          title="Hold to talk (or hold ⌥ Option)"
          onPointerDown={(e) => {
            e.preventDefault()
            ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
            onHold(true)
          }}
          onPointerUp={() => onHold(false)}
          onPointerCancel={() => onHold(false)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path
              fill="currentColor"
              d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 1 0-7 0v5A3.5 3.5 0 0 0 12 15Zm6-3.5a6 6 0 0 1-12 0H4.5a7.5 7.5 0 0 0 6.75 7.46V21h1.5v-2.04a7.5 7.5 0 0 0 6.75-7.46H18Z"
            />
          </svg>
        </button>
        <textarea
          ref={input}
          rows={1}
          placeholder={work.length ? 'Tell him something new — it redirects him' : 'Message Jett'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button type="submit" className="send" disabled={!draft.trim()} title="Send (Enter)">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path fill="currentColor" d="M3.4 20.4 21.85 12 3.4 3.6 3.39 10.13 16.6 12 3.39 13.87z" />
          </svg>
        </button>
      </form>
    </aside>
  )
}
