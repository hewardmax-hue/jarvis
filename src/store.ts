import { create } from 'zustand'
import type { ApprovalRequest, Notice, RecallHit, Shelf, Step } from './lib/bridge'
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
 * A card Jett composed. Rendered on a blade now — panels and blades used to be
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
  role: 'user' | 'jett'
  text: string
  /** Tools used while producing this turn, for the activity line. */
  tools?: string[]
  /** Second-brain items this answer drew on, shown as source chips. */
  sources?: RecallHit[]
  at: number
}

/** Items lit up on the map, and why. A new `at` re-runs the flight. */
export type Lit = { ids: string[]; mode: 'recall' | 'search' | 'open' | 'new'; at: number }

const TRANSCRIPT_KEY = 'jett.transcript'
const PREFS_KEY = 'jett.prefs'

type Prefs = { muted: boolean; voice: string; accent: string | null }

/**
 * He was called Emrys before he was Jett. What this browser kept under the old
 * name — the transcript, the settings, the map's layout — comes across once.
 */
try {
  for (const key of ['transcript', 'prefs', 'voice', 'layout.v1']) {
    const old = localStorage.getItem(`emrys.${key}`)
    if (old === null) continue
    if (localStorage.getItem(`jett.${key}`) === null) localStorage.setItem(`jett.${key}`, old)
    localStorage.removeItem(`emrys.${key}`)
  }
} catch {
  /* private window */
}

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
    if (!Array.isArray(raw)) return []
    // Turns saved before the rename carry his old name as their role.
    return raw.slice(-80).map((t) => (t.role === 'user' ? t : { ...t, role: 'jett' }))
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

/**
 * `?mute=1` opens him silent — for a quiet room, or a second window that should
 * not talk over the first. It is read here and nowhere else: everything that
 * makes a sound asks the store whether he is muted, so one flag covers every
 * voice he has. Not saved; the next ordinary launch speaks again.
 */
const mutedByUrl = (() => {
  try {
    return new URLSearchParams(window.location.search).get('mute') === '1'
  } catch {
    return false
  }
})()

let badgeTimer = 0

/** One piece of the build on the bench, as the checklist shows it. */
export type BenchPart = {
  name: string
  /** A few words on what it is. */
  label: string
  state: 'writing' | 'running' | 'ok' | 'failed' | 'repairing'
}

/** The build on the workshop bench. The 3D itself lives in the sealed stage; this is what is drawn around it. */
export type Bench = {
  id: string
  title: string
  request: string
  status: 'building' | 'changing' | 'ready' | 'error'
  parts: BenchPart[]
  exploded: boolean
  light: 'studio' | 'day' | 'sunset' | 'night'
  /** One line under the title: what is happening, or what was just done. */
  note: string
  /** When the work now under way began; 0 while the bench is at rest. */
  since: number
}

