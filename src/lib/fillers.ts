/**
 * Filler speech.
 *
 * A tool call can take ten seconds, and silence that long reads as a crash. So
 * Emrys says something short the instant work starts — then goes quiet until
 * he has an answer. One line, no progress chatter.
 *
 * The same goes for a slow start: when the first word of an answer is late, a
 * person would make a small noise of attention rather than stare. `stall` is
 * that noise, said once, only when the wait has already become noticeable.
 *
 * Plain, natural lines. No honorifics here — how the user likes to be addressed
 * is in their own notes, and the model handles that in what it actually says.
 */

/** Said as soon as the first tool fires, before any answer exists. */
const WORKING = ['On it.', 'One sec.', 'Looking now.', 'Give me a second.', 'Checking.', 'Let me see.']

/** Acknowledging an order where no tool is involved. */
const ACKNOWLEDGE = ['Sure.', 'Got it.', 'Okay.', 'Will do.']

/** Answering to his name, before the user has said what they want. */
const ATTENTION = ['Yes?', 'Hey.', "I'm here.", 'Go ahead.']

/** When the answer is slow to start. Quiet and short — it is a breath, not a sentence. */
const STALL = ['One sec.', 'Let me think.', 'Okay, one moment.', 'Right, let me see.', 'Give me a second.']

/**
 * Avoids repeating the same phrase twice running, which is what makes canned
 * lines sound canned. Keeps one slot of history per pool.
 */
function makePicker(pool: string[]) {
  let last = -1
  return () => {
    if (pool.length < 2) return pool[0] ?? ''
    let i = last
    while (i === last) i = Math.floor(Math.random() * pool.length)
    last = i
    return pool[i]
  }
}

export const working = makePicker(WORKING)
export const acknowledge = makePicker(ACKNOWLEDGE)
export const attention = makePicker(ATTENTION)
export const stall = makePicker(STALL)

/**
 * Naming the task is warmer than a generic acknowledgement and shows the
 * integration off on camera. Still participial, still under five words.
 *
 * MCP tool names are `mcp__<server>__<tool>`, and the two halves say different
 * things: the server is who is being asked, the tool is what is being asked
 * for. Matching one flat substring against the whole string gets both wrong —
 * `mcp__playwright__browser_click` announced a web search because "browse"
 * appeared earlier in the table than "browser", `Get-Report` looked like a code
 * repository, `Get-Events` like a calendar entry, and "highlight" like a lamp.
 *
 * So: split the name, match the halves separately, order the table so the
 * specific beats the general, and put word boundaries on the short words that
 * hide inside longer ones. Either half matching is enough — the server is the
 * better signal when a name gives one, but plenty of them don't.
 */
type Rule = {
  /** Matched against the server segment, if there is one. */
  server?: RegExp
  /** Matched against the tool segment, or the whole name for a built-in. */
  tool?: RegExp
  lines: string[]
}

const FOOTAGE = ['Putting the video together.', 'Rendering.']

