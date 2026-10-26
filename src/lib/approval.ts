import { useStore } from '../store'
import { answerApproval } from './brain'
import * as sfx from './sfx'

/**
 * Answering an approval card — by voice, by key, or by clicking it.
 *
 * Three ways in, one way out, so the card always comes down and the bridge
 * always hears back exactly once whichever the user reached for.
 */

/** A clear yes. Anchored at the start: "yes, send it" counts, "is it yes?" not. */
const YES =
  /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|go on|proceed|approve|approved|confirm|confirmed|affirmative|please do|send it|carry on|make it so)\b/i

/** A clear no — including the ways people say "not yet". */
const NO =
  /^(no|nope|nah|don'?t|do not|cancel|stop|deny|denied|negative|hold on|hold off|wait|abort|never ?mind|not now)\b/i

/** true for yes, false for no, null when the words are neither. */
export function answerFromSpeech(said: string): boolean | null {
  const words = said.trim().replace(/^[^a-z]+/i, '')
  if (YES.test(words)) return true
  if (NO.test(words)) return false
  return null
}

/** Answer the card on screen, if there is one. */
export function decide(approved: boolean): void {
  const pending = useStore.getState().approval
  if (!pending) return
  answerApproval(pending.id, approved)
  useStore.getState().setApproval(null)
  sfx.play(approved ? 'done' : 'listen')
}