type State = {
  phase: Phase
  /** 0..1 loudness — the user's mic while listening, Jett's voice while speaking. */
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
  /** Set while Jett is looking through the camera or at the screen. */
  looking: string | null
  /** True while the user is sharing their screen with him. */
  sharing: boolean
  /** True while the Mac app can hear ⌥ and listen: ⌥ then works from any app. */
  helper: boolean
  /** What the Mac app is still waiting for, e.g. ['microphone']. Empty when ready or absent. */
  helperMissing: string[]
  panels: Panel[]
  blades: Blade[]
  focusedBlade: string | null
  expandedBlade: string | null
  approval: ApprovalRequest | null
  notices: Notice[]
  /** What he and his agents are doing, oldest first — the core's activity list. */
  steps: Step[]
  /** Which side of the right-hand column is showing: what was said, or the work. */
  side: 'talk' | 'activity'
  /** What is on the workshop bench, if anything. It takes the centre of the screen while it is. */
  bench: Bench | null

  // The second brain.
  graph: Graph | null
  graphVersion: number
  selected: string | null
  item: BrainItem | null
  lit: Lit | null
  hovered: string | null

  // Settings.
  tier: Tier
  /** Which brain is answering: Claude, or a model on this Mac. */
  shelf: Shelf
  /** The BRAIN / VOICE badge, shown for a few seconds after a switch. */
  badge: boolean
  muted: boolean
  voiceId: string
  accent: string | null

  setApproval: (a: ApprovalRequest | null) => void
  setNotices: (n: Notice[]) => void
  setSteps: (steps: Step[]) => void
  setSide: (side: 'talk' | 'activity') => void
  putStep: (step: Step) => void
  setBench: (bench: Bench | null) => void
  /** These three do nothing unless `id` is the build that is on the bench now. */
  patchBench: (id: string, patch: Partial<Bench>) => void
  putBenchPart: (id: string, part: BenchPart) => void
  dropBenchPart: (id: string, name: string) => void
  setVoice: (v: string) => void
  setGestures: (on: boolean) => void
  setLooking: (why: string | null) => void
  setSharing: (on: boolean) => void
  setHelper: (on: boolean, missing?: string[]) => void
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
  setShelf: (s: Shelf) => void
  flashBadge: () => void
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
  helper: false,
  helperMissing: [],
  panels: [],
  blades: [],
  focusedBlade: null,
  expandedBlade: null,
  approval: null,
  notices: [],
  steps: [],
  side: 'talk',
  bench: null,

  graph: null,
  graphVersion: 0,
  selected: null,
  item: null,
  lit: null,
  hovered: null,

  tier: 'voice',
  shelf: { mode: 'cloud', model: null },
  badge: false,
  muted: mutedByUrl || prefs.muted,
  voiceId: prefs.voice,
  accent: prefs.accent,

  setApproval: (approval) => set({ approval }),
  setNotices: (notices) => set({ notices }),
  setSteps: (steps) => set({ steps: steps.slice(-400) }),
  setSide: (side) => set({ side }),
  // A step arrives when it starts and again when it changes; the newest are at
  // the end, so that is where to look for the one being changed.
  putStep: (step) =>
    set((s) => {
      for (let i = s.steps.length - 1; i >= 0 && i >= s.steps.length - 400; i--) {
        if (s.steps[i].id !== step.id) continue
        const steps = s.steps.slice()
        steps[i] = step
        return { steps }
      }
      return { steps: [...s.steps.slice(-399), step] }
    }),
  setBench: (bench) => set({ bench }),
  patchBench: (id, patch) => set((s) => (s.bench?.id === id ? { bench: { ...s.bench, ...patch } } : {})),
  putBenchPart: (id, part) =>
    set((s) => {
      if (s.bench?.id !== id) return {}
      const at = s.bench.parts.findIndex((p) => p.name === part.name)
      const parts = s.bench.parts.slice()
      if (at < 0) parts.push(part)
      else parts[at] = part
      return { bench: { ...s.bench, parts } }
    }),
  dropBenchPart: (id, name) =>
    set((s) => (s.bench?.id === id ? { bench: { ...s.bench, parts: s.bench.parts.filter((p) => p.name !== name) } } : {})),
  setVoice: (voice) => set({ voice }),
  setGestures: (gestures) => set({ gestures }),
  setLooking: (looking) => set({ looking }),
  setSharing: (sharing) => set({ sharing }),
  setHelper: (helper, helperMissing = []) => set({ helper, helperMissing }),

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
      if (!last || last.role !== 'jett') return {}
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
  setShelf: (shelf) => set({ shelf }),
  flashBadge: () => {
    set({ badge: true })
    window.clearTimeout(badgeTimer)
    badgeTimer = window.setTimeout(() => set({ badge: false }), 5000)
  },
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
  ;(window as unknown as Record<string, unknown>).__jett = new Proxy(
    {} as Record<string, unknown>,
    {
      get: (_t, key) => (useStore.getState() as Record<string | symbol, unknown>)[key],
    },
  )
}
