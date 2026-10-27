import { useEffect, useRef, useState } from 'react'
import { BrainMap } from './ui/brain/BrainMap'
import { MemoryPanel } from './ui/MemoryPanel'
import { Conversation } from './ui/Conversation'
import { TopBar } from './ui/TopBar'
import { Presence } from './ui/Presence'
import { Blades } from './ui/Blades'
import { Diagnostics } from './ui/Diagnostics'
import { Pointer } from './ui/Pointer'
import { GestureGuide } from './ui/GestureGuide'
import { useStore, type Tier } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as hands from './lib/hands'
import * as camera from './lib/camera'
import * as screen from './lib/screen'
import { PUSH_TO_TALK } from './config'
import { forTool, attention, stall } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  watchApprovals,
  watchNotices,
  watchBrain,
  connectedLabels,
  usingBridge,
  type Msg,
  type RecallHit,
} from './lib/brain'
import { fetchGraph } from './lib/memory'
import { answerFromSpeech, decide } from './lib/approval'
import { startAnalyser, stopAnalyser, micLevel } from './lib/audio'
import { caps, probeCapabilities } from './lib/capabilities'
import { env } from './config'

/**
 * Emrys.
 *
 * The page opens straight into the live interface — no ignition screen, no
 * start-up sequence, no music. The core is always running, so there is nothing
 * to wait for: the socket connects, the map loads, and he is ready.
 *
 * The conversation is an event machine. Speech, typing, the talk key, approvals
 * and the core's pushes are all events legal in every phase: saying or typing
 * anything stops him talking, and becomes the next turn.
 */

/** Hands-free mode: how long to wait for speech after his name, and for a follow-up. */
const AWAIT_SPEECH_MS = 14000
const FOLLOW_UP_MS = 11000

/** A first word later than this gets a small spoken "one sec" — silence that long reads as a hang. */
const STALL_MS = 2200

