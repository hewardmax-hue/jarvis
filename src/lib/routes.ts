/**
 * Voice routes: the things said so often, and so plainly, that no model should
 * be in the way of them.
 *
 * Every sentence is looked at here first. If it is one of these it is handled
 * on the spot — in milliseconds, the same way every time, whichever brain is on
 * the shelf and even when none is reachable. Everything else goes to the brain
 * untouched.
 *
 * The bar for a route is high on purpose. A pattern that fires when it should
 * not is far worse than one that misses: a miss just means the model handles it
 * a second slower, but a false hit means he did something nobody asked for. So
 * each one matches the whole sentence, never a phrase somewhere inside it, and
 * anything that leans on the conversation ("remember that", "log what I just
 * said") is left for the model, which has the conversation.
 */

export type Route =
  | { kind: 'stop' }
  | { kind: 'capture'; as: 'fact' | 'note'; text: string }
  | { kind: 'brain'; want: 'local' | 'cloud' | 'status' }
  | { kind: 'mute'; on: boolean }
  | { kind: 'build'; what: string }
  | { kind: 'bench'; do: 'open' | 'last' | 'close' | 'apart' | 'together' | 'print' }
  | { kind: 'camera'; to: 'stop' | 'spin' | 'top' | 'front' | 'back' | 'side' | 'flip' | 'in' | 'out' | 'fit' }
  | { kind: 'light'; to: 'studio' | 'day' | 'sunset' | 'night' }

/** What a sentence is being said over: some commands only mean anything with a build on the bench. */
export type Setting = { bench?: boolean }

