// Bounds the evidence of archived cards (TASKS/.evidence/<card>). Only a folder named for an archived card is
// planned. Live cards, audit cards and folders that name no card (audit folders such as 2026-10-16-i1361) are
// never touched. Per archived card the plan lists: dependency or build cache folders, files over the cap, and,
// when keepDays is set, the whole folder once nothing in it is newer than keepDays. The sweep does nothing
// until the operator turns it on (board.config.json evidenceSweep / evidenceKeepDays); scripts/evidence-sweep.mjs
// prints the plan without deleting.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import { COLUMNS } from './cards.mjs'
import { isCardId } from './ids.mjs'
import { EVIDENCE_FILE_CAP, measure, truncateEvidenceFile, walkEvidence } from './evidence-guard.mjs'

const DAY = 24 * 60 * 60000
const AUDIT_FIELD = /^\*\*Audit:\*\*\s*\S/m
const CARD_FILE = /^(T-\d+|[A-Za-z]{1,3}\d+)-/

const listMd = dir => { try { return readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')) } catch { return [] } }
const idOf = file => CARD_FILE.exec(file)?.[1].toUpperCase() ?? null

// { cards: [{ id, folder, reasons, items: [{ kind, path, bytes }], bytes }], skipped: { live, audit, unknown } }
export function planArchivedEvidence(tasksDir, { keepDays = 0, now = Date.now(), limit = Infinity } = {}) {
  const skipped = { live: 0, audit: 0, unknown: 0 }
  const root = join(tasksDir, '.evidence')
  const cards = []
  if (!existsSync(root)) return { cards, skipped }
  const live = new Set(COLUMNS.flatMap(col => listMd(join(tasksDir, col.dir)).map(idOf)).filter(Boolean))
  const archived = new Map()
  for (const file of listMd(join(tasksDir, 'archive'))) { const id = idOf(file); if (id && !archived.has(id)) archived.set(id, join(tasksDir, 'archive', file)) }
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (cards.length >= limit) break
    if (!name.isDirectory() || !isCardId(name.name)) { skipped.unknown++; continue }
    const id = name.name.toUpperCase()
    if (live.has(id)) { skipped.live++; continue }
    const file = archived.get(id)
    if (!file) { skipped.unknown++; continue }
    if (AUDIT_FIELD.test(readFileSync(file, 'utf8'))) { skipped.audit++; continue }
    const folder = join(root, name.name)
    const scan = walkEvidence(folder, { maxEntries: 200000 })
    const newest = Math.max(0, ...scan.files.map(f => f.mtimeMs))
    if (keepDays > 0 && newest && now - newest > keepDays * DAY) {
      const bytes = measure(folder).bytes
      cards.push({ id, folder, reasons: [`no file newer than ${keepDays} days`], items: [{ kind: 'age', path: folder, bytes }], bytes })
      continue
    }
    const items = [
      ...scan.caches.map(path => ({ kind: 'cache', path, bytes: measure(path).bytes })),
      // An oversize file is cut to the cap, so the bytes it frees are the excess over the cap.
      ...scan.files.filter(f => f.bytes > EVIDENCE_FILE_CAP).map(f => ({ kind: 'oversize', path: f.path, bytes: f.bytes - EVIDENCE_FILE_CAP })),
    ]
    if (!items.length) continue
    const reasons = [...new Set(items.map(i => i.kind === 'cache' ? 'cache folder' : 'file over cap'))]
    cards.push({ id, folder, reasons, items, bytes: items.reduce((sum, i) => sum + i.bytes, 0) })
  }
  return { cards, skipped }
}

// Applies the plan. Cache folders and age-expired folders are deleted; an oversize file is cut to the cap (head and
// tail kept) rather than deleted. Every path must sit inside its card's own evidence folder. Returns what it changed.
export function applyEvidencePlan(plan) {
  const done = { items: 0, bytes: 0, failed: [] }
  for (const card of plan.cards) {
    for (const item of card.items) {
      const own = item.path === card.folder || item.path.startsWith(card.folder + sep)
      if (!own || !existsSync(item.path)) continue
      try {
        if (item.kind === 'oversize') { const cut = truncateEvidenceFile(item.path); if (!cut) continue; done.bytes += cut }
        else { rmSync(item.path, { recursive: true, force: true, maxRetries: 3 }); done.bytes += item.bytes }
        done.items++
      } catch (err) { done.failed.push(`${item.path}: ${err.message}`) }
    }
  }
  return done
}

// The server's hourly call. Does nothing unless the operator has turned the sweep on in board.config.json.
// Plans at most `limit` cards per call, because the walk is synchronous on the board's event loop.
export function sweepArchivedEvidence(tasksDir, { keepDays = 0, limit = 10 } = {}) {
  const plan = planArchivedEvidence(tasksDir, { keepDays, limit })
  return applyEvidencePlan(plan)
}
