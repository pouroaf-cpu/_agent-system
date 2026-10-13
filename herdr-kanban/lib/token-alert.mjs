import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatNZTime } from './nz-time.mjs'

// Token Manager alert: a Planner or Builder run over a step or token count is one line in
// its inbox. Alert only; nothing here holds or moves a card. Read here, not through
// workflow-limits.mjs, which imports request-usage.mjs (this file's caller).
const STEPS = 13
const TOKENS = 3000000

// A configured null (or <= 0) turns that limit off; an absent key keeps the default.
const limit = (section, key, fallback) => {
  if (!section || !(key in section)) return fallback
  const n = Number(section[key])
  return section[key] != null && Number.isFinite(n) && n > 0 ? n : null
}

export function tokenAlertSettings() {
  const test = !!process.env.KANBAN_TEST && !process.env.KANBAN_CONFIG
  const path = process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url))
  let config = {}
  if (!test) try { config = JSON.parse(readFileSync(path, 'utf8')) } catch { /* missing or bad config: defaults */ }
  const inbox = config.tokenManager?.inbox
    || (test ? null : join(dirname(path), '..', '_roles', 'inbox', 'TokenManager-INBOX.md'))
  return {
    steps: limit(config.workflowLimits, 'alertStepsPerRun', STEPS),
    tokens: limit(config.workflowLimits, 'alertTokensPerRun', TOKENS),
    inbox,
  }
}

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

export function tokenAlertLine(run, { title = '', settings, now = Date.now(), file, project } = {}) {
  if (!['planner', 'builder'].includes(run.role) || run.duplicateOf) return null
  const steps = Number.isFinite(run.steps) ? run.steps : null
  const tokens = Number.isFinite(run.delta?.total) ? run.delta.total : null
  const over = (settings.steps != null && steps != null && steps > settings.steps)
    || (settings.tokens != null && tokens != null && tokens > settings.tokens)
  if (!over) return null
  const name = one(title).slice(0, 60) || '(no title)'
  return `- ${formatNZTime(now)} TOKEN ALERT ${one(run.project || project)} ${(run.cardIds || []).join(',')} "${name}" ${run.role} steps ${steps ?? 'unknown'} tokens ${tokens ?? 'unknown'} ended ${run.status} session ${one(file) || 'unknown'}\n`
}
