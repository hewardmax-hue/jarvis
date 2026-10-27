/**
 * The Mac itself — the `emrys_mac` tools.
 *
 * The browser is one app; this is the rest of the machine. Opening an app, a
 * file, a folder or a link, a notification, the clipboard, the volume, what is
 * frontmost and how the battery is doing — all of it through the commands
 * macOS ships with, so nothing extra is installed and nothing new is trusted.
 *
 * AppleScript is the long arm: it can drive Mail, Calendar, Notes, Finder,
 * Music and nearly anything else that has a dictionary. Because it can do
 * anything, the gate always puts the exact script on screen for a yes first.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { z } from 'zod'

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

const run = (cmd, args, { input, timeout = 15_000 } = {}) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout ?? '').trim(), err: String(stderr || err?.message || '').trim() }),
    )
    if (input !== undefined) {
      child.stdin.end(input)
    }
  })

const osa = (script, timeout) => run('/usr/bin/osascript', ['-e', script], { timeout })
const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function macServer() {
  return createSdkMcpServer({
    name: 'emrys_mac',
    version: '1.0.0',
    instructions:
      "The user's Mac: open apps, files, folders and links; notifications; clipboard; " +
      'volume; what is on screen; AppleScript for driving any app.',
    alwaysLoad: true,
    tools: [
      tool(
        'open',
        `Open something on the Mac: an app by name ("Spotify", "Notes"), a file or folder by
absolute path (it opens in its usual app, folders in Finder), or a web address in the
default browser. Use it when they ask to open, launch or bring up something. For a
web page you need to READ, use the chrome tools instead; this just puts it in front
of them.`,
        {
          target: z.string().describe('App name, absolute path (~ allowed), or URL.'),
          reveal: z.boolean().optional().catch(undefined).describe('For a file: show it in Finder instead of opening it.'),
        },
        async ({ target, reveal }) => {
          const t = String(target).trim().replace(/^~(?=\/|$)/, homedir())
          let args
          if (/^https?:\/\//i.test(t)) args = [t]
          else if (t.startsWith('/')) {
            if (!existsSync(t)) return fail(`Nothing exists at ${t}.`)
            args = reveal ? ['-R', t] : [t]
          } else args = ['-a', t]
          const r = await run('/usr/bin/open', args)
          return r.ok ? text(`Opened ${t}.`) : fail(`Could not open ${t}: ${r.err}`)
        },
      ),

      tool(
        'notify',
        `Show a macOS notification — a reminder or a heads-up that should outlast the
conversation. Short title, one-line message.`,
        { title: z.string(), message: z.string() },
        async ({ title, message }) => {
          const r = await osa(`display notification ${quote(message.slice(0, 240))} with title ${quote(title.slice(0, 80))}`)
          return r.ok ? text('Notification shown.') : fail(r.err)
        },
      ),

      tool(
        'get_clipboard',
        'Read what is on the clipboard — when they say "what I just copied", "this", "the thing on my clipboard".',
        {},
        async () => {
          const r = await run('/usr/bin/pbpaste', [])
          return text(r.out ? r.out.slice(0, 12_000) : 'The clipboard is empty or holds no text.')
        },
      ),

      tool(
        'set_clipboard',
        'Put text on the clipboard so they can paste it — a draft, an address, a command.',
        { text: z.string() },
        async ({ text: t }) => {
          const r = await run('/usr/bin/pbcopy', [], { input: t })
          return r.ok ? text('Copied to the clipboard.') : fail(r.err)
        },
      ),

      tool(
        'set_volume',
        'Set the output volume, 0 to 100. 0 mutes.',
        { level: z.number().min(0).max(100) },
        async ({ level }) => {
          const r = await osa(`set volume output volume ${Math.round(level)}`)
          return r.ok ? text(`Volume ${Math.round(level)}.`) : fail(r.err)
        },
      ),

      tool(
        'mac_status',
        `What the Mac is doing: frontmost app and window, battery, volume, Wi-Fi network,
and the apps that are open. Use it for "what's open", "how's my battery", or before
acting on whatever they are looking at.`,
        {},
        async () => {
          const [front, batt, vol, apps] = await Promise.all([
            osa(
              'tell application "System Events" to set p to first application process whose frontmost is true\n' +
                'set n to name of p\n' +
                'try\nset w to name of front window of p\non error\nset w to ""\nend try\n' +
                'return n & " — " & w',
            ),
            run('/usr/bin/pmset', ['-g', 'batt']),
            osa('output volume of (get volume settings) & "," & output muted of (get volume settings)'),
            osa('tell application "System Events" to get name of (every application process whose background only is false)'),
          ])
          const battery = /(\d+)%;\s*([^;]+)/.exec(batt.out)
          return text(
            [
              front.ok && `Frontmost: ${front.out}`,
              battery && `Battery: ${battery[1]}%, ${battery[2].trim()}`,
              vol.ok && `Volume: ${vol.out.replace(',', ', muted: ')}`,
              apps.ok && `Open apps: ${apps.out}`,
            ]
              .filter(Boolean)
              .join('\n') || 'Could not read the Mac status.',
          )
        },
      ),

      tool(
        'applescript',
        `Run AppleScript to drive an app that has no tool of its own: create a reminder or a
note, read or add calendar events in Calendar.app, control Music or Spotify, work with
Finder, compose in Mail. The user sees the exact script and approves it first, so
write it plainly. Return values come back as text. Prefer the dedicated tools (open,
chrome, the Google connectors) when one fits.`,
        { script: z.string().describe('The AppleScript source.') },
        async ({ script }) => {
          const r = await osa(script, 60_000)
          return r.ok ? text(r.out || 'Done.') : fail(`AppleScript failed: ${r.err.slice(0, 600)}`)
        },
      ),
    ],
  })
}
