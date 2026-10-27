# Emrys

A personal AI assistant for the Mac that you talk to like a person, with a
**second brain**: everything you have told him, everything the two of you have
said, the briefings he writes, your notes and the documents in your folders —
summarised, searchable, and drawn as a map he flies across to show you where
each answer came from.

Hold **⌥ Option** and talk, or type. He answers out loud in a natural voice that
runs on your Mac, does real things through your tools — your Google account,
your own Chrome, the Mac itself, files and the shell — and asks before anything
that changes the world.

The brain is Claude Code, run headless as a library. **The only subscription you
need is Claude Code** — no API keys. The interface is a web page installed as an
app; the core behind it runs all the time as a background service.

---

## What he does

**Conversation.** Short, natural, quick. Hold ⌥ (or the mic button) to talk and
let go to send; nothing is heard otherwise, so a phone call in the same room
stays a phone call. Or type in the box — on a call, typing is the same
conversation. Speak or type over him and he stops.

**Second brain.** Before every message reaches him, the notes that match it are
found and handed over, and they light up on the map before he says a word. He
can search further, open any item in full, write new notes, remember facts and
forget them. See [The second brain](#the-second-brain).

**Doing things.**
- Your Google account — mail, calendar, Drive — through the connectors on your
  Claude account.
- Your own Chrome, signed in to everything, through the Claude extension.
- The Mac: open apps, files and links, notifications, the clipboard, volume,
  what's on screen, and AppleScript for any app with no tool of its own.
- Files and the shell, with Claude Code's own tools.
- Your camera, and your screen when you click **Share screen**.
- Hard thinking, careful writing and research go to a deep-work agent on Opus.
- Jobs while you are away: a **7am morning brief** to start with.

**Models.** Switch between **Quick** (Haiku), **Balanced** (Sonnet, the
default) and **Deep** (Opus) from the top bar, or just say "switch to deep mode".

---

## Install

You need Claude Code installed and logged in (`claude` once), Node.js 20+, and
Chrome.

```bash
npm install
npm run service:install
```

That builds the interface and starts the core as a login service. Open
**http://localhost:4180** in Chrome and choose **Install Emrys** from the
address bar. From then on Emrys is an app with its own icon and window.

`npm run service:install` is also how you update: it rebuilds and restarts.
`npm run service:status` says what is running, how much of the second brain is
indexed, and which voice is in use. `npm run service:logs` shows the core's
output.

The first start downloads the natural voice (about 330MB, once). Until it has
loaded, he speaks with the Mac's built-in voice.

---

## The layout

| Left | Middle | Right |
|---|---|---|
| **Memory** — search, what Emrys knows about you, your sources and how far indexing has got, and the full detail of whatever you pick | **The map** of your second brain, with Emrys at the centre and at the foot of the screen; anything he shows you opens on a card over it | **The conversation** — everything said both ways, the notes each answer drew on as chips you can click, the tools he used, approval cards, and the box to type in |

The top bar holds the model switch, the voice picker, mute (text replies only),
and **Share screen**.

---

## The second brain

Everything lives in `~/.emrys`, as plain files you can open and edit:

| | |
|---|---|
| `notes/` | your notes vault — Markdown, Obsidian-friendly. `[[Links]]` become lines on the map |
| `memory/facts.md` | what he was told to remember, one dated line each |
| `conversations/` | what you and he said, a file a day |
| `briefings/` | what his jobs wrote |
| `about-me.md`, `rules.md` | who you are; standing instructions |
| `brain/sources.json` | which of your folders he reads |
| `brain/index.json` | the index itself — delete it and it rebuilds |

How it works — the approach that holds up in daily use rather than the one that
demos well:

1. **Connectors.** Each source is rescanned every fifteen minutes and Emrys's
   own folders are watched; only what is new or changed is read. Text comes out
   of Markdown, Word, PDF, PowerPoint and Excel with tools macOS already ships.
   Code projects, hidden folders and anything in `exclude` are skipped.
2. **Digest.** Each item is read once by Claude Haiku and given a summary, the
   questions it answers, tags, the people and projects in it, and its key facts.
3. **Search.** BM25 plain-text search over all of that, weighted towards titles
   and summaries, with **recency weighting** so newer items outrank stale ones.
   A few milliseconds — fast enough to run before every message.
4. **Recall.** What you say is searched before the model sees it; strong
   matches go in front of your message as data and light up on the map.
5. **The map.** Items, the folders they live in, and the people and projects
   that connect them, laid out in 3D.

Desktop and Documents are read by default. Edit `~/.emrys/brain/sources.json` to
add folders (Downloads is there, switched off), exclude names, or set
`"digest": false` to keep file contents on this Mac and index by words alone.
Changes are picked up within a minute.

---

## Controls

| | |
|---|---|
| Hold **⌥ Option** | talk; let go to send |
| Mic button | the same, by mouse |
| **Enter** in the box | send a typed message |
| **/** | jump to the message box |
| **Esc** | stop him talking; then close cards; then deselect |
| **Y** / **N** | answer an approval card |
| **E** / **X** / **[** **]** | expand, close and cycle cards |
| **G** | camera and hand gestures on/off |
| **D** | diagnostics |

Hands-free instead of push-to-talk: set `VITE_TALK=wake` in `.env.local` and
reinstall; he then listens for "Emrys".

---

## Approvals and actions

Search, reading and generation run freely. Anything that changes something —
sending, posting, deleting, clicking or typing on a page, running a command or
AppleScript — **asks first**: he says what he's about to do, a card shows
exactly what will run, and you say or click yes or no. Silence for ninety
seconds counts as no.

Set what runs, asks or is refused in `~/.emrys/policy.json`:

```json
{ "default": "ask", "allow": ["mcp__emrys_chrome__chrome_scroll"], "ask": [], "deny": ["mcp__android__*"] }
```

`decideTool()` in `bridge/gate.mjs` decides what counts as a read.

---

## Speed

What keeps a spoken turn fast:

- The page opens straight into the live interface — no start-up sequence.
- The conversation carries ten built-in tools instead of thirty, which cut
  each request from about 43k tokens to 24k.
- A conversation that grows past 60k tokens continues in a fresh session in the
  background; today's conversation and the second brain carry the thread.
- The time rides on every message, so "what time is it" never runs a command.
- The voice is generated a sentence at a time, the next while this one plays,
  and a long first sentence is cut at its first clause so speech starts sooner.
- If the first word is slow, he says a quick "one sec" instead of leaving dead air.
- The map is two draw calls with its glow in a shader, and nothing over it uses
  backdrop blur.

`EMRYS_TRACE=1` logs where each turn's time goes.

---

## Configuration

Core settings are environment variables, passed through by
`npm run service:install` (the old `JARVIS_*` names still work):

| Variable | Default | |
|---|---|---|
| `EMRYS_MODEL` / `EMRYS_EFFORT` | `claude-sonnet-5-5` / `low` | the conversation |
| `EMRYS_MODEL_DEEP` / `EMRYS_EFFORT_DEEP` | `claude-opus-5-5` / `high` | deep work and the morning brief |
| `EMRYS_MODEL_FAST` | `claude-haiku-5-5` | Quick mode and digesting |
| `EMRYS_VOICE` | `bm_george` | default natural voice |
| `EMRYS_VOICE_ENGINE` | | `off` to use the Mac's own voice |
| `EMRYS_ROTATE_TOKENS` | `60000` | when a conversation continues in a fresh session |
| `EMRYS_RESUME_HOURS` | `6` | how long a conversation can be picked back up |
| `EMRYS_HOME` | `~/.emrys` | where everything lives |
| `EMRYS_TRACE` | | `1` to log turn timings |

With an ElevenLabs key (`ELEVENLABS_API_KEY`, or in your elevenlabs MCP config)
he speaks with ElevenLabs and transcribes with Scribe instead.

---

## Troubleshooting

**He can't hear me.** Use the installed app or a real Chrome window, and allow
the microphone. Press **D** for diagnostics.

**No natural voice.** `npm run service:status` says whether it loaded; the first
start downloads it. Meanwhile the Mac's own voice is used.

**The map is empty.** It fills as the brain indexes; the memory panel shows
progress. `npm run service:logs` shows the scan.

**Not reachable.** `npm run service:status`; nothing else should hold ports 8787
and 4180.

---

## Security and privacy

- The core only accepts the app's own origin; the second brain's endpoints
  refuse any request without it.
- Effectful tools never run unasked unless `policy.json` allows them; a policy
  file that will not parse falls back to asking.
- Background jobs cannot act and cannot write to memory.
- Everything recalled, read or found on the web is passed to the model as data,
  never as instructions.
- The second brain's index and notes stay on this Mac. Digesting sends each
  item's text to Claude Haiku once, through your Claude account; turn it off in
  `sources.json`.
- The microphone is only open while you hold the talk key.

MIT licence.
