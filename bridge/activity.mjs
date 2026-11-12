/**
 * What he and his agents are doing, as it happens.
 *
 * The conversation shows what was said. This is the other half: every step
 * taken to get there — the question, what was recalled, each tool with exactly
 * what it was given and what came back, an agent handed a piece of work and
 * what it is doing with it, a scheduled job running with nobody watching.
 *
 * One list, newest last, kept for as long as the core runs. Each entry has an
 * id; a step that takes time is put once as `running` and put again when it
 * ends, and every open interface is told both times. An interface that opens
 * late is sent the list as it stands, so the view is never empty just because
 * the window was closed while the work happened.
 *
 *   { id, at, kind, agent, title, detail?, input?, result?, status, ms?, parent?, tool? }
 *
 *   kind    turn · tool · agent · job · recall · brain · build · note
 *   status  running · waiting (for your yes) · done · error · denied · stopped
 */

const MAX = 400

const clip = (value, n) => {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value)
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const OPEN = new Set(['running', 'waiting'])

export function createActivity() {
  const events = []
  const index = new Map()
  const listeners = new Set()
  let seq = 0

  const tell = (event) => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch {
        /* a closed window is not the list's problem */
      }
    }
  }

  const tidy = (patch) => {
    const out = {}
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) out[key] = value
    if ('title' in out) out.title = clip(out.title, 220)
    // What an agent is saying right now: the end of it is the part that is current.
    if ('note' in out) out.note = String(out.note ?? '').trim().slice(-500)
    if ('detail' in out) out.detail = clip(out.detail, 1200)
    if ('input' in out) out.input = clip(out.input, 2400)
    if ('result' in out) out.result = clip(out.result, 1600)
    return out
  }

  /** Add a step. Returns its id. */
  function put(event) {
    const id = event.id ?? `a${Date.now().toString(36)}${++seq}`
    if (index.has(id)) return update(id, event), id
    const entry = { kind: 'note', agent: 'Jett', title: '', status: 'done', ...tidy(event), id, at: Date.now() }
    events.push(entry)
    index.set(id, entry)
    while (events.length > MAX) index.delete(events.shift().id)
    tell(entry)
    return id
  }

  /** Change a step already there. A step nobody put is left alone. */
  function update(id, patch) {
    const entry = id ? index.get(id) : null
    if (!entry) return false
    const was = entry.status
    Object.assign(entry, tidy(patch), { id, at: entry.at })
    if (OPEN.has(was) && !OPEN.has(entry.status) && entry.ms == null) entry.ms = Date.now() - entry.at
    tell(entry)
    return true
  }

  /** Whatever is still open under this step ended when it did. */
  function settle(parent, status = 'done') {
    if (!parent) return
    for (const entry of events) {
      if (entry.parent !== parent || !OPEN.has(entry.status)) continue
      update(entry.id, { status })
      settle(entry.id, status)
    }
  }

  return {
    put,
    update,
    settle,
    has: (id) => index.has(id),
    get: (id) => index.get(id) ?? null,
    list: () => events.slice(),
    running: () => events.filter((e) => OPEN.has(e.status)),
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

// ---------------------------------------------------------------------------
// Saying what a tool call is, in a line a person can read

const BUILTIN = {
  WebSearch: 'Search the web',
  WebFetch: 'Read a web page',
  Read: 'Read a file',
  Grep: 'Search inside files',
  Glob: 'Find files',
  Bash: 'Run a command',
  Write: 'Write a file',
  Edit: 'Edit a file',
  ToolSearch: 'Look for the right tool',
  TodoWrite: 'Update the plan',
  Task: 'Hand work to an agent',
  Agent: 'Hand work to an agent',
}

const NICE = {
  search_brain: 'Search your second brain',
  open_note: 'Open a note',
  write_note: 'Write a note',
  remember: 'Remember a fact',
  forget: 'Forget a fact',
  brain_status: 'Check the second brain',
  briefing: 'Read a briefing',
  read_sop: 'Read a procedure',
  run_job: 'Start a job',
  jobs: 'Check the schedule',
  display: 'Put a card on screen',
  blade: 'Open something on screen',
  probe_url: 'Check a link',
  look: 'Look through the camera',
  watch: 'Watch through the camera',
  look_at_screen: 'Look at your screen',
  switch_model: 'Change gear',
  applescript: 'Run an AppleScript',
  notify: 'Send a notification',
  get_clipboard: 'Read the clipboard',
  set_clipboard: 'Copy to the clipboard',
  set_volume: 'Set the volume',
  mac_status: 'Check the Mac',
}

/** His own servers, by what they are to the person watching. */
const OWN = {
  jett: 'Screen',
  jett_ui: 'Interface',
  jett_chrome: 'Chrome',
  jett_eyes: 'Eyes',
  jett_brain: 'Second brain',
  jett_mac: 'Mac',
}

export const isAgentTool = (name) => name === 'Task' || name === 'Agent'

/** "mcp__claude_ai_Slack__slack_search_public" -> "Slack · search public". */
export function toolTitle(name) {
  if (!name) return 'A tool'
  if (!name.startsWith('mcp__')) return BUILTIN[name] ?? name
  const [, server = '', ...rest] = name.split('__')
  let tool = rest.join(' ')
  if (NICE[tool]) return NICE[tool]
  const where =
    OWN[server] ?? server.replace(/^jett_?/, '').replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim()
  // "slack_read_channel" on the Slack server says Slack twice.
  const first = where.split(' ').at(-1)?.toLowerCase()
  if (first && tool.toLowerCase().startsWith(`${first}_`)) tool = tool.slice(first.length + 1)
  tool = tool.replace(/^ui_/, '').replace(/[_-]+/g, ' ').trim()
  const label = where ? `${where[0].toUpperCase()}${where.slice(1)}` : 'Jett'
  return tool ? `${label} · ${tool}` : label
}

const KEYS = [
  'description', 'query', 'q', 'pattern', 'command', 'script', 'url', 'file_path', 'path',
  'title', 'name', 'subject', 'to', 'channel', 'text', 'prompt', 'message', 'body', 'value', 'id',
]

/** What a call was given: the one thing worth reading at a glance, and all of it for whoever expands the row. */
export function describeInput(input) {
  if (!input || typeof input !== 'object') return { detail: '', input: '' }
  const key = KEYS.find((k) => typeof input[k] === 'string' && input[k].trim())
  let all = ''
  try {
    all = JSON.stringify(input, null, 1)
  } catch {
    all = ''
  }
  return { detail: key ? input[key].trim() : all === '{}' ? '' : all, input: all === '{}' ? '' : all }
}

/** A tool result's text, whatever shape it came back in. Pictures are named, not carried. */
export function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block?.type === 'text') return block.text ?? ''
      if (block?.type === 'image') return '[a picture]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** "deep-work" -> "Deep work". */
