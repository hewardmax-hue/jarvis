/**
 * The tool gate: what Emrys may do without asking, what he must ask for, and
 * what he may not do at all.
 *
 * It lives apart from server.mjs because more than the voice session needs it
 * now. The scheduler runs jobs with no one at the screen, and `npm run job`
 * runs one from a terminal; all three have to draw the same line between a
 * read and a write, or the background half of Emrys would quietly be held to
 * a different standard from the half you can hear.
 */

import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from './home.mjs'

/**
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world goes to the policy in ~/.emrys/policy.json
 * (see `verdict` at the bottom), which by default asks you first.
 *
 * EMRYS_ALLOW_WRITES=1 is the old blanket switch and still works: with it set,
 * every write runs without asking. That is the demo mode, not the daily one.
 */
export const ALLOW_WRITES = (process.env.EMRYS_ALLOW_WRITES ?? process.env.Emrys_ALLOW_WRITES) === '1'

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

export const MCP_SERVERS = configuredServers()

/** MCP tools arrive as `mcp__<server>__<tool>`. */
const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

/** The browser tools that act on a page rather than read it. */
const CHROME_ACTS = new Set([
  'chrome_click', 'chrome_type', 'chrome_key', 'chrome_form_input',
  'chrome_new_tab', 'chrome_close_tab',
])

/**
 * True when a tool can run without anyone being asked: a read, a generation,
 * Emrys’s own interface and notebook — or anything at all under ALLOW_WRITES.
 * False means it changes something, and `verdict` decides what happens next.
 */
export function decideTool(name) {
  if (READ_ONLY_BUILTINS.has(name)) return true
  if (WRITE_BUILTINS.has(name)) return ALLOW_WRITES

  const server = mcpServerOf(name)
  if (server) {
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them Emrys has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind ALLOW_WRITES.
    if (server === 'emrys' || server === 'emrys_ui') return true

    // His own notebook and the second brain: remembering a fact, writing a
    // note, searching, reading back a briefing, starting one of his own jobs.
    // All of it lands in ~/.emrys and nowhere else, so nothing is withheld.
    if (server === 'emrys_brain') return true

    // The Mac. Opening things, notifications, the clipboard and the volume run;
    // AppleScript can drive any app on the machine, so it always asks.
    if (server === 'emrys_mac') return mcpToolOf(name) !== 'applescript' || ALLOW_WRITES

    // The browser. The acting half is named here rather than left to the verb
    // rules, because those would get the reading half wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for. The acting tools are
    // always built now, and asking first is how they are held back.
    if (server === 'emrys_chrome') {
      return !CHROME_ACTS.has(mcpToolOf(name)) || ALLOW_WRITES
    }

    // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'emrys_eyes') return true

    const tool = mcpToolOf(name)
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return ALLOW_WRITES
    }
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    return READ_VERB.test(tool) ? true : ALLOW_WRITES
  }
  return ALLOW_WRITES
}

// ---------------------------------------------------------------------------

/**
 * What happens to a tool that changes something: run it, ask first, or refuse.
 *
 * This is the human-in-the-loop half. The old answer was a single switch —
 * every write refused, or every write allowed — and both ends are wrong for
 * an assistant you actually live with. Refusing everything means he can find
 * the email but never send it; allowing everything means a misheard sentence
 * sends it. Asking is the middle: he drafts, you see exactly what is about to
 * happen, you say yes.
 *
 * ~/.emrys/policy.json holds three lists of tool-name patterns and a default:
 *
 *   { "default": "ask", "allow": [], "ask": [], "deny": ["mcp__android__*"] }
 *
 * `*` matches anything, so "mcp__android__*" is a whole server and "Bash" is
 * one tool. Deny beats allow beats ask, so a deny can never be widened by a
 * broader allow written later. Re-read on every call — editing the file takes
 * effect on the next tool, with nothing to restart — and a file that will not
 * parse falls back to asking for everything rather than to allowing it.
 */
export function verdict(name) {
  if (decideTool(name)) return 'allow'
  const policy = readPolicy()
  const hit = (list) => list.some((pattern) => globMatch(pattern, name))
  if (hit(policy.deny)) return 'deny'
  if (hit(policy.allow)) return 'allow'
  if (hit(policy.ask)) return 'ask'
  return policy.default
}

const VERDICTS = new Set(['allow', 'ask', 'deny'])

function readPolicy() {
  const safe = { default: 'ask', allow: [], ask: [], deny: [] }
  let raw
  try {
    raw = JSON.parse(readFileSync(PATHS.policy, 'utf8'))
  } catch {
    return safe
  }
  const list = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string') : [])
  return {
    default: VERDICTS.has(raw?.default) ? raw.default : 'ask',
    allow: list(raw?.allow),
    ask: list(raw?.ask),
    deny: list(raw?.deny),
  }
}

function globMatch(pattern, name) {
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    'i',
  )
  return re.test(name)
}

/**
 * One line a person can approve or refuse at a glance.
 *
 * The model's own sentence before a write says what it means to do; this says
 * what it is literally about to do, which is the part worth checking. So it
 * shows the payload itself — the command, the path, the text being typed —
 * rather than a paraphrase of it.
 */
export function describeCall(name, input = {}) {
  const pick = (...keys) => keys.map((k) => input?.[k]).find((v) => typeof v === 'string' && v)
  const server = mcpServerOf(name)
  const title = server
    ? `${server.replace(/^emrys_/, '')} · ${mcpToolOf(name).replace(/^chrome_/, '').replace(/[_-]+/g, ' ')}`
    : name
  const detail =
    pick('command', 'script') ??
    pick('file_path', 'path', 'notebook_path') ??
    pick('text', 'value', 'url', 'to', 'subject', 'body', 'message') ??
    JSON.stringify(input)
  return { title, detail: String(detail).slice(0, 600) }
}
