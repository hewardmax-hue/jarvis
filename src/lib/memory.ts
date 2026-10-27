import { BRIDGE_HTTP_URL } from '../config'

/**
 * The second brain, as the interface sees it.
 *
 * The core owns the index (bridge/brain); this fetches what the map and the
 * memory panel draw — the graph, one item in full, a search, the status — over
 * the core's private HTTP endpoints. Cross-origin on purpose: the browser sends
 * this page's Origin, and the core answers nothing that does not carry one it
 * trusts.
 */

export type NodeKind =
  | 'core'
  | 'hub'
  | 'entity'
  | 'fact'
  | 'profile'
  | 'note'
  | 'conversation'
  | 'briefing'
  | 'journal'
  | 'file'

export type GraphNode = {
  id: string
  label: string
  kind: NodeKind
  group: string
  date?: string
  depth?: number
  weight?: number
}

export type Graph = { version: number; nodes: GraphNode[]; links: [number, number][] }

export type Digest = {
  summary: string
  questions: string[]
  tags: string[]
  entities: string[]
  atoms: string[]
  at: string
}

export type BrainItem = {
  id: string
  kind: NodeKind
  title: string
  hub: string
  date: string
  path: string | null
  text: string
  digest: Digest | null
  entities: string[]
  size: number
  neighbours: { id: string; label: string; kind: NodeKind }[]
}

export type SearchHit = {
  id: string
  kind: NodeKind
  title: string
  hub: string
  date: string
  score: number
  summary: string
  snippet: string
}

export type BrainStatus = {
  items: number
  digested: number
  pending: number
  digest: string
  scanning: boolean
  digesting: boolean
  lastScan: string | null
  lastError: string | null
  sources: { name: string; path: string; items: number; found?: number; kind: string }[]
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return (await res.json()) as T
}

export const fetchGraph = () => get<Graph>('/brain/graph')
export const fetchStatus = () => get<BrainStatus>('/brain/status')
export const fetchItem = (id: string) => get<BrainItem>(`/brain/node?id=${encodeURIComponent(id)}`)
export const searchBrain = (q: string) =>
  get<{ hits: SearchHit[] }>(`/brain/search?q=${encodeURIComponent(q)}`).then((r) => r.hits)

export async function openItem(id: string, reveal = false) {
  await fetch(`${BRIDGE_HTTP_URL}/brain/open?id=${encodeURIComponent(id)}${reveal ? '&reveal=1' : ''}`, {
    method: 'POST',
  })
}

export async function rescan() {
  await fetch(`${BRIDGE_HTTP_URL}/brain/rescan`, { method: 'POST' })
}

/** What each kind of item is called, and the colour it wears on the map. */
export const KINDS: Record<NodeKind, { label: string; color: string }> = {
  core: { label: 'Emrys', color: '#f4f1ea' },
  hub: { label: 'Folder', color: '#c9d2e3' },
  entity: { label: 'Person or thing', color: '#f2a7c3' },
  fact: { label: 'Memory', color: '#b49cff' },
  profile: { label: 'About you', color: '#d8c8ff' },
  note: { label: 'Note', color: '#7fe3d0' },
  conversation: { label: 'Conversation', color: '#7fb6ff' },
  briefing: { label: 'Briefing', color: '#ffc979' },
  journal: { label: 'Log', color: '#8f9bb3' },
  file: { label: 'Document', color: '#6fd3ff' },
}