export const agentName = (type) => {
  const s = String(type || 'agent').replace(/[_-]+/g, ' ').trim()
  return s ? `${s[0].toUpperCase()}${s.slice(1)}` : 'Agent'
}

// ---------------------------------------------------------------------------
// Following a session's messages

/**
 * A step has started. Called twice for most: when the call begins to stream,
 * with a name and nothing else, and again once it is whole and says what it
 * was given. The second only fills in what the first could not know.
 *
 * `parent` is the agent the call belongs to, when an agent made it; `root` is
 * what it hangs under otherwise — the turn, or the job.
 */
export function begin(activity, id, name, input, { parent = null, root = null, agent = 'Jett' } = {}) {
  if (!id || !name) return
  const given = input && typeof input === 'object' && Object.keys(input).length ? input : null
  const under = parent ?? root ?? undefined

  if (isAgentTool(name)) {
    const patch = given
      ? {
          agent: agentName(given.subagent_type),
          title: given.description || 'A piece of work',
          detail: typeof given.prompt === 'string' ? given.prompt : '',
        }
      : {}
    if (activity.has(id)) return void (given && activity.update(id, patch))
    activity.put({ id, kind: 'agent', tool: name, agent: 'Agent', title: 'Handing work to an agent', status: 'running', parent: under, ...patch })
    return
  }

  const patch = given ? describeInput(given) : {}
  if (activity.has(id)) return void (given && activity.update(id, patch))
  const by = parent ? (activity.get(parent)?.agent ?? 'Agent') : agent
  activity.put({ id, kind: 'tool', tool: name, agent: by, title: toolTitle(name), status: 'running', parent: under, ...patch })
}

/** A step has ended, with what came back. A step that was refused stays refused. */
export function end(activity, id, failed, result) {
  const entry = activity.get(id)
  if (!entry) return
  // What you refused or stopped stays that: the tool's own late "failed" is the echo of it.
  if (entry.status === 'denied' || entry.status === 'stopped') return void activity.settle(id, 'stopped')
  activity.update(id, { status: failed ? 'error' : 'done', result })
  activity.settle(id, failed ? 'stopped' : 'done')
}

/**
 * Follow one message from the Agent SDK: calls that start, on a streamed block
 * or a whole assistant message, and calls that end, on the tool results that
 * come back as a user message. An agent's own words become its note.
 */
export function follow(activity, msg, where = {}) {
  const parent = msg.parent_tool_use_id ?? null
  const at = { ...where, parent }
  if (msg.type === 'stream_event') {
    const block = msg.event?.type === 'content_block_start' ? msg.event.content_block : null
    if (block?.type === 'tool_use') begin(activity, block.id, block.name, null, at)
    return
  }
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? msg.content ?? []) {
      if (block?.type === 'tool_use') begin(activity, block.id, block.name, block.input, at)
      else if (parent && block?.type === 'text' && block.text?.trim()) activity.update(parent, { note: block.text })
    }
    return
  }
  if (msg.type === 'user') {
    const blocks = msg.message?.content
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (block?.type === 'tool_result') end(activity, block.tool_use_id, block.is_error === true, resultText(block.content))
    }
  }
}