const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The ways speech recognition hears "Emrys". */
const NAME = "(?:emrys|emris|emeris|emerys|emmerys|emory's|emorys|emrees|amrys|amris|imris|embrys)"
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)
  const turn = useRef(0)
  const started = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Notes recalled for the turn in flight, attached to his answer when it starts. */
  const recalled = useRef<RecallHit[]>([])
  const announced = useRef(new Set<string>())
  const [draft, setDraft] = useState('')

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const standBy = () => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('dormant')
  }

  /** Stop him mid-answer. The turn in flight is abandoned, not finished. */
  const cutOff = () => {
    silence()
    turn.current++
    interrupt()
    store.getState().setActiveTool(null)
    sfx.duck(false)
  }

  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    idleTimer.current = setTimeout(standBy, window)
  }

  const awaitMore = () => {
    if (PUSH_TO_TALK) standBy()
    else listen(AWAIT_SPEECH_MS)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    s.clearBlades()
    s.setCaption('')
    s.setError(null)
    s.pushTurn({ id: newId(), role: 'user', text: said, at: Date.now() })
    s.setPhase('thinking')
    recalled.current = []

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)

    const turnId = newId()
    let begun = false
    let filled = false
    const tools: string[] = []

    // A slow start gets a small spoken beat, once — the way a person says "hm"
    // rather than stare. Never when he is muted, never once he has begun.
    const stallTimer = setTimeout(() => {
      if (stale() || begun || filled || store.getState().muted) return
      filled = true
      spk.say(stall())
    }, STALL_MS)

    const ensureTurn = () => {
      if (begun) return
      begun = true
      store.getState().pushTurn({
        id: turnId,
        role: 'emrys',
        text: '',
        at: Date.now(),
        sources: recalled.current.length ? recalled.current : undefined,
        tools: tools.length ? [...tools] : undefined,
      })
    }

    try {
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!begun) {
            ensureTurn()
            store.getState().setPhase('speaking')
            store.getState().setActiveTool(null)
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          tools.push(name)
          if (begun) store.getState().patchTurn(turnId, { tools: [...tools] })
          if (!begun) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          // One line the moment work starts, so a slow tool is not dead air.
          if (!filled && !begun) {
            filled = true
            spk.say(forTool(name))
          }
        },
      })

      if (stale()) return
      if (!begun && text) {
        ensureTurn()
        store.getState().appendToLastTurn(text)
        spk.push(text)
      }
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) history.current = history.current.slice(-16)
      }
      await spk.end()
      if (stale()) return
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store.getState().setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      clearTimeout(stallTimer)
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        store.getState().setActiveTool(null)
        if (PUSH_TO_TALK) standBy()
        else listen(FOLLOW_UP_MS)
      }
    }
  }

  /** Typed or clicked: a turn like any other, interrupting whatever he is saying. */
  const send = (text: string) => {
    sfx.unlock()
    const s = store.getState()
    if (s.approval) {
      const answer = answerFromSpeech(text)
      if (answer !== null) {
        decide(answer)
        return
      }
      decide(false)
    }
    if (s.phase === 'thinking' || s.phase === 'tooling' || s.phase === 'speaking') cutOff()
    else silence()
    void respond(text)
  }

  // -- voice events ---------------------------------------------------------

  const mode = (): VoiceMode => {
    const s = store.getState()
    if (s.approval && s.phase !== 'offline' && s.phase !== 'boot' && s.phase !== 'dormant') return 'command'
    switch (s.phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard'
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return
    store.getState().setError(null)
    sfx.play('wake')
    if (trailing) {
      void respond(trailing)
      return
    }
    store.getState().setPhase('waking')
    const fresh = store.getState().notices.find((n) => !announced.current.has(n.id))
    if (fresh) announced.current.add(fresh.id)
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(fresh ? `Your ${fresh.title.toLowerCase()} is ready.` : attention())
    void greeting.end()
    listen(AWAIT_SPEECH_MS)
  }

  const onSpeechStart = () => {
    clearIdle()
    if (PUSH_TO_TALK) return
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return
    if (store.getState().approval) return
    if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') cutOff()
    else silence()
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return
    if (phase === 'dormant' && !PUSH_TO_TALK) return

    if (store.getState().approval) {
      if (BARE_NAME.test(text)) return
      const answer = answerFromSpeech(text.replace(LEADING_NAME, ''))
      if (answer !== null) {
        decide(answer)
        return
      }
      decide(false)
    }
    if (BARE_NAME.test(text)) {
      awaitMore()
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      awaitMore()
      return
    }
    void respond(said)
  }

  // -- push-to-talk ---------------------------------------------------------

  const holding = useRef(false)

  const pressTalk = () => {
    const s = store.getState()
    if (!voice.current || holding.current) return
    holding.current = true
    sfx.unlock()
    s.setError(null)
    clearIdle()
    if (!s.approval) {
      if (s.phase === 'thinking' || s.phase === 'tooling' || s.phase === 'speaking') cutOff()
      else silence()
      s.setCaption('')
      s.setPhase('listening')
    }
    sfx.play('listen')
    // The level meter for the orb, only while the key is down — the microphone
    // light should mean he is listening, and only then.
    void startAnalyser().catch(() => {})
    void voice.current.hold(true)
  }

  const releaseTalk = () => {
    if (!voice.current || !holding.current) return
    holding.current = false
    stopAnalyser()
    void voice.current.hold(false).then((heard) => {
      if (heard) return
      const s = store.getState()
      if (s.approval) return
      if (s.phase === 'listening') standBy()
    })
  }

  // -- the second brain -----------------------------------------------------

  const loadGraph = useRef<() => void>(() => {})
  loadGraph.current = () => {
    void fetchGraph()
      .then((g) => {
        // Same nodes and lines as before — a conversation file grew, a summary
        // landed — keeps the map as it is. Re-running the layout for that
        // would nudge every point after every turn.
        const old = store.getState().graph
        const shape = (x: typeof g) => `${x.nodes.map((n) => n.id).join('|')}#${x.links.length}`
        if (old && shape(old) === shape(g)) {
          old.nodes.forEach((n, i) => {
            n.label = g.nodes[i].label
            n.date = g.nodes[i].date
          })
          store.getState().setGraphVersion(g.version)
          return
        }
        store.getState().setGraph(g)
      })
      .catch(() => {})
  }

  // -- start ----------------------------------------------------------------

  const start = async () => {
    if (started.current) return
    started.current = true
    const s = store.getState()
    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    watchCapture(async (req) => {
      if (req.source === 'screen') {
        if (!screen.sharing()) {
          return {
            error:
              'The user is not sharing their screen. Ask them to click "Share screen" at ' +
              'the top right of your window, then look again.',
          }
        }
        store.getState().setLooking(req.reason || 'your screen')
        try {
          return screen.grabScreen()
        } catch (err) {
          return { error: `The screen could not be read: ${(err as Error)?.message ?? err}` }
        } finally {
          setTimeout(() => store.getState().setLooking(null), 600)
        }
      }
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen for me to ' +
            'remember what just happened. Ask me to open the camera, and I can watch from then on.',
        }
      }
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    watchUi((op, args) => {
      const st = store.getState()
      const a = (args ?? {}) as Record<string, unknown>
      if (op === 'theme') st.setAccent(typeof a.accent === 'string' && a.accent ? a.accent : null)
      else if (op === 'screen') st.clearScreen((a.what as 'all' | 'blades' | 'transcript') ?? 'blades')
    })

    watchConnection((state) => {
      if (state === 'lost') {
        decide(false)
        store.getState().setError('Lost the connection to Emrys’s core — reconnecting.')
      } else {
        store.getState().setError(null)
        loadGraph.current()
      }
    })

    watchApprovals({
      open: (req) => {
        store.getState().setApproval(req)
        sfx.play('wake')
      },
      close: (id) => {
        if (store.getState().approval?.id === id) store.getState().setApproval(null)
      },
    })

    watchNotices((items) => {
      const known = new Set(store.getState().notices.map((n) => n.id))
      store.getState().setNotices(items)
      if (items.some((n) => !known.has(n.id))) sfx.play('done')
    })

    // The second brain talking to the interface.
    let graphTimer = 0
    watchBrain((e) => {
      const st = store.getState()
      if (e.type === 'version') {
        if (e.version !== st.graph?.version) {
          clearTimeout(graphTimer)
          graphTimer = window.setTimeout(() => loadGraph.current(), 250)
        }
      } else if (e.type === 'recall') {
        recalled.current = e.hits
        st.light(
          e.hits.map((h) => h.id),
          'recall',
        )
      } else if (e.type === 'focus') {
        if (e.mode === 'open' && e.ids[0]) st.select(e.ids[0])
        st.light(e.ids, e.mode)
      } else if (e.type === 'tier') {
        st.setTier(e.tier as Tier)
      }
    })

    loadGraph.current()
    const warming = warm().catch((err: Error) => s.setError(err.message))
    if (!usingBridge && !env.anthropicKey) {
      s.setError('No Anthropic API key — set VITE_ANTHROPIC_API_KEY, or use the core (the default).')
    }

    await warming
    store.getState().setConnected(connectedLabels())
    await probeCapabilities()
    store.getState().setVoice(currentVoiceName())
    // The voice engine may come up after the page does (its first start
    // downloads the model). Follow it, so the picker and the voice appear.
    const followVoice = window.setInterval(() => {
      store.getState().setVoice(currentVoiceName())
      if (caps().local) window.clearInterval(followVoice)
    }, 3000)

    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial: (text) => store.getState().setCaption(text),
      onUtterance,
      onError: (message) => store.getState().setError(message),
      pushToTalk: PUSH_TO_TALK,
    })

    store.getState().setPhase('dormant')
  }

  // -- life -----------------------------------------------------------------

  useEffect(() => {
    void start().catch((err) => {
      started.current = false
      console.error('[emrys] start failed:', err)
      store.getState().setPhase('offline')
      store.getState().setError(err instanceof Error ? err.message : 'Could not start.')
    })

    screen.watchScreen((on) => store.getState().setSharing(on))

    let raf = 0
    const pump = () => {
      const st = store.getState()
      const lvl = st.phase === 'speaking' && speaker.current ? speaker.current.level() : micLevel()
      if (Math.abs(lvl - st.level) > 0.01) st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    // Audio can only start after the page has been interacted with. Any first
    // click or key does it.
    const unlock = () => sfx.unlock()
    window.addEventListener('pointerdown', unlock, { once: true })

    const typing = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    const onKey = (e: KeyboardEvent) => {
      // ⌥ on its own is the talk key — even from the text box, since it types
      // nothing there on its own.
      if (PUSH_TO_TALK && e.key === 'Alt') {
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault()
          pressTalk()
        }
        return
      }
      // Any other key while ⌥ is held is a shortcut or a special character —
      // the user is typing, not talking.
      if (holding.current && e.altKey) {
        holding.current = false
        stopAnalyser()
        void voice.current?.hold(false)
        standBy()
      }

      if (e.key === 'Escape') {
        const st = store.getState()
        if (st.phase === 'thinking' || st.phase === 'tooling' || st.phase === 'speaking') {
          cutOff()
          standBy()
        } else if (st.blades.length) st.clearScreen('blades')
        else if (st.selected) st.select(null)
        return
      }

      if (typing(e)) return

      if (store.getState().approval && (e.key === 'y' || e.key === 'n') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        decide(e.key === 'y')
        return
      }

      // G turns the camera and hand tracking on and off.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        if (store.getState().gestures) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store.getState().setError(`Gesture control failed to start: ${err?.message ?? err}`)
            })
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (PUSH_TO_TALK && e.key === 'Alt') releaseTalk()
    }
    const onLeave = () => {
      if (PUSH_TO_TALK) releaseTalk()
    }
    const onVisibility = () => {
      if (document.hidden) onLeave()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onLeave)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onLeave)
      window.removeEventListener('pointerdown', unlock)
      document.removeEventListener('visibilitychange', onVisibility)
      clearIdle()
      voice.current?.stop()
      speaker.current?.cancel()
      hands.disableHands()
      screen.stopScreenShare()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const gestures = useStore((s) => s.gestures)
  const blades = useStore((s) => s.blades)
  const accent = useStore((s) => s.accent)

  // One variable carries a retint into every rule that uses the accent.
  useEffect(() => {
    const root = document.documentElement
    if (accent) root.style.setProperty('--accent', accent)
    else root.style.removeProperty('--accent')
  }, [accent])

  return (
    <div className="app">
      <TopBar onBrief={() => send('Brief me.')} />
      <MemoryPanel onAsk={send} />
      <main className="stage">
        <BrainMap />
        <div className={`stage-blades${blades.length ? ' has-blades' : ''}`}>
          <Blades />
        </div>
        <Presence />
      </main>
      <Conversation
        onSend={send}
        onHold={(down) => (down ? pressTalk() : releaseTalk())}
        draft={draft}
        setDraft={setDraft}
      />
      <Diagnostics />
      <Pointer />
      <GestureGuide live={gestures} />
    </div>
  )
}
