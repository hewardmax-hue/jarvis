/**
 * Emrys’s control over his own interface — the `emrys_ui` tools.
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
 * @param {{ switchModel: (tier: 'fast' | 'voice' | 'deep') => Promise<string> }} self
 */
export function uiServer(send, { switchModel }) {
  return createSdkMcpServer({
    name: 'emrys_ui',
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
    ],
  })
}
