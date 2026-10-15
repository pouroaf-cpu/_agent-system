// Card evidence folders (TASKS/.evidence/<card>) grew to 12.4 GB on Injectbuddy by 2026-10-16. Agents copied
// node_modules and .next caches into them and wrote base/head JSON of 50 to 200 MB each. These helpers are
// shared by the agent hook (scripts/evidence-guard.mjs) and the archived-card sweep (lib/evidence-sweep.mjs).
// Evidence keeps logs and summaries. Nothing here reads or changes a live card's existing files; the hook only
// acts on files a command wrote during that command.
import { closeSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentCard } from './ids.mjs'

export const EVIDENCE_FILE_CAP = 10 * 1024 * 1024
export const CACHE_DIR_NAMES = ['node_modules', '.next', '.turbo', '.cache', '.parcel-cache', '.nuxt', '.svelte-kit', '.vite']
const CACHE = new Set(CACHE_DIR_NAMES)
const CACHE_TEXT = new RegExp(`(^|[\\s"'\\\\/=])(${CACHE_DIR_NAMES.map(n => n.replaceAll('.', '\\.')).join('|')})(?=[\\\\/\\s"']|$)`)
const COPY_VERB = /\b(cp|copy|xcopy|robocopy|rsync|tar|cpio|scp|mv|move|Copy-Item|Move-Item|cpSync|copySync|copyFileSync)\b/i
const EVIDENCE_PATH = /(^|[\\/])\.evidence([\\/]|$)/
const mb = bytes => (bytes / (1024 * 1024)).toFixed(1)

export const evidenceFolder = (tasksDir, id) => join(tasksDir, '.evidence', id)

// True when the path is inside an evidence folder and names a cache folder below it.
export function cacheInEvidence(path) {
  const text = String(path ?? '').replaceAll('\\', '/')
  const at = text.startsWith('.evidence/') ? 0 : text.indexOf('/.evidence/')
  if (at < 0) return false
  return text.slice(at).split('/').some(seg => CACHE.has(seg))
}

// The refusal for a Write or Edit call, or null to let it run. Edit carries only the changed text, so
// the size cap applies to Write, which carries the whole file.
export function writeRefusal({ path, content } = {}) {
  if (!EVIDENCE_PATH.test(String(path ?? ''))) return null
  if (cacheInEvidence(path)) return `Refused: ${path} is inside a dependency or build cache folder. Evidence keeps logs and summaries only; never write node_modules, .next or other caches into TASKS/.evidence.`
  const bytes = Buffer.byteLength(String(content ?? ''))
  if (bytes > EVIDENCE_FILE_CAP) return `Refused: ${path} would be ${mb(bytes)} MB. Evidence files are capped at ${mb(EVIDENCE_FILE_CAP)} MB. Write the key lines and counts, and cut a raw dump with head or tail before saving it.`
  return null
}

// The refusal for a shell command that copies a cache folder into evidence, or null.
export function commandRefusal(command) {
  const text = String(command ?? '')
  if (!EVIDENCE_PATH.test(text) || !CACHE_TEXT.test(text) || !COPY_VERB.test(text)) return null
  return 'Refused: this command copies a dependency or build cache (node_modules, .next and the like) into TASKS/.evidence. Evidence keeps logs and summaries only. Copy the report or log you need, not the cache.'
}

// Walks an evidence folder without descending into cache folders, which are reported by path. Stops after
// maxEntries so a huge folder cannot stall a hook or the board loop.
export function walkEvidence(folder, { maxEntries = 5000 } = {}) {
  const files = [], caches = []
  let seen = 0, truncated = false
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (++seen > maxEntries) { truncated = true; return }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { if (CACHE.has(entry.name)) caches.push(path); else walk(path); continue }
      if (!entry.isFile()) continue
      try { const st = statSync(path); files.push({ path, bytes: st.size, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs || st.mtimeMs }) } catch { /* gone */ }
    }
  }
  walk(folder)
  return { files, caches, truncated }
}

