import { readFileSync } from 'node:fs'

export function validateAgentBackend(value) {
  const valid = v => ['herdr', 'headless'].includes(v)
  if (valid(value)) return value
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([k, v]) => !['planner', 'builder', 'reviewer', 'plancheck'].includes(k) || !valid(v))) throw new Error('agentBackend must be herdr, headless, or a role map of those values')
  return value
}
export function backendFor(role) {
  let config = {}
  try { config = JSON.parse(readFileSync(process.env.KANBAN_CONFIG || new URL('../board.config.json', import.meta.url), 'utf8')) } catch (err) { if (err.code !== 'ENOENT') throw err }
  const value = config.agentBackend ?? 'herdr'
  validateAgentBackend(value)
  // Phase 1: Planner and Builder transports remain interactive.
  if (['planner', 'builder'].includes(role)) return 'herdr'
  return typeof value === 'string' ? value : value[role] ?? 'herdr'
}
