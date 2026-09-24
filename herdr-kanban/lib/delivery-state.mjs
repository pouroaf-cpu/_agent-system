import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
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
export function pendingDeliveries(session) {
  return existsSync(root()) ? readdirSync(root()).filter(p => p.endsWith('.json')).map(p => JSON.parse(readFileSync(join(root(), p), 'utf8'))).filter(item => item.session === session && item.status === 'paused' && !item.runId) : []
}