/** Politeness and filler around a command, which change nothing about it. */
const LEAD = /^(?:(?:ok(?:ay)?|right|so|and|oh|um+|uh+|please|now|actually)[\s,]+)*(?:(?:can|could|would|will) you (?:please )?|i need you to |i want you to |i'd like you to )?(?:please )?/i
const TAIL = /[\s,]*(?:please|thanks|thank you|for me|now)?[\s.!]*$/i

const STOP =
  /^(?:stop|stop it|stop talking|stop there|wait|hang on|hold on|hold up|that's enough|that'll do|that will do|enough|be quiet|quiet|shush|shh+|never ?mind|cancel that|forget it|shut up)$/i

const GO_LOCAL =
  /^(?:(?:go|switch|change|move|flip)(?: over| back)?(?: to)?|use|run on|think with)(?: your| the| a)? (?:local|offline|private|on-device)(?: brain| model| mode)?$/i
const GO_CLOUD =
  /^(?:(?:go|switch|change|move|flip)(?: over| back)?(?: to)?|use|run on|think with|back to)(?: your| the)? (?:cloud|claude|online)(?: brain| model| mode)?$/i
const WHICH_BRAIN =
  /^(?:which|what) (?:brain|model)(?: are you(?: on| using| running(?: on)?)?| is this| am i talking to)$|^what are you running on$|^are you (?:on )?(?:local|offline|claude|the cloud|in the cloud|on the cloud)$/i

const MUTE = /^(?:mute|mute yourself|go quiet|go silent|silent mode|text only|voice off|turn (?:your|the) voice off)$/i
const UNMUTE =
  /^(?:unmute|unmute yourself|voice on|turn (?:your|the) voice (?:back )?on|speak again|you can (?:talk|speak) again|speak up)$/i

/** "Remember that …", "don't let me forget to …": a fact, kept in memory. */
const FACT =
  /^(?:remember(?: this| that)?[:,]?(?= )|(?:don't|do not) (?:let me )?forget[:,]?(?= )|keep in mind[:,]?(?= )|make sure (?:you|i|we) remember[:,]?(?= ))\s+(?:that\s+)?(.+)$/i
/** "Note to self …", "log this: …": a thought, kept as a note of its own. */
const NOTE =
  /^(?:note to self|(?:make|take|add) a note(?: of this| to self)?|log this|log that|jot (?:this |that )?down|write (?:this|that) down|note down|new note)(?:[\s,:;.—–-]+(?:that\s+)?(.+))?$/i

/** Words that only mean something with the conversation behind them. */
const POINTS_BACK =
  /^(?:it|it's|its|he|he's|she|she's|they|they're|him|her|them|those|these|that|this|what|when|where|who|why|how|if|whether)\b/i
const THIS_IS_A_DATE = /^this (?:morning|afternoon|evening|week|weekend|month|quarter|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
const LEANS_ON_CONTEXT =
  /\b(?:what (?:i|you|we) (?:just )?said|what (?:i|you|we) just|the last thing|the above|that last|from (?:earlier|before)|as i said|like i said)\b/i

/** Is this complete on its own, or does it need the conversation to mean anything? */
function standsAlone(text: string): boolean {
  if (text.split(/\s+/).length < 3) return false
  if (/\?\s*$/.test(text)) return false
  if (POINTS_BACK.test(text) && !THIS_IS_A_DATE.test(text)) return false
  return !LEANS_ON_CONTEXT.test(text)
}

/** As said, tidied: a capital to start and a full stop to end. */
function tidy(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const capped = t[0].toUpperCase() + t.slice(1)
  return /[.!?…"'”’)]$/.test(capped) ? capped : `${capped}.`
}

/**
 * "Build me a …": a physical thing, for the workshop.
 *
 * Only the plainest phrasings are caught here, so that the bench answers at
 * once. Anything looser is left to the brain, which can start a build itself a
 * moment later — so this can afford to miss, and must never grab "build me a
 * website".
 */
const BUILD =
  /^(?:(?:build|design|construct)(?: me| us)? (?=(?:a|an|the) )|(?:make|create) (?:me|us) (?=(?:a|an|the) ))(.+)$/i
const BUILD_MODEL = /^(?:build|make|create|give|show|design)(?: me| us)? (?:a |an )?(?:3-?d|three-?d|three d) model of (.+)$/i
/** Things people ask to have built that are not objects. */
const NOT_A_THING =
  /\b(?:apps?|application|websites?|site|web ?page|page|landing|lists?|to-?do|plan|spreadsheet|sheet|table of|chart|graph|dashboard|e-?mail|message|text|reply|response|answer|script|document|doc|report|summary|brief|briefing|playlist|schedule|calendar|event|meeting|appointment|reservation|booking|presentation|deck|slides?|budget|program|programme|code|bot|chatbot|workflow|automation|routine|sop|reminder|note|memo|draft|post|tweet|thread|caption|ad|advert|campaign|logo|poster|flyer|banner|invoice|quote|proposal|contract|form|survey|quiz|template|database|query|formula|function|api|tool|agent|skill|shortcut|folder|file|account|profile|business|company|brand|team|case|pitch|strategy|forecast|financial|pricing|revenue|sales|marketing|data|machine learning|ml|ai|language|habit|decision|call|coffee|tea|drink|sandwich|meal|dinner|lunch|breakfast|recipe|joke|poem|song|story|essay|speech|image|picture|photo|video|drawing|sketch|diagram|map|search|timeline|shortlist|comparison|wish|guess|change|difference|start|copy|backup|timer|alarm|task|ticket|issue|pull request|commit|branch|game|workout|diet|course|lesson|curriculum|itinerary|trip|holiday|menu|layout|interface|ui|funnel|extension|plugin|component|feature|endpoint|server|calculator|tracker|prompt|persona|name|slogan|tagline|headline|title|bio|cv|resume|résumé|letter|argument|checklist|agenda|roadmap|relationship|rapport|following|audience|career|future|offer|deal|living|fortune|favour|favor|promise|millionaire)\b/i
const NEEDS_THE_CONVERSATION =
  /\b(?:we (?:talked|spoke|discussed|agreed|said)|i (?:mentioned|said|described|sent|showed|told)|you (?:mentioned|said|suggested|showed)|from (?:earlier|before|yesterday|last (?:time|week))|same (?:one|thing)|that one|like (?:that|this|before|last time))\b/i

function build(bare: string): Route | null {
  const model = BUILD_MODEL.exec(bare)
  const what = (model ? model[1] : (BUILD.exec(bare)?.[1] ?? '')).replace(/\?+$/, '').trim()
  if (!what || what.split(' ').length > 30) return null
  if (NOT_A_THING.test(what) || NEEDS_THE_CONVERSATION.test(what)) return null
  if (/^(?:a|an|the)$/i.test(what)) return null
  return { kind: 'build', what }
}

/** "Open the workshop", "bring back the last build": good at any time. */
const OPEN_BENCH =
  /^(?:open|show(?: me)?|go to|bring up|pull up|take me to|switch to) (?:the|my|your) (?:workshop|work ?bench|bench)$/i
const LAST_BUILD =
  /^(?:open|show(?: me)?|bring (?:back|up)|pull up|load|restore|re-?open|get) (?:me )?(?:the|my|our|your|that) (?:last|previous|latest|most recent) (?:build|model|thing (?:you|we) (?:built|made))(?: (?:again|back|up))?$|^(?:open|show me) what (?:you|we) (?:built|made) (?:earlier|before|last(?: time)?)$/i

// Everything below is only listened for while a build is on the bench: "from
// the top" and "night" mean nothing — or something else — without one.
const SEE =
  '(?:(?:show|give) (?:me |us )?(?:it |this |that )?|(?:look at|view|see) (?:it |this |that )?|let me see (?:it |this |that )?|(?:and )?(?:now )?)?'
const CAMERA: [RegExp, Extract<Route, { kind: 'camera' }>['to']][] = [
  [
    new RegExp(
      `^${SEE}(?:from (?:the )?(?:top|above)|(?:the |a )?top(?:-| )?down(?: view)?|(?:the |a )?top view|(?:the |a )?bird'?s(?:-| )eye(?: view)?|(?:from )?overhead)$`,
      'i',
    ),
    'top',
  ],
  [new RegExp(`^${SEE}(?:from (?:the )?front|(?:the |a )?front view|head(?:-| )on)$`, 'i'), 'front'],
  [new RegExp(`^${SEE}(?:from (?:the )?(?:back|rear)|from behind|(?:the |a )?(?:back|rear) view)$`, 'i'), 'back'],
  [new RegExp(`^${SEE}(?:from (?:the )?side|(?:the |a )?side view|side(?:-| )on|in profile)$`, 'i'), 'side'],
  [
    new RegExp(
      `^(?:${SEE}(?:from )?the other side|(?:flip|turn) it (?:over|a?round)|flip it|turn it the other way(?: a?round)?)$`,
      'i',
    ),
    'flip',
  ],
  [
    /^(?:zoom in(?: (?:a (?:bit|little)|more|closer))?|(?:come |go |get |move )?(?:in )?(?:a (?:bit|little) )?closer(?: in| still)?)$/i,
    'in',
  ],
  [
    /^(?:zoom out(?: (?:a (?:bit|little)|more))?|(?:go |move |pull |step )?(?:a (?:bit|little) )?(?:further|farther) (?:out|back|away)|pull back|step back|back up(?: a (?:bit|little))?)$/i,
    'out',
  ],
  [
    /^(?:stop (?:spinning|turning|rotating|moving)|stop (?:it|the) (?:spinning|turning|rotating|spin|rotation)|hold (?:it )?still|keep it still|stay still|freeze(?: it)?)$/i,
    'stop',
  ],
  [/^(?:spin it(?: again| a?round)?|(?:start|keep) spinning(?: again)?|spin again|rotate it|let it spin)$/i, 'spin'],
  [
    /^(?:(?:reset|re-?cent(?:re|er)|cent(?:re|er)) the (?:view|camera)|(?:re-?)?cent(?:re|er) it|show me (?:the whole thing|all of it)|fit it (?:to|on|in) (?:the )?screen|zoom to fit|(?:the )?(?:normal|default|whole) view)$/i,
    'fit',
  ],
]

const LIGHT =
  /^((?:switch|change|set|go|move|turn)(?: it| the (?:lights?|lighting))?(?: over| back)? to |make it |show (?:me )?(?:it |this |that )?(?:in|at|by) |put it (?:in|at) |try (?:it (?:in|at) )?|(?:and )?(?:now )?(?:in|at) )?(?:the )?(studio|day|daylight|daytime|sunset|golden hour|dusk|night|night-?time)((?: ?(?:lights?|lighting|mode|time|scene))?)$/i
/** Said bare, "night" is a goodbye and "day" is nothing at all. */
const NEEDS_MORE = /^(?:day|daytime|night|night-?time|dusk)$/i

const APART =
  /^(?:(?:pull|take|break|blow|split|tear|spread) (?:it|this|that|them|the (?:thing|model|build|parts|pieces)) apart|explode(?: it| the (?:view|model|build))?|(?:show (?:me )?)?(?:an? |the )?exploded view|tear it down|tear ?down|disassemble(?: it)?|take it to (?:bits|pieces)|open it up|show me (?:the (?:parts|pieces)|how it comes apart))$/i
const TOGETHER =
  /^(?:put (?:it|this|that|them|everything) (?:all )?(?:back )?together(?: again)?|put it back|reassemble(?: it)?|(?:back|all) together(?: again)?|close it (?:back )?up|collapse(?: it)?|un-?explode(?: it)?|assemble it(?: again)?|bring it (?:back )?together)$/i
const THREE_D = '(?:3-?d|three-?d|three d)'
const PRINT = new RegExp(
  `^(?:${THREE_D}(?: |-)?print (?:it|this|that|the (?:model|build|parts|thing))|print (?:it|this|that)(?: out)?(?: in ${THREE_D})?|(?:export|save|download|give me|get me) (?:(?:it|this|that|the (?:model|build|parts)) )?(?:for (?:${THREE_D} )?printing|(?:as |to )?(?:an? |the )?stl(?: file)?s?)|send it to the printer|make it printable|get it ready (?:to print|for (?:${THREE_D} )?printing|for the printer))$`,
  'i',
)
const CLOSE_BENCH =
  /^(?:close (?:it|this|that|the (?:bench|workshop|build|model|stage))|clear (?:it|the (?:bench|workshop|stage))(?: away)?|put it away|take it away|(?:exit|leave|quit) the workshop|(?:i'm |i am |we're |we are )?done with (?:it|this|that|the (?:bench|workshop|build|model))|(?:go )?back to the brain|hide (?:it|the (?:bench|workshop|build|model)))$/i

function onTheBench(bare: string): Route | null {
  for (const [said, to] of CAMERA) if (said.test(bare)) return { kind: 'camera', to }
  const light = LIGHT.exec(bare)
  if (light && (light[1] || light[3] || !NEEDS_MORE.test(light[2]))) {
    const word = light[2].toLowerCase()
    const to = word === 'studio' ? 'studio' : /^day/.test(word) ? 'day' : /^night/.test(word) ? 'night' : 'sunset'
    return { kind: 'light', to }
  }
  if (APART.test(bare)) return { kind: 'bench', do: 'apart' }
  if (TOGETHER.test(bare)) return { kind: 'bench', do: 'together' }
  if (PRINT.test(bare)) return { kind: 'bench', do: 'print' }
  if (CLOSE_BENCH.test(bare)) return { kind: 'bench', do: 'close' }
  return null
}

/** The route for a sentence, or null when it is one for the brain. */
export function route(said: string, setting: Setting = {}): Route | null {
  const whole = said.replace(/\s+/g, ' ').trim()
  if (!whole || whole.length > 600) return null
  const bare = whole.replace(LEAD, '').replace(TAIL, '').replace(/[’‘]/g, "'").trim()
  if (!bare) return null

  if (STOP.test(bare)) return { kind: 'stop' }
  if (GO_LOCAL.test(bare)) return { kind: 'brain', want: 'local' }
  if (GO_CLOUD.test(bare)) return { kind: 'brain', want: 'cloud' }
  if (WHICH_BRAIN.test(bare.replace(/\?$/, ''))) return { kind: 'brain', want: 'status' }
  if (MUTE.test(bare)) return { kind: 'mute', on: true }
  if (UNMUTE.test(bare)) return { kind: 'mute', on: false }

  // The workshop. A question mark changes nothing about any of these.
  const plain = bare.replace(/\?+$/, '').trim()
  if (setting.bench) {
    const there = onTheBench(plain)
    if (there) return there
  }
  if (LAST_BUILD.test(plain)) return { kind: 'bench', do: 'last' }
  if (OPEN_BENCH.test(plain)) return { kind: 'bench', do: 'open' }
  const made = build(plain)
  if (made) return made

  // What is kept is what was said — the polite words go, the thought stays whole.
  const kept = whole.replace(LEAD, '').replace(/[’‘]/g, "'").trim()
  const note = NOTE.exec(kept)
  if (note) {
    const text = (note[1] ?? '').trim()
    return text && standsAlone(text) ? { kind: 'capture', as: 'note', text: tidy(text) } : null
  }
  const fact = FACT.exec(kept)
  if (fact) {
    const text = fact[1].trim()
    if (!standsAlone(text)) return null
    // "Remember to call Sam" is a thing to do; kept so that it still reads as one.
    return { kind: 'capture', as: 'fact', text: tidy(/^to\s/i.test(text) ? `Remember ${text}` : text) }
  }
  return null
}
