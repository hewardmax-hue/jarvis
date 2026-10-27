import { create } from 'zustand'
import type { ApprovalRequest, Notice, RecallHit } from './lib/bridge'
import type { BrainItem, Graph } from './lib/memory'

export type Phase =
  | 'offline'   // not connected to the core yet
  | 'boot'      // connecting
  | 'dormant'   // ready, waiting to be spoken to
  | 'waking'    // wake word heard (hands-free mode only)
  | 'listening' // capturing speech
  | 'thinking'  // the model is working on an answer
  | 'tooling'   // a tool is running
  | 'speaking'  // reading the answer back

export type Tier = 'fast' | 'voice' | 'deep'

/**
 * A card Emrys composed. Rendered on a blade now — panels and blades used to be
 * two surfaces, and two places to look is one too many.
 */
export type Panel = {
  id: string
  title: string
  html: string
  anim: 'materialise' | 'sweep' | 'unfold' | 'stagger' | 'snap'
  slot: 'right' | 'left' | 'wide'
  accent: 'default' | 'amber' | 'violet' | 'green' | 'red'
  hold: 'turn' | 'sticky'
}

/**
 * A blade — the big surface, over the map.
 *
 * Blades own their own geometry, stack rather than replace each other, and can
 * be pulled forward or thrown full screen.
 */
export type Blade = {
  id: string
  title: string
  kind: 'article' | 'image' | 'gallery' | 'video' | 'embed' | 'markup' | 'camera'
  url?: string
  images?: string[]
  html?: string
  mode?: 'reader' | 'live'
  size: 'compact' | 'tall' | 'wide' | 'full'
  hold: 'turn' | 'sticky'
}

export type Turn = {
  id: string
  role: 'user' | 'emrys'
  text: string
  /** Tools used while producing this turn, for the activity line. */
  tools?: string[]
  /** Second-brain items this answer drew on, shown as source chips. */
  sources?: RecallHit[]
  at: number
}

/** Items lit up on the map, and why. A new `at` re-runs the flight. */
export type Lit = { ids: string[]; mode: 'recall' | 'search' | 'open' | 'new'; at: number }

const TRANSCRIPT_KEY = 'emrys.transcript'
const PREFS_KEY = 'emrys.prefs'

type Prefs = { muted: boolean; voice: string; accent: string | null }

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

function loadTurns(): Turn[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.slice(-80) : []
  } catch {
    return []
  }
}

let saveTimer = 0
function saveTurns(turns: Turn[]) {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(turns.slice(-80)))
    } catch {
      /* private window */
    }
  }, 400)
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* private window */
  }
}

const prefs = load<Prefs>(PREFS_KEY, { muted: false, voice: '', accent: null })

type State = {
  phase: Phase
  /** 0..1 loudness — the user's mic while listening, Emrys's voice while speaking. */
  level: number
  /** Live transcript of what the user is saying. */
  caption: string
  turns: Turn[]
  activeTool: string | null
  error: string | null
  connected: string[]
  /** The voice speaking, for the settings readout. */
  voice: string
  gestures: boolean
  /** Set while Emrys is looking through the camera or at the screen. */
  looking: string | null
  /** True while the user is sharing their screen with him. */
  sharing: boolean
  panels: Panel[]
  blades: Blade[]
  focusedBlade: string | null
  expandedBlade: string | null
  approval: ApprovalRequest | null
  notices: Notice[]

  // The second brain.
  graph: Graph | null
  graphVersion: number
  selected: string | null
  item: BrainItem | null
  lit: Lit | null
  hovered: string | null

  // Settings.
  tier: Tier
  muted: boolean
  voiceId: string
  accent: string | null

  setApproval: (a: ApprovalRequest | null) => void
  setNotices: (n: Notice[]) => void
  setVoice: (v: string) => void
  setGestures: (on: boolean) => void
  setLooking: (why: string | null) => void
  setSharing: (on: boolean) => void
  pushPanel: (p: Panel) => void
  clearPanels: () => void
  pushBlade: (b: Blade) => void
  closeBlade: (id: string) => void
  clearBlades: () => void
  focusBlade: (id: string | null) => void
  expandBlade: (id: string | null) => void
  setPhase: (p: Phase) => void
  setLevel: (l: number) => void
  setCaption: (c: string) => void
  setActiveTool: (t: string | null) => void
  setError: (e: string | null) => void
  setConnected: (c: string[]) => void
  pushTurn: (t: Turn) => void
  appendToLastTurn: (text: string) => void
  patchTurn: (id: string, patch: Partial<Turn>) => void
  clearTranscript: () => void

  setGraph: (g: Graph) => void
  setGraphVersion: (v: number) => void
  select: (id: string | null) => void
  setItem: (item: BrainItem | null) => void
  light: (ids: string[], mode: Lit['mode']) => void
  setHovered: (id: string | null) => void

  setTier: (t: Tier) => void
  setMuted: (m: boolean) => void
  setVoiceId: (v: string) => void
  setAccent: (a: string | null) => void
  clearScreen: (what: 'all' | 'blades' | 'transcript') => void
}

