import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import {
  KINDS,
  fetchItem,
  fetchStatus,
  openItem,
  rescan,
  searchBrain,
  type BrainStatus,
  type SearchHit,
} from '../lib/memory'

/**
 * The memory panel — the second brain in words, beside the map.
 *
 * At rest it shows what Emrys knows: the facts he has been told, where his
 * material comes from and how far the indexing has got. Search it and the
 * results replace that. Pick anything — here, on the map, or from a source chip
 * in the conversation — and its summary, key facts and connections take over
 * the panel, with a way to open the file itself or ask him about it.
 */

const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''

function KindDot({ kind }: { kind: string }) {
  const k = KINDS[kind as keyof typeof KINDS]
  return <span className="kind-dot" style={{ background: k?.color ?? '#fff' }} title={k?.label} />
}

function Detail({ onAsk }: { onAsk: (text: string) => void }) {
  const selected = useStore((s) => s.selected)
  const item = useStore((s) => s.item)
  const setItem = useStore((s) => s.setItem)
  const select = useStore((s) => s.select)
  const graph = useStore((s) => s.graph)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!selected) return
    setFailed(false)
    // Folders and entities live only in the map; everything else has a record.
    if (selected === 'core' || selected.startsWith('hub:') || selected.startsWith('ent:')) {
      setItem(null)
      return
    }
    let live = true
    fetchItem(selected)
      .then((it) => live && setItem(it))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [selected, setItem])

  if (!selected) return null
  const node = graph?.nodes.find((n) => n.id === selected)

  // A folder, a person or a project: list what hangs off it.
  if (!item || item.id !== selected) {
    const idx = graph?.nodes.findIndex((n) => n.id === selected) ?? -1
    const around = idx < 0 || !graph
      ? []
      : graph.links
          .filter(([a, b]) => a === idx || b === idx)
          .map(([a, b]) => graph.nodes[a === idx ? b : a])
          .filter((n) => n.kind !== 'core')
          .slice(0, 40)
    return (
      <section className="mem-detail">
        <button className="mem-back" onClick={() => select(null)}>← Back</button>
        <div className="mem-kind">
          <KindDot kind={node?.kind ?? 'hub'} /> {node?.kind === 'entity' ? 'Person, place or project' : node?.kind === 'core' ? 'Emrys' : 'Folder'}
        </div>
        <h2 className="mem-title">{node?.label ?? '…'}</h2>
        {failed && <p className="mem-dim">Could not load this item.</p>}
        {around.length > 0 && (
          <>
            <div className="mem-h">Connected</div>
            <ul className="mem-list">
              {around.map((n) => (
                <li key={n.id}>
                  <button className="mem-row" onClick={() => select(n.id)}>
                    <KindDot kind={n.kind} />
                    <span className="mem-row-text">{n.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {node && node.kind === 'entity' && (
          <button className="mem-ask" onClick={() => onAsk(`What do you know about ${node.label}?`)}>
            Ask Emrys about {node.label}
          </button>
        )}
      </section>
    )
  }

  const d = item.digest
  return (
    <section className="mem-detail">
      <button className="mem-back" onClick={() => select(null)}>← Back</button>
      <div className="mem-kind">
        <KindDot kind={item.kind} /> {KINDS[item.kind]?.label} · {item.hub} · {fmtDate(item.date)}
      </div>
      <h2 className="mem-title">{item.title}</h2>
      {d?.summary ? (
        <p className="mem-summary">{d.summary}</p>
      ) : item.text && item.text.length < 400 ? (
        <p className="mem-summary">{item.text}</p>
      ) : (
        <p className="mem-dim">Not summarised yet — it will be shortly.</p>
      )}
      {d?.atoms?.length ? (
        <>
          <div className="mem-h">Key facts</div>
          <ul className="mem-atoms">
            {d.atoms.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      ) : null}
      {d?.tags?.length ? (
        <div className="mem-tags">
          {d.tags.map((t) => (
            <span key={t} className="mem-tag">
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mem-actions">
        {item.path && (
          <>
            <button onClick={() => void openItem(item.id)}>Open</button>
            <button onClick={() => void openItem(item.id, true)}>Show in Finder</button>
          </>
        )}
        <button className="mem-ask" onClick={() => onAsk(`Tell me about “${item.title}”.`)}>
          Ask Emrys
        </button>
      </div>
      {item.neighbours.filter((n) => n.kind !== 'core').length > 0 && (
        <>
          <div className="mem-h">Connected</div>
          <div className="mem-chips">
            {item.neighbours
              .filter((n) => n.kind !== 'core')
              .slice(0, 16)
              .map((n) => (
                <button key={n.id} className="mem-chip" onClick={() => select(n.id)}>
                  <KindDot kind={n.kind} />
                  {n.label}
                </button>
              ))}
          </div>
        </>
      )}
      {d?.questions?.length ? (
        <>
          <div className="mem-h">Answers questions like</div>
          <ul className="mem-questions">
            {d.questions.slice(0, 4).map((q, i) => (
              <li key={i}>
                <button onClick={() => onAsk(q)}>{q}</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}

function Overview() {
  const graph = useStore((s) => s.graph)
  const graphVersion = useStore((s) => s.graphVersion)
  const select = useStore((s) => s.select)
  const [status, setStatus] = useState<BrainStatus | null>(null)

  useEffect(() => {
    let live = true
    const load = () =>
      fetchStatus()
        .then((s) => live && setStatus(s))
        .catch(() => {})
    void load()
    const t = setInterval(load, 8000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [graphVersion])

  const facts = useMemo(
    () =>
      (graph?.nodes ?? [])
        .filter((n) => n.kind === 'fact' || n.kind === 'profile')
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
        .slice(0, 12),
    [graph],
  )

  const progress = status && status.items ? status.digested / status.items : 0

  return (
    <>
      <section className="mem-section">
        <div className="mem-h">What Emrys knows about you</div>
        {facts.length === 0 && <p className="mem-dim">Nothing yet. Tell him something and say “remember that”.</p>}
        <ul className="mem-list">
          {facts.map((f) => (
            <li key={f.id}>
              <button className="mem-row" onClick={() => select(f.id)}>
                <KindDot kind={f.kind} />
                <span className="mem-row-text">{f.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mem-section">
        <div className="mem-h">
          Sources
          <button className="mem-link" onClick={() => void rescan()} title="Look for new and changed files now">
            Sync
          </button>
        </div>
        <ul className="mem-sources">
          {(status?.sources ?? []).map((s) => (
            <li key={s.name}>
              <button className="mem-row" onClick={() => select(`hub:${s.name}`)}>
                <span className="mem-row-text">{s.name}</span>
                <span className="mem-count">{s.items}</span>
              </button>
            </li>
          ))}
        </ul>
        {status && (
          <div className="mem-sync">
            <div className="mem-bar">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span>
              {status.pending > 0 || status.digesting
                ? `Summarising · ${status.digested} of ${status.items}`
                : `${status.items} items, all summarised`}
            </span>
          </div>
        )}
        {status?.lastError && <p className="mem-dim">Last problem: {status.lastError}</p>}
      </section>

      <section className="mem-section mem-legend">
        {(['fact', 'note', 'conversation', 'briefing', 'file', 'entity'] as const).map((k) => (
          <span key={k}>
            <KindDot kind={k} />
            {KINDS[k].label}
          </span>
        ))}
      </section>
    </>
  )
}

export function MemoryPanel({ onAsk }: { onAsk: (text: string) => void }) {
  const selected = useStore((s) => s.selected)
  const select = useStore((s) => s.select)
  const light = useStore((s) => s.light)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)

  useEffect(() => {
    if (!q.trim()) {
      setHits(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      searchBrain(q)
        .then((h) => {
          if (!live) return
          setHits(h)
          light(h.slice(0, 8).map((x) => x.id), 'search')
        })
        .catch(() => live && setHits([]))
    }, 140)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, light])

  return (
    <aside className="memory">
      <div className="mem-search">
        <input
          type="search"
          placeholder="Search your second brain"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('')
          }}
        />
      </div>
      <div className="mem-scroll">
        {selected ? (
          <Detail onAsk={onAsk} />
        ) : hits ? (
          <section className="mem-section">
            <div className="mem-h">{hits.length ? `${hits.length} results` : 'Nothing matches'}</div>
            <ul className="mem-list">
              {hits.map((h) => (
                <li key={h.id}>
                  <button className="mem-hit" onClick={() => select(h.id)}>
                    <span className="mem-hit-title">
                      <KindDot kind={h.kind} />
                      {h.title}
                    </span>
                    <span className="mem-hit-meta">
                      {h.hub} · {fmtDate(h.date)}
                    </span>
                    {(h.snippet || h.summary) && <span className="mem-hit-snip">{h.snippet || h.summary}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <Overview />
        )}
      </div>
    </aside>
  )
}
