/**
 * Getting the words out of a file.
 *
 * Everything here uses what macOS already ships, so the second brain needs no
 * extra installs: plain reads for text, `textutil` for Word and RTF, PDFKit
 * through JavaScript for Automation for PDFs, and `unzip` for the XML inside
 * PowerPoint and Excel files. Each runs as a child process with a timeout, off
 * the event loop the voice rides on.
 *
 * A file whose text cannot be read is still worth a node — its name, folder and
 * date are searchable, and Emrys can open it with his own tools when asked — so
 * failure returns '' rather than throwing.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** Per file, after extraction. Enough for a summary and a good index. */
export const MAX_TEXT = 24_000
const MAX_READ_BYTES = 4 * 1024 * 1024

const run = (cmd, args, timeout = 15_000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? '' : stdout),
    )
  })

const clean = (text) =>
  String(text ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT)

/** XML to words: tags out, entities decoded, runs joined. */
const xmlText = (xml) =>
  xml
    .replace(/<\/(a:p|w:p|si|row)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")

const PDF_JXA = `
ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return '';
  const pages = Math.min(doc.pageCount, 40);
  let out = '';
  for (let i = 0; i < pages && out.length < ${MAX_TEXT}; i++) {
    const p = doc.pageAtIndex(i);
    const s = p.string;
    if (s && !s.isNil()) out += ObjC.unwrap(s) + '\\n';
  }
  return out;
}`

/** Which kinds of file the brain reads, and how. */
export const READERS = {
  md: 'text',
  markdown: 'text',
  txt: 'text',
  csv: 'text',
  json: 'text',
  rtf: 'textutil',
  doc: 'textutil',
  docx: 'textutil',
  odt: 'textutil',
  html: 'textutil',
  pdf: 'pdf',
  pptx: 'pptx',
  xlsx: 'xlsx',
  // Bundles iWork keeps to itself. Named, dated and placed; not read.
  pages: 'none',
  key: 'none',
  numbers: 'none',
}

export function kindOf(path) {
  return extname(path).slice(1).toLowerCase()
}

export async function extractText(path) {
  const how = READERS[kindOf(path)]
  try {
    switch (how) {
      case 'text': {
        const buf = await readFile(path)
        return clean(buf.subarray(0, MAX_READ_BYTES).toString('utf8'))
      }
      case 'textutil':
        return clean(await run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', path]))
      case 'pdf':
        return clean(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_JXA, path], 25_000))
      case 'pptx': {
        const xml = await run('/usr/bin/unzip', ['-p', path, 'ppt/slides/slide*.xml'])
        return clean(xmlText(xml))
      }
      case 'xlsx': {
        const xml = await run('/usr/bin/unzip', ['-p', path, 'xl/sharedStrings.xml'])
        return clean(xmlText(xml))
      }
      default:
        return ''
    }
  } catch {
    return ''
  }
}

/** A title from the first Markdown heading, else the file name. */
export function titleFrom(text, fallback) {
  const h = /^#\s+(.+)$/m.exec(text ?? '')
  return (h?.[1] ?? fallback).replace(/[*_`]/g, '').trim().slice(0, 140)
}

/** [[Wiki links]] in a note, by target title. */
export function wikiLinks(text) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    out.add(m[1].trim().toLowerCase())
  }
  return [...out]
}
