/**
 * Serving the stage.
 *
 * The stage is the one page here that runs code a model wrote, so it is served
 * as its own sealed thing: a header that sandboxes it (no origin, no storage),
 * a policy that gives it no network at all, and nothing but its own script and
 * three.js to load. The app frames it from the other loopback name, so the
 * browser keeps it in a process of its own.
 *
 * Everything under /workshop/ is a plain GET of a file that ships with Jett.
 * Nothing here reads the home folder and nothing here changes anything.
 */
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// three ships in node_modules; the stage loads it from here, not from the web.
const THREE_DIR = resolve(dirname(require.resolve('three')), '..')
export const THREE_VERSION = JSON.parse(readFileSync(join(THREE_DIR, 'package.json'), 'utf8')).version

const JS = 'text/javascript; charset=utf-8'
const FOREVER = 'public, max-age=31536000, immutable'
// A sandboxed page has no origin, so every script it loads is a cross-origin one.
const OPEN = { 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' }

/** One transparent pixel: the seal check asks for it, and must be refused. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** The policy the stage runs under, whichever of this Mac's own ports served it. */
export function stagePolicy() {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    // Its own script and three.js, and eval — running a part is the whole job.
    // `*.localhost` is this Mac too: a stage that replaces a frozen one is loaded under a
    // name of its own, so the browser cannot hand it to the process that hung.
    "script-src 'unsafe-inline' 'unsafe-eval' http://localhost:*/workshop/ http://127.0.0.1:*/workshop/ http://*.localhost:*/workshop/",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    "connect-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'frame-ancestors http://localhost:* http://127.0.0.1:*',
  ].join('; ')
}

const send = (res, status, headers, body) => {
  res.writeHead(status, { ...OPEN, ...headers })
  res.end(body)
}

async function file(res, path, type, cache) {
  try {
    send(res, 200, { 'content-type': type, 'cache-control': cache }, await readFile(path))
  } catch {
    send(res, 404, { 'content-type': 'text/plain' }, 'not found')
  }
}

/**
 * Answer a request under /workshop/. Resolves true when it was one of ours.
 * Call this before any Origin check: the stage's own requests arrive with
 * `Origin: null`, which nothing else on this server accepts.
 */
export async function serveStage(req, res, pathname) {
  if (!pathname.startsWith('/workshop/')) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const rest = pathname.slice('/workshop/'.length)

  if (rest === 'stage.html') {
    let stamp = '0'
    try {
      stamp = String(Math.round(statSync(join(HERE, 'stage.js')).mtimeMs))
    } catch {}
    const html = readFileSync(join(HERE, 'stage.html'), 'utf8')
      .replaceAll('__V__', THREE_VERSION)
      .replaceAll('__S__', stamp)
    send(
      res,
      200,
      {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': stagePolicy(),
        'referrer-policy': 'no-referrer',
      },
      html,
    )
    return true
  }

  if (rest === 'stage.js') {
    await file(res, join(HERE, 'stage.js'), JS, 'no-store')
    return true
  }

  if (rest === 'pixel.gif') {
    send(res, 200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }, PIXEL)
    return true
  }

  if (rest === 'vendor/font.js') {
    // The lettering for W.text, as a module: the stage cannot fetch, only import.
    try {
      const face = await readFile(join(HERE, 'font.typeface.json'), 'utf8')
      send(res, 200, { 'content-type': JS, 'cache-control': 'public, max-age=3600' }, `export default ${face}`)
    } catch {
      send(res, 404, { 'content-type': 'text/plain' }, 'not found')
    }
    return true
  }

  const vendor = /^vendor\/([\w.-]+)\/(.+)$/.exec(rest)
  if (vendor && vendor[1] === THREE_VERSION) {
    const [, , path] = vendor
    if (path === 'three.module.min.js' || path === 'three.core.min.js') {
      await file(res, join(THREE_DIR, 'build', path), JS, FOREVER)
      return true
    }
    const addon = /^jsm\/([\w/-]+\.js)$/.exec(path)
    if (addon) {
      const root = join(THREE_DIR, 'examples', 'jsm') + sep
      const target = resolve(root, addon[1])
      if (target.startsWith(root)) {
        await file(res, target, JS, FOREVER)
        return true
      }
    }
  }

  send(res, 404, { 'content-type': 'text/plain' }, 'not found')
  return true
}