// Total bytes and newest mtime under a path. A cache folder is measured in full.
export function measure(path, { maxEntries = 200000 } = {}) {
  let bytes = 0, newest = 0, seen = 0
  const walk = p => {
    if (++seen > maxEntries) return
    let st
    try { st = statSync(p) } catch { return }
    if (st.isDirectory()) {
      let names = []
      try { names = readdirSync(p) } catch { /* unreadable: counted as-is */ }
      for (const name of names) walk(join(p, name))
      return
    }
    bytes += st.size
    newest = Math.max(newest, st.mtimeMs)
  }
  walk(path)
  return { bytes, newest, truncated: seen > maxEntries }
}

// The over-cap files a folder holds now, for --pre to compare against after the command.
export function overCapFiles(folder) {
  return walkEvidence(folder).files.filter(f => f.bytes > EVIDENCE_FILE_CAP).map(f => f.path)
}

// Cuts a file over the cap to its first and last half, with a marker where the middle was removed. Returns
// the bytes removed (0 when the file is within the cap).
export function truncateEvidenceFile(path, cap = EVIDENCE_FILE_CAP) {
  const size = statSync(path).size
  if (size <= cap) return 0
  const half = Math.floor(cap / 2)
  const head = Buffer.alloc(half), tail = Buffer.alloc(half)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, head, 0, half, 0)
    readSync(fd, tail, 0, half, size - half)
  } finally { closeSync(fd) }
  const cut = size - 2 * half
  const marker = Buffer.from(`\n[... the board cut ${mb(cut)} MB from the middle of this file: evidence files are capped at ${mb(cap)} MB. Keep counts and summaries here; put a full log in a file that is read with head or tail ...]\n`)
  writeFileSync(path, Buffer.concat([head, marker, tail]))
  return cut
}

// The card a board agent works on, from its transcript: the agent's name gives the card, and the
// `--tasks '<dir>'` in its hkb commands gives the TASKS folder. Null for anything else (fails open).
export function cardContext(transcriptPath) {
  try {
    const text = readFileSync(transcriptPath, 'utf8')
    const name = text.split('\n').map(line => { try { return JSON.parse(line) } catch { return {} } }).findLast(e => e.type === 'agent-name')?.agentName
    const id = agentCard(name)
    const tasksDir = text.match(/--tasks '([^']+)'/)?.[1]?.replaceAll('\\\\', '\\')
    return id && tasksDir ? { id, tasksDir } : null
  } catch { return null }
}

// Files a command wrote, in the card's own evidence folder, during the command: an over-cap file is cut and
// a cache folder that appeared is deleted. Older files are never touched. Returns the notices for the agent.
// Over-cap files that were already there before the command (listed in `existing`) are left alone, so an
// Edit to an old file is never cut.
export function settleCommandOutput({ folder, startedAt, existing = [] }) {
  const notes = []
  const { files, caches } = walkEvidence(folder)
  const before = new Set(existing)
  for (const file of files) {
    if (file.bytes <= EVIDENCE_FILE_CAP || before.has(file.path) || Math.max(file.mtimeMs, file.birthMs) < startedAt - 1000) continue
    try { truncateEvidenceFile(file.path) } catch { continue }
    notes.push(`${file.path} was ${mb(file.bytes)} MB; the board cut it to ${mb(EVIDENCE_FILE_CAP)} MB. Keep summaries in evidence.`)
  }
  for (const cache of caches) {
    const st = statSync(cache, { throwIfNoEntry: false })
    if (!st || Math.max(st.birthtimeMs || 0, st.mtimeMs) < startedAt - 1000) continue
    try { rmSync(cache, { recursive: true, force: true, maxRetries: 3 }) } catch { continue }
    notes.push(`${cache} was a dependency or build cache; the board deleted it. Evidence never holds node_modules or .next.`)
  }
  return notes
}