export const useStore = create<State>((set, get) => ({
  phase: 'offline',
  level: 0,
  caption: '',
  turns: loadTurns(),
  activeTool: null,
  error: null,
  connected: [],
  voice: '',
  gestures: false,
  looking: null,
  sharing: false,
  panels: [],
  blades: [],
  focusedBlade: null,
  expandedBlade: null,
  approval: null,
  notices: [],

  graph: null,
  graphVersion: 0,
  selected: null,
  item: null,
  lit: null,
  hovered: null,

  tier: 'voice',
  muted: prefs.muted,
  voiceId: prefs.voice,
  accent: prefs.accent,

  setApproval: (approval) => set({ approval }),
  setNotices: (notices) => set({ notices }),
  setVoice: (voice) => set({ voice }),
  setGestures: (gestures) => set({ gestures }),
  setLooking: (looking) => set({ looking }),
  setSharing: (sharing) => set({ sharing }),

  // A composed panel opens as a markup blade: one surface for everything.
  pushPanel: (panel) =>
    get().pushBlade({
      id: panel.id,
      title: panel.title,
      kind: 'markup',
      html: panel.html,
      size: panel.slot === 'wide' ? 'wide' : 'compact',
      hold: panel.hold,
    }),
  clearPanels: () => set({ panels: [] }),

  pushBlade: (blade) =>
    set((s) => {
      const next = [...s.blades.filter((b) => b.id !== blade.id), blade].slice(-6)
      return { blades: next, focusedBlade: blade.id }
    }),
  closeBlade: (id) =>
    set((s) => ({
      blades: s.blades.filter((b) => b.id !== id),
      focusedBlade: s.focusedBlade === id ? null : s.focusedBlade,
      expandedBlade: s.expandedBlade === id ? null : s.expandedBlade,
    })),
  clearBlades: () =>
    set((s) => {
      const kept = s.blades.filter((b) => b.hold === 'sticky')
      const alive = new Set(kept.map((b) => b.id))
      return {
        blades: kept,
        focusedBlade: s.focusedBlade && alive.has(s.focusedBlade) ? s.focusedBlade : null,
        expandedBlade: s.expandedBlade && alive.has(s.expandedBlade) ? s.expandedBlade : null,
      }
    }),
  focusBlade: (focusedBlade) => set({ focusedBlade }),
  expandBlade: (expandedBlade) => set({ expandedBlade }),
  setPhase: (phase) => set({ phase }),
  setLevel: (level) => set({ level }),
  setCaption: (caption) => set({ caption }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setError: (error) => set({ error }),
  setConnected: (connected) => set({ connected }),
  pushTurn: (turn) =>
    set((s) => {
      const turns = [...s.turns.slice(-79), turn]
      saveTurns(turns)
      return { turns }
    }),
  appendToLastTurn: (text) =>
    set((s) => {
      const turns = [...s.turns]
      const last = turns[turns.length - 1]
      if (!last || last.role !== 'emrys') return {}
      turns[turns.length - 1] = { ...last, text: last.text + text }
      saveTurns(turns)
      return { turns }
    }),
  patchTurn: (id, patch) =>
    set((s) => {
      const turns = s.turns.map((t) => (t.id === id ? { ...t, ...patch } : t))
      saveTurns(turns)
      return { turns }
    }),
  clearTranscript: () => {
    saveTurns([])
    set({ turns: [] })
  },

  setGraph: (graph) => set({ graph, graphVersion: graph.version }),
  setGraphVersion: (graphVersion) => set({ graphVersion }),
  select: (selected) => set({ selected, item: selected ? get().item : null }),
  setItem: (item) => set({ item }),
  // Lit items fade back into the map after a while, unless something newer lit.
  light: (ids, mode) => {
    const at = Date.now()
    set({ lit: { ids, mode, at } })
    setTimeout(() => {
      if (get().lit?.at === at) set({ lit: null })
    }, 45_000)
  },
  setHovered: (hovered) => set({ hovered }),

  setTier: (tier) => set({ tier }),
  setMuted: (muted) => {
    set({ muted })
    savePrefs({ muted, voice: get().voiceId, accent: get().accent })
  },
  setVoiceId: (voiceId) => {
    set({ voiceId })
    savePrefs({ muted: get().muted, voice: voiceId, accent: get().accent })
  },
  setAccent: (accent) => {
    set({ accent })
    savePrefs({ muted: get().muted, voice: get().voiceId, accent })
  },
  clearScreen: (what) =>
    set((s) => {
      const out: Partial<State> = {}
      if (what !== 'transcript') Object.assign(out, { blades: [], focusedBlade: null, expandedBlade: null })
      if (what !== 'blades') {
        saveTurns([])
        Object.assign(out, { turns: [] })
      }
      return { ...s, ...out }
    }),
}))

/** Colour per phase — the presence orb and the status line agree on it. */
export const phaseColor: Record<Phase, string> = {
  offline: '#5b6273',
  boot: '#8f9bb3',
  dormant: '#9fb4ff',
  waking: '#c3d0ff',
  listening: '#7fe3d0',
  thinking: '#b49cff',
  tooling: '#ffc979',
  speaking: '#9fb4ff',
}

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__emrys = new Proxy(
    {} as Record<string, unknown>,
    {
      get: (_t, key) => (useStore.getState() as Record<string | symbol, unknown>)[key],
    },
  )
}
