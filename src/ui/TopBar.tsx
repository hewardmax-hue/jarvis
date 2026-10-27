import { useStore, type Tier } from '../store'
import { setTier } from '../lib/brain'
import { caps } from '../lib/capabilities'
import { startScreenShare, stopScreenShare } from '../lib/screen'

/**
 * The bar across the top: who he is, what is waiting, and the few settings
 * worth reaching for mid-conversation — how hard he thinks, whose voice he
 * speaks in, whether he speaks at all, and whether he can see your screen.
 */

const TIERS: { id: Tier; label: string; hint: string }[] = [
  { id: 'fast', label: 'Quick', hint: 'Haiku — the fastest replies' },
  { id: 'voice', label: 'Balanced', hint: 'Sonnet — the everyday default' },
  { id: 'deep', label: 'Deep', hint: 'Opus — slower, for hard thinking' },
]

export function TopBar({ onBrief }: { onBrief: () => void }) {
  const tier = useStore((s) => s.tier)
  const muted = useStore((s) => s.muted)
  const setMuted = useStore((s) => s.setMuted)
  const voiceId = useStore((s) => s.voiceId)
  const setVoiceId = useStore((s) => s.setVoiceId)
  const sharing = useStore((s) => s.sharing)
  const notices = useStore((s) => s.notices)
  const phase = useStore((s) => s.phase)
  const setError = useStore((s) => s.setError)
  // Re-rendered when the voice engine comes up, which is when the list exists.
  const voiceName = useStore((s) => s.voice)
  const voices = caps().voices
  const latest = notices.at(-1)

  return (
    <header className="topbar">
      <div className="brand">
        <span className={`brand-dot brand-dot-${phase}`} />
        <span className="brand-name">Emrys</span>
      </div>

      {latest && (
        <button className="notice" onClick={onBrief} title={latest.headline}>
          <span className="notice-dot" />
          {latest.title} ready{notices.length > 1 ? ` · +${notices.length - 1}` : ''}
        </button>
      )}

      <div className="topbar-right">
        <div className="seg" role="radiogroup" aria-label="Model">
          {TIERS.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={tier === t.id}
              className={tier === t.id ? 'is-on' : ''}
              title={t.hint}
              onClick={() => setTier(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {voices.length > 0 && (
          <select
            className="voice-select"
            value={voiceId || caps().defaultVoice}
            onChange={(e) => setVoiceId(e.target.value)}
            title={`Emrys’s voice${voiceName ? ` — ${voiceName}` : ''}`}
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} · {v.accent}
              </option>
            ))}
          </select>
        )}

        <button
          className={`icon-btn${muted ? ' is-off' : ''}`}
          onClick={() => setMuted(!muted)}
          title={muted ? 'Voice off — replies are text only' : 'Voice on'}
          aria-pressed={!muted}
        >
          {muted ? (
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
              <path fill="currentColor" d="M4 9v6h4l5 5V4L8 9H4Zm12.6 3 2.9-2.9-1.1-1.1-2.9 2.9-2.9-2.9-1.1 1.1 2.9 2.9-2.9 2.9 1.1 1.1 2.9-2.9 2.9 2.9 1.1-1.1-2.9-2.9Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
              <path fill="currentColor" d="M4 9v6h4l5 5V4L8 9H4Zm11.5 3A4.5 4.5 0 0 0 13 8v8a4.47 4.47 0 0 0 2.5-4Zm-2.5-9v2.06A7 7 0 0 1 13 19v2.06A9 9 0 0 0 13 3Z" />
            </svg>
          )}
        </button>

        <button
          className={`share-btn${sharing ? ' is-on' : ''}`}
          onClick={() => {
            if (sharing) stopScreenShare()
            else
              void startScreenShare().catch((err: Error) => {
                if (err?.name !== 'NotAllowedError') setError(`Screen sharing failed: ${err?.message ?? err}`)
              })
          }}
          title={sharing ? 'Stop sharing your screen' : 'Let Emrys see your screen'}
        >
          {sharing ? 'Sharing screen' : 'Share screen'}
        </button>
      </div>
    </header>
  )
}
