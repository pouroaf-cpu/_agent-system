import { readFileSync } from 'node:fs'

export function validateAgentBackend(value) {
  const valid = v => ['herdr', 'headless'].includes(v)
  if (valid(value)) return value
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([k, v]) => !['planner', 'builder', 'reviewer', 'plancheck'].includes(k) || !valid(v))) throw new Error('agentBackend must be herdr, headless, or a role map of those values')
  return value
}
export function backendFor(role) {
  // Tests without their own config must not pick up the live board's backend (test.mjs failed
  // the day the live board went headless, 2026-10-03).
  if (process.env.KANBAN_TEST && !process.env.KANBAN_CONFIG) return 'herdr'
  let config = {}
  try { config = JSON.parse(readFileSync(process.env.KANBAN_CONFIG || new URL('../board.config.json', import.meta.url), 'utf8')) } catch (err) { if (err.code !== 'ENOENT') throw err }
  const value = config.agentBackend ?? 'herdr'
  validateAgentBackend(value)
  return typeof value === 'string' ? value : value[role] ?? 'herdr'
}
