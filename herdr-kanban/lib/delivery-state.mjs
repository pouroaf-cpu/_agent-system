import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = () => join(dirname(process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url))), '.deliveries')
const path = (session, paneId) => join(root(), createHash('sha256').update(`${session}:${paneId}`).digest('hex') + '.json')
export const deliveryKey = text => createHash('sha256').update(text).digest('hex')
// The full task behind a short typed pointer, one per pane beside its record.
export const promptPath = (session, paneId) => path(session, paneId).replace(/\.json$/, '.md').replaceAll('\\', '/')
export function readDelivery(session, paneId) {
  const p = path(session, paneId)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}
export function saveDelivery(session, paneId, data) {
  mkdirSync(root(), { recursive: true })
  const p = path(session, paneId)
  writeFileSync(p + '.tmp', JSON.stringify({ ...data, session, paneId, at: new Date().toISOString() }) + '\n')
  renameSync(p + '.tmp', p)
}
// Every poll asks this for every project, and .deliveries holds hundreds of finished
// records: re-parsing them all was 1/3 of the board's CPU (2026-09-25). Records are
// written by rename, which changes the folder's mtime, so the parse is cached on it.
let scan = { key: '', items: [] }
export function pendingDeliveries(session) {
  const dir = root()
  if (!existsSync(dir)) return []
  const key = `${dir}:${fs.statSync(dir).mtimeMs}`
  if (scan.key !== key) scan = { key, items: readdirSync(dir).filter(p => p.endsWith('.json')).map(p => JSON.parse(fs.readFileSync(join(dir, p), 'utf8'))) }
  return scan.items.filter(item => item.session === session && item.status === 'paused' && !item.runId)
}
