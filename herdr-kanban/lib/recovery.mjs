import { randomUUID } from 'node:crypto'
const marker = /^\*\*Recovery:\*\* (.+)$/m
export function recoveryState(text) {
  const value = text.match(marker)?.[1]
  if (!value) return { returns: 0, attempt: 'initial', counted: null }
  return JSON.parse(value) // Corruption fails closed, never silently resets.
}
export function recoveryTransition(text, from, to, { intake = false, correction = false } = {}) {
  const state = recoveryState(text)
  let changed = false
  // One issued plan = one attempt; duplicate polling/delivery cannot mint one.
  const replanned = from === 'planning' && ['planned', 'queue', 'review', 'working'].includes(to)
  if (replanned || (from === 'queue' && to === 'working')) {
    state.attempt = randomUUID(); changed = true
  }
  // `plan` changes only on a new plan, not on every dispatch: a card worktree from an
  // earlier plan is preserved and replaced, never reused (Injectbuddy I195).
  if (replanned) state.plan = state.attempt
  const failedReturn = !intake && ((to === 'planning' && ['issues', 'queue', 'working', 'review', 'completed'].includes(from)) || (correction && to === 'queue' && ['working', 'review', 'completed'].includes(from)))
  if (failedReturn && state.counted !== state.attempt) {
    state.returns++; state.counted = state.attempt; changed = true
    text += `\n\n**Failed return ${state.returns}** ${new Date().toISOString()} — ${from} -> ${to}; preceding failure evidence retained.\n`
  }
  if (failedReturn && state.returns >= 5) {
    to = 'owner'
    if (!state.escalatedAt) {
      state.escalatedAt = new Date().toISOString(); changed = true
      text += '\n\n**Needs you**\nFive distinct failed returns reached. Automatic recovery stopped. Review the five attempts and failure evidence on this card; choose a changed recovery approach, narrow scope, or cancel. No unchanged retry is authorized.\n'
    }
  }
  if (changed) text = marker.test(text) ? text.replace(marker, `**Recovery:** ${JSON.stringify(state)}`) : `${text}\n\n**Recovery:** ${JSON.stringify(state)}\n`
  return { text, to, state }
}
