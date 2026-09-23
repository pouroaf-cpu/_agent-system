import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { agentList, agentPrompt, herdrLog } from './herdr.mjs'
import { controlState } from './project-control.mjs'

const MANAGER = 'kanban-observer'
const MANAGER_SESSION = 'injectbuddy'
const COOLDOWN_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 3

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

function readState(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { alerts: {} }
  } catch {
    return { alerts: {} }
  }
}

function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
}

export function alertStatePath(boardRoot) {
  return join(boardRoot, '.manager-alerts.json')
}

export async function notifyManagerException({
  boardRoot,
  key,
  title,
  detail,
  now = Date.now(),
  list = agentList,
  prompt = agentPrompt,
  log = herdrLog,
}) {
  const file = alertStatePath(boardRoot)
  const state = readState(file)
  state.alerts ||= {}
  const body = `${title}: ${detail}`.replace(/\s+/g, ' ').trim()
  const fingerprint = hash(body)
  const prior = state.alerts[key]

  if (prior?.hash === fingerprint && prior.promptedAt) return { sent: false, reason: 'duplicate' }
  if (prior?.hash === fingerprint && prior.attempts >= MAX_ATTEMPTS) return { sent: false, reason: 'retry-bound' }
  if (prior?.hash === fingerprint && prior.nextAt && now < prior.nextAt) return { sent: false, reason: 'cooldown' }

  const entry = prior?.hash === fingerprint ? prior : { hash: fingerprint, attempts: 0 }
  if (prompt === agentPrompt && controlState(MANAGER_SESSION).paused) return { sent: false, reason: 'paused' }
  try {
    const manager = (await list(MANAGER_SESSION, { ensureSession: false })).find((a) => a.name === MANAGER)
    if (!manager || manager.agent_status !== 'idle') throw new Error(`${MANAGER} is ${manager?.agent_status || 'not present'}`)
    await prompt(MANAGER, `[HERDR exception] ${body}`, { wait: true, timeoutMs: 20000, session: MANAGER_SESSION })
    state.alerts[key] = { hash: fingerprint, promptedAt: now, attempts: entry.attempts + 1 }
    writeState(file, state)
    log?.(`manager alerted: ${title}`, 'error')
    return { sent: true }
  } catch (err) {
    state.alerts[key] = {
      hash: fingerprint,
      attempts: entry.attempts + 1,
      nextAt: now + COOLDOWN_MS,
      lastError: err.message,
    }
    writeState(file, state)
    log?.(`manager alert deferred: ${title} — ${err.message}`, 'error')
    return { sent: false, reason: 'failed', error: err.message }
  }
}

export function isHardHold(reason) {
  return /duplicate live card id|duplicate issue key|dependency cycle detected|card not ready|mission build budget exhausted/i.test(reason || '')
}
