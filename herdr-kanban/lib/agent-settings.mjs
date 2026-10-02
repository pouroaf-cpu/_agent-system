// Durable, manually selected launch settings. The board keeps the legacy
// models/engines fields as the fallback source for compatibility.
import { readFileSync, writeFileSync } from 'node:fs'
import { findCard } from './cards.mjs'
import { approvedManagedModel } from './herdr.mjs'

export const STAGES = ['planning', 'working', 'review', 'trivial']
export const REASONING = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const SUPPORTED = {
  codex: {
    models: ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-6-astra'],
    reasoning: REASONING,
  },
  claude: {
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    reasoning: REASONING,
  },
}

const legacyRole = { planning: 'planning', working: 'working', review: 'review', trivial: 'trivial' }
const kindOf = engine => typeof engine === 'string' ? engine : engine?.kind
const reasoningOf = engine => String(engine?.reasoning || engine?.reasoningLevel || engine?.reasoningArgs?.join(' ')?.match(/model_reasoning_effort=\\?"?([a-z]+)/i)?.[1] || (kindOf(engine) === 'codex' ? 'high' : 'medium')).toLowerCase()

export function validateAssignment(value, label = 'agent setting') {
  const setting = { ...value }
  if (!SUPPORTED[setting.engine]) throw new Error(`${label}: unsupported engine ${setting.engine || '(missing)'}`)
  if (!SUPPORTED[setting.engine].models.includes(setting.model)) throw new Error(`${label}: model ${setting.model || '(missing)'} is not supported by ${setting.engine}`)
  if (!REASONING.includes(setting.reasoning)) throw new Error(`${label}: unsupported reasoning level ${setting.reasoning || '(missing)'}`)
  return { engine: setting.engine, model: setting.model, reasoning: setting.reasoning,
    ...(setting.fallback != null ? { fallback: validateAssignment(setting.fallback, `${label} fallback`) } : {}) }
}

function legacySetting(config, stage) {
  const role = legacyRole[stage]
  const engine = config.engines?.[role] ?? config.engine ?? { kind: 'claude' }
  const kind = kindOf(engine) || 'claude'
  const requested = config.models?.[role] || config.models?.working
  // Legacy fixtures and older boards may use a local alias (for example
  // "test"). Keep them readable while newly saved settings remain strict.
  const model = SUPPORTED[kind]?.models.includes(requested) ? requested : SUPPORTED[kind]?.models[0]
  return validateAssignment({ engine: kind, model, reasoning: reasoningOf(engine) }, `legacy ${stage}`)
}

export function globalSettings(config) {
  const saved = config.agentSettings?.global || {}
  return Object.fromEntries(STAGES.map(stage => [stage, validateAssignment({ ...legacySetting(config, stage), ...saved[stage] }, `global ${stage}`)]))
}

// The launch guard (herdr.mjs BOARD_MODELS) refuses unapproved models per role. Refuse them
// here too, or a saved setting only fails at agent start and sends cards to Owner (2026-09-26 I229).
const ROLE = { planning: 'p', working: 'b', review: 'r', trivial: 'b' }
function assertLaunchable(stage, setting) {
  const allowed = [approvedManagedModel(`${ROLE[stage]}-t-1`) ?? []].flat()
  if (allowed.length && !allowed.includes(setting.model)) throw new Error(`${stage}: model ${setting.model} is not approved for board launches (allowed: ${allowed.join(', ')})`)
  if (setting.fallback) assertLaunchable(stage, setting.fallback)
  return setting
}

export function validateSettingsPatch(config, patch) {
  const current = globalSettings(config)
  const next = { ...current }
  for (const stage of STAGES) {
    if (patch?.[stage] === undefined) continue
    next[stage] = assertLaunchable(stage, validateAssignment({ ...current[stage], ...patch[stage] }, `global ${stage}`))
  }
  return next
}

export function assignmentFor(config, card, stage) {
  const global = globalSettings(config)[stage]
  const override = card?.agentSettings?.[stage] || config.agentSettings?.cardOverrides?.[card?.id]?.[stage]
  return validateAssignment({ ...global, ...(override || {}) }, `${card?.id || 'card'} ${stage}`)
}

export function engineForAssignment(setting) {
  return {
    kind: setting.engine,
    ...(setting.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${setting.reasoning}"`] } : {}),
  }
}

export function catalog() {
  return Object.fromEntries(Object.entries(SUPPORTED).map(([engine, data]) => [engine, { models: [...data.models], reasoning: [...data.reasoning] }]))
}

const labels = { planning: 'Planner', working: 'Builder', review: 'Reviewer', trivial: 'Trivial' }
const fields = ['engine', 'model', 'reasoning']
export function setCardOverride(tasksDir, cardId, stage, patch, config) {
  if (!STAGES.includes(stage)) throw new Error(`unsupported settings stage ${stage}`)
  const card = findCard(tasksDir, cardId)
  const current = card.agentSettings?.[stage] || {}
  const next = assertLaunchable(stage, validateAssignment({ ...assignmentFor(config, card, stage), ...current, ...patch }, `${card.id} ${stage}`))
  let text = readFileSync(card.path, 'utf8')
  for (const field of fields) {
    const marker = new RegExp(`^\\*\\*${labels[stage]} ${field}:\\*\\*[^\\n]*$`, 'im')
    const line = `**${labels[stage]} ${field}:** ${next[field]}`
    text = marker.test(text) ? text.replace(marker, line) : `${text.trimEnd()}\n${line}\n`
  }
  writeFileSync(card.path, text)
  return findCard(tasksDir, card.id)
}