const BY_TOOL: Rule[] = [
  // His own memory and second brain: fast, and better named than hidden.
  { server: /^brain$|emrys_brain/, tool: /search_brain|open_note/, lines: ['Let me check my notes.', 'Looking through your notes.', 'Checking.'] },
  { server: /^brain$|emrys_brain/, tool: /remember|write_note|forget/, lines: ['Noting that.', 'Got it.'] },
  { server: /^eyes$|emrys_eyes/, tool: /screen/, lines: ['Looking at your screen.', 'Let me see.'] },
  { server: /^eyes$|emrys_eyes/, lines: ['Let me look.', 'Taking a look.'] },
  { server: /^mac$|emrys_mac/, lines: ['On it.', 'Doing that now.'] },
  { tool: /^websearch$|^webfetch$|web search|web fetch/, lines: ['Searching.', 'Looking it up.'] },
  { tool: /^grep$|^glob$|^read$/, lines: ['Looking through your files.', 'Checking your files.'] },
  // Video sits above image because higgsfield and palmier both do either, so
  // the verb in the tool name is the only thing separating them — a rule on the
  // server alone would send every generate_video to "Rendering."
  { tool: /video|footage|\bclip\b|\breel\b|talking_head/, lines: FOOTAGE },
  {
    server: /higgsfield|openrouter-image|dalle|flux|midjourney/,
    tool: /image|photo|thumbnail|render|upscale|seedream/,
    lines: ['Making it now.', 'Rendering.'],
  },
  // The editors, once the two rules that read the verb have had their turn.
  { server: /palmier|heygen|runway|descript/, lines: FOOTAGE },
  {
    server: /playwright|puppeteer|browserbase|chrome/,
    tool: /\bbrowser\b|navigate/,
    lines: ['Opening it up.', 'Pulling up the page.'],
  },
  {
    server: /android|\badb\b|simulator/,
    tool: /\bdevice\b|\bapk\b|\bphone\b/,
    lines: ['Reaching your phone.'],
  },
  {
    server: /gmail|\bmail\b/,
    tool: /gmail|\bmail\b|email|inbox/,
    lines: ['Checking your mail.', 'Looking at your inbox.'],
  },
  // Calendar keys off "calendar" alone. "event" used to live here, which is how
  // a Mixpanel event query came out as "Checking your calendar."
  {
    tool: /calendar|\bdiary\b|\bmeeting\b/,
    lines: ['Checking your calendar.', 'Looking at your calendar.'],
  },
  {
    server: /elevenlabs|openai-tts/,
    tool: /speech|\bvoice\b|\btts\b|text_to_sound/,
    lines: ['Making the audio.'],
  },
  {
    server: /spotify|sonos/,
    tool: /\bplay\b|\bmusic\b|playlist|\btrack\b/,
    lines: ['Queuing it up.', 'Putting it on.'],
  },
  {
    server: /^home|homeassistant|\bhue\b|\bhass\b/,
    tool: /\blights?\b|thermostat|\bdimmer\b/,
    lines: ['Adjusting it.', 'Doing that now.'],
  },
  {
    server: /github|linear|jira|sentry/,
    tool: /\brepo\b|repository|\bissues?\b|pull_request|\bcommit\b/,
    lines: ['Checking the repo.', 'Looking at the tracker.'],
  },
  // Also where the anonymously named analytics servers land — theirs are bare
  // UUIDs, so only the tool half says anything: Get-Report, Get-Events,
  // Run-Query. "report" is safe from the repository rule above because that one
  // is bounded.
  {
    server: /mixpanel|clarity|posthog|amplitude/,
    tool: /analytic|\bmetrics?\b|\breports?\b|\bevents?\b|cohort|funnel|dashboard|\bquery\b/,
    lines: ['Pulling the numbers.', 'Running the numbers.'],
  },
  {
    server: /\bexa\b|serper|serpapi|perplexity|tavily|brave/,
    tool: /search|\bweb\b|\bfetch\b|crawl|research/,
    lines: ['Searching.', 'Looking it up.'],
  },
]

const pickers = BY_TOOL.map((r) => ({ ...r, pick: makePicker(r.lines) }))

/**
 * `mcp__<server>__<tool>`, split on the first separator so tool names keep
 * their own underscores (`browser_click`, `text_to_speech`). A built-in like
 * WebSearch or Bash has no server half.
 *
 * The second form matters more than it looks: the bridge client prettifies
 * names for the HUD badge before handing them on, so what actually arrives
 * here is `higgsfield · generate image`. Parsing only the raw form meant every
 * rule below silently missed and every tool got the generic line.
 */
function split(toolName: string): { server: string; tool: string } {
  const raw = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (raw) return { server: raw[1].toLowerCase(), tool: raw[2].toLowerCase() }

  const pretty = toolName.split(' · ')
  if (pretty.length === 2) {
    return { server: pretty[0].toLowerCase(), tool: pretty[1].toLowerCase() }
  }

  return { server: '', tool: toolName.toLowerCase() }
}

/** A phrase suited to the tool that just fired. */
export function forTool(toolName: string): string {
  const { server, tool } = split(toolName)
  for (const r of pickers) {
    const hit =
      (r.server !== undefined && server !== '' && r.server.test(server)) ||
      (r.tool !== undefined && r.tool.test(tool))
    if (hit) return r.pick()
  }
  // Read, Bash, Grep and anything unrecognised: better a neutral line than a
  // confident wrong one.
  return working()
}
