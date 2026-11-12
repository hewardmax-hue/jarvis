/**
 * Jett’s control over his own interface — the `jett_ui` tools.
 *
 * Deliberately few. The interface is the user's workspace — the second brain,
 * the conversation, whatever is open on a blade — and the assistant redecorating
 * it is rarely what anyone asked for. So: tint the accent when asked, clear the
 * screen when asked, and change gear between the quick, balanced and deep
 * models when the conversation calls for it.
 *
 * Each op is pushed to the browser over the same socket as everything else and
 * applied by the store, so a change lands while he is still saying it.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const text = (t) => ({ content: [{ type: 'text', text: t }] })

/**
 * @param {(op: string, args: object) => void} send
 * @param {{
 *   switchModel: (tier: 'fast' | 'voice' | 'deep') => Promise<string>,
 *   workshop?: { build: (what: string) => string, close: () => string },
 * }} self
 */
export function uiServer(send, { switchModel, workshop }) {
  return createSdkMcpServer({
    name: 'jett_ui',
    version: '2.0.0',
    instructions: 'Your own interface: its accent colour, clearing it, and which model you run on.',
    alwaysLoad: true,
    tools: [
      tool(
        'ui_theme',
        `Change the interface's accent colour when the user asks — "make it green", "go back
to normal". Any CSS colour, or reset: true for the default. Say nothing about it
beyond a word; they can see it.`,
        {
          accent: z.string().optional().catch(undefined).describe('A CSS colour, e.g. "#7cf2c4" or "tomato".'),
          reset: z.boolean().optional().catch(undefined),
        },
        async ({ accent, reset }) => {
          send('theme', { accent: reset ? null : String(accent ?? '').slice(0, 40) || null })
          return text('Done.')
        },
      ),

      tool(
        'ui_screen',
        `Clear the screen when asked: "blades" closes everything open, "transcript" wipes the
conversation shown on screen (not your memory of it), "all" does both.`,
        { what: z.enum(['all', 'blades', 'transcript']).optional().catch(undefined) },
        async ({ what }) => {
          send('screen', { what: what ?? 'blades' })
          return text('Cleared.')
        },
      ),

      tool(
        'switch_model',
        `Change which model you run on for the rest of this conversation, when the user asks
— "switch to deep mode", "be quicker", "use Opus".
  fast  — Haiku: the quickest replies, for light back-and-forth
  voice — Sonnet: the everyday balance (the default)
  deep  — Opus: slower, for hard thinking, careful writing, tricky problems
The switch applies from your next reply.`,
        { tier: z.enum(['fast', 'voice', 'deep']) },
        async ({ tier }) => text(await switchModel(tier)),
      ),

      ...(workshop
        ? [
            tool(
              'workshop_build',
              `Put a 3D model of a physical thing on the workshop bench — "build me a jet engine",
"could you mock up a mechanical watch", "show me what a turbocharger looks like inside".
Physical objects only: never for software, documents, plans or lists. The workshop
builds it part by part on screen and speaks for itself as it goes, so once this
returns say a few words at most. Changes to a model already on the bench are handled
by the workshop too — do not call this again for those.`,
              { what: z.string().describe('The thing to build, as a short noun phrase: "a mechanical watch movement".') },
              async ({ what }) => text(workshop.build(String(what ?? '').slice(0, 300))),
            ),
            tool(
              'workshop_close',
              `Close the workshop bench and go back to the main view, when asked to.`,
              {},
              async () => text(workshop.close()),
            ),
          ]
        : []),
    ],
  })
}
