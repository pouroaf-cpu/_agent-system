import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { appendHistory, focusedText } from './card-history.mjs'
import { withBoardLock } from './bindings.mjs'
import { stopCardRun } from './card-run.mjs'
import { basename } from 'node:path'

const file = dir => join(dir, '.workflow-state.json')
export const readWorkflow = dir => existsSync(file(dir)) ? JSON.parse(readFileSync(file(dir), 'utf8')) : {}
export function updateWorkflow(dir, id, patch) {
  return withBoardLock(dir, () => {
  const state = readWorkflow(dir)
  state[id] = { ...state[id], ...patch }
  writeFileSync(file(dir) + '.tmp', JSON.stringify(state, null, 2) + '\n')
  renameSync(file(dir) + '.tmp', file(dir))
  return state[id]
  })
}
export function prerequisiteFingerprint(card, workspace, gitSettings) {
  const current = focusedText(readFileSync(card.path, 'utf8'), 'planner').replace(/^## Current feedback\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/m, '')
  const hash = createHash('sha256').update(current)
  const paths = [join(workspace, 'package.json'), join(workspace, 'package-lock.json'), join(workspace, 'pnpm-lock.yaml'), join(workspace, 'yarn.lock'), gitSettings?.envFile].filter(Boolean)
  for (const path of paths) {
    hash.update(path)
    if (existsSync(path)) {
      const stat = statSync(path)
      hash.update(`${stat.size}:${stat.mtimeMs}`)
      if (path !== gitSettings?.envFile) hash.update(readFileSync(path))
    } else hash.update('missing')
  }
  const manifest = join(workspace, 'package.json')
  if (existsSync(manifest)) {
    const p = JSON.parse(readFileSync(manifest, 'utf8'))
    for (const name of Object.keys({ ...p.dependencies, ...p.devDependencies }).sort()) {
      const path = resolve(workspace, 'node_modules', name, 'package.json')
      hash.update(name + (existsSync(path) ? readFileSync(path, 'utf8') : 'missing'))
    }
  }
  hash.update(evidenceFingerprint(card, workspace))
  return hash.digest('hex')
}
export function evidenceFingerprint(card, workspace) {
  const text = readFileSync(card.path, 'utf8')
  const hash = createHash('sha256')
  for (const name of ['Approved brief', 'Project constraints', 'Implementation plan', 'Acceptance criteria', 'Outcome checks', 'Prerequisites']) hash.update(text.match(new RegExp(`^## ${name}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1]?.trim() || '')
  const files = text.match(/^## Files\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] || ''
  for (const [, name] of files.matchAll(/^-\s+`([^`]+)`/gm)) {
    if (/^(?:[A-Za-z]:|[/\\])|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(name)) throw new Error('Evidence files must stay inside their workspace')
    const path = resolve(workspace, name)
    hash.update(name).update(existsSync(path) ? readFileSync(path) : '<missing>')
  }
  for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) if (existsSync(join(workspace, name))) hash.update(name).update(readFileSync(join(workspace, name)))
  return hash.digest('hex')
}
export function operationalHold(tasksDir, card, workspace, gitSettings) {
  const pending = readWorkflow(tasksDir)[card.id]?.operational
  return pending && pending.fingerprint === prerequisiteFingerprint(card, pending.workspace || workspace, { envFile: pending.envFile }) ? pending.reason : null
}
export function recordOperationalFailure(tasksDir, card, reason, workspace, gitSettings) {
  stopCardRun(basename(resolve(tasksDir, '..')), card.id, reason)
  const fingerprint = prerequisiteFingerprint(card, workspace, gitSettings)
  const previous = readWorkflow(tasksDir)[card.id]?.operational
  if (previous?.fingerprint === fingerprint && previous.reason === reason) return previous
  const event = appendHistory(tasksDir, card.id, { event: 'operational-failure', stage: card.column, reason, fingerprint })
  const operational = { reason, fingerprint, workspace, envFile: gitSettings?.envFile, at: event.at, historyId: event.id, stage: card.column }
  updateWorkflow(tasksDir, card.id, { operational })
  return operational
}
export function failureCategory(note) {
  return note.match(/^\s*\[(implementation|planning|operational|evidence|incidental)\]/i)?.[1]?.toLowerCase() || 'evidence'
}
// Review runs on integrated code, so a failed review needs a planned fix, not a
// Builder replay of the already-integrated commit.
export function failureDestination(category, current) {
  return category === 'planning' || (category === 'implementation' && current === 'review') ? 'planning' : category === 'implementation' ? 'queue' : current
}
