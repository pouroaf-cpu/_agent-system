// Card ids and board agent names.
//
// A card id is either the legacy `T-7` or a per-project prefix plus number with no
// hyphen (`I149`, `TF40`, `HK14`). Both forms share one number space per project,
// so T-149 and I149 are the same number and can never both be issued.
export const CARD_ID = String.raw`(?:T-\d+|[A-Z]{1,3}\d+)`
const EXACT = new RegExp(`^${CARD_ID}$`, 'i')
export const isCardId = (id) => EXACT.test(String(id ?? ''))
export const cardNumber = (id) => isCardId(id) ? Number(String(id).match(/\d+$/)[0]) : 0
export function nextCardId(prefix = 'T-', ids = []) {
  if (!/^(?:T-|[A-Z]{1,3})$/.test(prefix)) throw new Error(`Card prefix must be T- or 1-3 capital letters, got: ${prefix}`)
  return `${prefix}${Math.max(0, ...ids.map(cardNumber)) + 1}`
}

// Board agents are named <role>-<card id>, lowercased because herdr only accepts
// [a-z][a-z0-9_-]{0,31}: b-i149, p-tf40, r-hk14, b-t-11. herdr adds nothing; a
// clash with a live name gets -2, -3 appended by agentStart. The older kb-* names
// stay recognised until those agents finish.
const ROLES = { planner: 'p', builder: 'b', reviewer: 'r', issues: 'i', auditor: 'a' }
export const agentName = (role, cardId) => `${ROLES[role]}-${String(cardId).toLowerCase()}`
const ROLE_NAME = /^([pbria])-(t-\d+|[a-z]{1,3}\d+)(?:-\d+)?$/
const LEGACY = [[/^kb-review-/, 'r'], [/^kb-plan-/, 'i'], [/^kb-planner-/, 'p'], [/^kb-t-/, 'b']]
export function agentRole(name = '') {
  return ROLE_NAME.exec(name)?.[1] ?? LEGACY.find(([rx]) => rx.test(name))?.[1] ?? null
}
export const agentCard = (name = '') => ROLE_NAME.exec(name)?.[2]?.toUpperCase() ?? null
export const isBoardAgent = (agent) => (agent?.name || '').startsWith('kb-') || !!agentRole(agent?.name)
export const isReviewerAgent = (agent) => ['r', 'a'].includes(agentRole(agent?.name))
export const isSweeperAgent = (agent) => agentRole(agent?.name) === 'i'
