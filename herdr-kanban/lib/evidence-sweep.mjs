// Bounds the evidence of archived cards (TASKS/.evidence/<card>). Only a folder named for an archived card is
// planned. Live cards, audit cards and folders that name no card (audit folders such as 2026-10-16-i1361) are
// never touched. Per archived card the plan lists: dependency or build cache folders, files over the cap, and,
// when keepDays is set, the whole folder once nothing in it is newer than keepDays. The sweep does nothing
// until the operator turns it on (board.config.json evidenceSweep / evidenceKeepDays); scripts/evidence-sweep.mjs
// prints the plan without deleting.
//
// Every step is async. The board runs this on its event loop, and the old synchronous walk stalled the board
// for about 7 s per run on Injectbuddy (16 Oct 2026). Each directory visit yields, so board requests run between steps.
import { existsSync } from 'node:fs'
import { open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { COLUMNS } from './cards.mjs'
import { isCardId } from './ids.mjs'
import { CACHE_DIR_NAMES, EVIDENCE_FILE_CAP, cutMarker } from './evidence-guard.mjs'

const DAY = 24 * 60 * 60000
const AUDIT_FIELD = /^\*\*Audit:\*\*\s*\S/m
const CARD_FILE = /^(T-\d+|[A-Za-z]{1,3}\d+)-/
const CACHE = new Set(CACHE_DIR_NAMES)

const tick = () => new Promise(resolve => setImmediate(resolve))
const listMd = async dir => { try { return (await readdir(dir)).filter(f => f.toLowerCase().endsWith('.md')) } catch { return [] } }
const idOf = file => CARD_FILE.exec(file)?.[1].toUpperCase() ?? null

// Same rules as walkEvidence in lib/evidence-guard.mjs: cache folders are reported by path, not descended into.
async function walkEvidenceAsync(folder, { maxEntries = 5000 } = {}) {
  const files = [], caches = []
  let seen = 0, truncated = false
  const visit = async dir => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (++seen > maxEntries) { truncated = true; return }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { if (CACHE.has(entry.name)) caches.push(path); else await visit(path); continue }
      if (!entry.isFile()) continue
      try { const st = await stat(path); files.push({ path, bytes: st.size, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs || st.mtimeMs }) } catch { /* gone */ }
    }
    await tick()
  }
  await visit(folder)
  return { files, caches, truncated }
}

// Total bytes and newest mtime under a path. A cache folder is measured in full.
async function measure(path, { maxEntries = 200000 } = {}) {
  let bytes = 0, newest = 0, seen = 0
  const visit = async p => {
    if (++seen > maxEntries) return
    let st
    try { st = await stat(p) } catch { return }
    if (st.isDirectory()) {
      let names = []
      try { names = await readdir(p) } catch { /* unreadable: counted as-is */ }
      for (const name of names) await visit(join(p, name))
      await tick()
      return
    }
    bytes += st.size
    newest = Math.max(newest, st.mtimeMs)
  }
  await visit(path)
  return { bytes, newest, truncated: seen > maxEntries }
}

// Cuts an over-cap file to its first and last half, as truncateEvidenceFile does for the hook. Returns bytes removed.
async function cutFile(path, cap = EVIDENCE_FILE_CAP) {
  const size = (await stat(path)).size
  if (size <= cap) return 0
  const half = Math.floor(cap / 2)
  const head = Buffer.alloc(half), tail = Buffer.alloc(half)
  const fh = await open(path, 'r')
  try {
    await fh.read(head, 0, half, 0)
    await fh.read(tail, 0, half, size - half)
  } finally { await fh.close() }
  const cut = size - 2 * half
  await writeFile(path, Buffer.concat([head, cutMarker(cut, cap), tail]))
  return cut
}

// { cards: [{ id, folder, reasons, items: [{ kind, path, bytes }], bytes }], skipped: { live, audit, unknown } }
export async function planArchivedEvidence(tasksDir, { keepDays = 0, now = Date.now(), limit = Infinity } = {}) {
  const skipped = { live: 0, audit: 0, unknown: 0 }
  const root = join(tasksDir, '.evidence')
  const cards = []
  if (!existsSync(root)) return { cards, skipped }
  const live = new Set()
  for (const col of COLUMNS) for (const file of await listMd(join(tasksDir, col.dir))) { const id = idOf(file); if (id) live.add(id) }
  const archived = new Map()
  for (const file of await listMd(join(tasksDir, 'archive'))) { const id = idOf(file); if (id && !archived.has(id)) archived.set(id, join(tasksDir, 'archive', file)) }
  for (const name of await readdir(root, { withFileTypes: true })) {
    if (cards.length >= limit) break
    if (!name.isDirectory() || !isCardId(name.name)) { skipped.unknown++; continue }
    const id = name.name.toUpperCase()
    if (live.has(id)) { skipped.live++; continue }
    const file = archived.get(id)
    if (!file) { skipped.unknown++; continue }
    if (AUDIT_FIELD.test(await readFile(file, 'utf8'))) { skipped.audit++; continue }
    const folder = join(root, name.name)
    const scan = await walkEvidenceAsync(folder, { maxEntries: 200000 })
    const newest = scan.files.reduce((max, f) => Math.max(max, f.mtimeMs), 0)
    if (keepDays > 0 && newest && now - newest > keepDays * DAY) {
      const bytes = (await measure(folder)).bytes
      cards.push({ id, folder, reasons: [`no file newer than ${keepDays} days`], items: [{ kind: 'age', path: folder, bytes }], bytes })
      continue
    }
    const items = []
    for (const path of scan.caches) items.push({ kind: 'cache', path, bytes: (await measure(path)).bytes })
    // An oversize file is cut to the cap, so the bytes it frees are the excess over the cap.
    for (const f of scan.files) if (f.bytes > EVIDENCE_FILE_CAP) items.push({ kind: 'oversize', path: f.path, bytes: f.bytes - EVIDENCE_FILE_CAP })
    if (!items.length) continue
    const reasons = [...new Set(items.map(i => i.kind === 'cache' ? 'cache folder' : 'file over cap'))]
    cards.push({ id, folder, reasons, items, bytes: items.reduce((sum, i) => sum + i.bytes, 0) })
  }
  return { cards, skipped }
}

// Applies the plan. Cache folders and age-expired folders are deleted; an oversize file is cut to the cap (head and
// tail kept) rather than deleted. Every path must sit inside its card's own evidence folder. Returns what it changed.
export async function applyEvidencePlan(plan) {
  const done = { items: 0, bytes: 0, failed: [] }
  for (const card of plan.cards) {
    for (const item of card.items) {
      const own = item.path === card.folder || item.path.startsWith(card.folder + sep)
      if (!own || !existsSync(item.path)) continue
      try {
        if (item.kind === 'oversize') { const cut = await cutFile(item.path); if (!cut) continue; done.bytes += cut }
        else { await rm(item.path, { recursive: true, force: true, maxRetries: 3 }); done.bytes += item.bytes }
        done.items++
      } catch (err) { done.failed.push(`${item.path}: ${err.message}`) }
    }
  }
  return done
}

// The server's hourly call. Does nothing unless the operator has turned the sweep on in board.config.json.
// Plans at most `limit` cards per run, so one run's deletions stay small; the next hour continues.
export async function sweepArchivedEvidence(tasksDir, { keepDays = 0, limit = 10 } = {}) {
  const plan = await planArchivedEvidence(tasksDir, { keepDays, limit })
  return applyEvidencePlan(plan)
}
