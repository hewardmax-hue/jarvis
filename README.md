# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

And he keeps working when the tab is closed. An **always-on core** runs the
brain as a background service: it remembers you between conversations, runs
scheduled jobs like a **7am morning brief**, and asks before doing anything
that changes the world. See [The always-on core](#the-always-on-core).

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The models.** Work is routed by what it needs (`bridge/models.mjs`):

| Tier | Default | Used for |
|---|---|---|
| voice | `claude-sonnet-5-5`, effort `medium` | the conversation — fast enough to speak |
| deep | `claude-opus-5-5`, effort `high` | the morning brief, and anything the voice hands to its `deep-work` agent |
| fast | `claude-haiku-5-5`, effort `low` | cheap, frequent jobs |

Override with `JARVIS_MODEL` / `JARVIS_EFFORT` (voice), `JARVIS_MODEL_DEEP` /
`JARVIS_EFFORT_DEEP` and `JARVIS_MODEL_FAST`. On startup the bridge prints the
three, e.g. `[jarvis] models: voice claude-sonnet-5-5 (medium) · deep …`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Account connectors.** Connectors you added through your **claude.ai
> account** — Google Calendar, Gmail, Drive and the like — are reachable too,
> through the agent's tool search rather than at startup, so they do not appear
> in the SYSTEMS rail. The same gate applies: `list_events` reads freely,
> `create_event` asks first.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## The always-on core

The interface is not JARVIS. JARVIS is the system underneath it: a machine
that stays awake, a model that thinks, connections to your tools, memory of
who you are, and jobs that run without you opening anything. Six layers:

| | Layer | Here |
|---|---|---|
| **J** | Job runner — the computer that stays awake | the bridge as a launchd service, `caffeinate` on mains power |
| **A** | Agent harness — a model with agency | Claude Agent SDK (Claude Code, headless) |
| **R** | Reasoning model — routed by the work | voice / deep / fast tiers, `bridge/models.mjs` |
| **V** | Virtual connections — tools, with a human in the loop | your MCP servers, Chrome, the camera; approvals, `bridge/gate.mjs` |
| **I** | Instructions & memory | `~/.jarvis` |
| **S** | Skills, schedules & speech | procedures in `~/.jarvis/sops`, `schedules.json`, the voice loop |

### Run it always

```bash
npm run service:install
```

That registers the bridge with launchd: it starts now and at every login,
restarts if it dies, and keeps the Mac awake while it is plugged in (the
display still sleeps). On battery the Mac sleeps as usual, and a job it slept
through runs when it wakes, within the job's `catchUpHours`. After installing,
`npm start` sees the core is up and starts only the face.

```bash
npm run service:status
```

```bash
npm run service:logs
```

```bash
npm run service:uninstall
```

The service runs this folder's code, so restart it after pulling changes
(`npm run service:install` again does that — it rebuilds the interface too).
`--no-stay-awake` on install skips the power assertion.

### Open it as an app

The core also serves the interface itself, at **http://localhost:4180**, so it
is there whenever the service is — no terminal, no `npm start`. Open that
address in Chrome and click **Install J.A.R.V.I.S.** in the address bar (or
⋮ → Cast, save and share → Install page as app). It becomes an app with the
arc-reactor icon, in its own window, in the Dock and Launchpad. Allow the
microphone once in that window and it is remembered.

`npm start` is still there for working on the interface: it runs the live dev
server on 5173 with instant reloads, against the same always-on brain.

### What he knows — `~/.jarvis`

Created on first run. Plain files: open them, edit them, delete what is wrong.

| File | What it is |
|---|---|
| `about-me.md` | Who you are, where, what you do, what you follow. **Fill this in** — the brief is generic until you do. |
| `rules.md` | Standing instructions, followed every time. |
| `memory/facts.md` | What he has been told to remember ("remember that…"). |
| `memory/journal/` | A dated log of what ran and when. |
| `sops/` | Procedures. `morning-brief.md` is the first. |
| `briefings/` | Every finished job's output. |
| `schedules.json` | When each job runs. |
| `policy.json` | What he may do without asking — see [Approvals](#approvals-and-actions). |

All of it is read fresh for every conversation and every job. The
conversation itself survives a reload or a restart: a reconnect within six
hours (`JARVIS_RESUME_HOURS`) picks up where you left off.

### The morning brief

At 07:00 every day, on the deep tier, he works through
`sops/morning-brief.md`: today's calendar and the last day's inbox (read
through your own Chrome, if it is open with the Claude extension), the
weather, the news you follow, and anything you asked him to remember that is
due. The result is saved to `briefings/`, a macOS notification says it is
ready, and the next time you wake him he opens with it. Say **"brief me"**
and he gives you the headline and puts the whole thing on a blade.

Run it now, from a terminal, to see exactly what arrives at seven:

```bash
npm run job
```

Or ask: *"Jarvis, run the morning brief."* Change the time in
`schedules.json`, the content in `sops/morning-brief.md`. Any other procedure
you write there can be scheduled the same way.

Jobs run with nobody watching, so they never change anything: anything not
allowed outright by `policy.json` is refused, and the job writes what it would
have done under **Proposed actions**. They also never write to memory, since
they read your inbox and the open web.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **"Brief me"** | Read out what a job left waiting |
| **"Yes"** / **"No"**, or **Y** / **N** | Answer an approval card |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-sonnet-5-5` | The conversation's model |
| `JARVIS_EFFORT` | `medium` | The conversation's reasoning effort |
| `JARVIS_MODEL_DEEP` | `claude-opus-5-5` | Deep tier: the brief, the `deep-work` agent |
| `JARVIS_EFFORT_DEEP` | `high` | Deep tier effort |
| `JARVIS_MODEL_FAST` | `claude-haiku-5-5` | Fast tier |
| `JARVIS_APP_PORT` | `4180` | Where the core serves the built interface (keep it in 4173-4199) |
| `JARVIS_HOME` | `~/.jarvis` | Where memory, procedures and schedules live |
| `JARVIS_RESUME_HOURS` | `6` | How long a conversation can idle and still resume |
| `JARVIS_STAY_AWAKE` | service: `1` | Hold the Mac awake on mains power |
| `JARVIS_NOTIFY` | on | `0` silences the macOS notification when a job finishes |
| `JARVIS_ALLOW_WRITES` | off | `1` runs every action without asking (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Approvals and actions

Search, generation and lookups run freely. Anything effectful — send, tap,
delete, install, click or type on a page, run a command — **asks first**. He
says what he is about to do; an amber card shows exactly what will run (the
command, the text being typed); you say **"yes"** or **"no"**, press **Y** or
**N**, or click. Silence for ninety seconds, standing him down, or saying
something else entirely all count as no.

`decideTool()` in `bridge/gate.mjs` decides what is a read. What happens to
everything else is yours to set in `~/.jarvis/policy.json`:

```json
{
  "default": "ask",
  "allow": ["mcp__jarvis_chrome__chrome_scroll"],
  "ask": [],
  "deny": ["mcp__android__*", "Bash"]
}
```

Patterns match tool names, `*` matches anything; deny beats allow beats ask.
Changes apply to the next action, with nothing to restart. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

The old blanket switch still exists, for demos where every confirmation costs
a take:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with nobody asked first.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal — or, with the service installed, `npm run service:status` — and that
nothing else is holding port `8787`.

**The morning brief did not arrive.** `npm run service:status` shows the next
and last run and how it went; `npm run service:logs` shows why. A Mac that was
asleep at seven runs it when it wakes, within `catchUpHours`. Calendar and
inbox need Chrome open with the Claude extension; without it those sections
are listed under Gaps.

---

## Security

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`bridge/gate.mjs`) never runs an effectful tool unasked unless
  `policy.json` or `JARVIS_ALLOW_WRITES` says so; a policy file that will not
  parse falls back to asking.
- Background jobs cannot ask, so they cannot act, and they cannot write to
  memory — text from a stranger's email never reaches a later prompt.
  Briefing contents are read through a tool, as data, never put in the system
  prompt.
- The service plist carries configuration only, no keys.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
