import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { fileURLToPath } from 'node:url'
import { allowCardRunPrompt, stopCardRun } from './card-run.mjs'

const configPath = () => process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url))
const sessionKey = name => String(name || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
export function projectEnvironment(project) {
  const config = JSON.parse(readFileSync(configPath(), 'utf8'))
  const name = config.projects?.find(name => sessionKey(name) === sessionKey(project)) || project
  const path = config.projectSettings?.[name]?.envFile
  if (!path) return null
  if (!existsSync(path)) throw new Error('Approved environment file unavailable; restore it before dispatch')
  const stat = statSync(path)
  return { path, size: stat.size, modified: stat.mtimeMs }
}
export function controlState(project, path = configPath()) {
  if (!existsSync(path)) return { paused: false }
  const config = JSON.parse(readFileSync(path, 'utf8'))
  const name = config.projects?.find(name => sessionKey(name) === sessionKey(project)) || project
  return { ...config.projectControls?.[name], paused: config.maxConcurrentAgents === 0 || config.projectControls?.[name]?.paused === true }
}
export function assertPromptAllowed(project, boundary) {
  if (allowCardRunPrompt(project, boundary)) return
  if (controlState(project).paused) throw Object.assign(new Error(`Project ${project} is paused; assignment retained pending Start`), { paused: true, preservePane: true })
}
// `extra` rides on the control (a release marker); a plain Pause keeps an active release, Start ends it.
// A release's finish/abort passes liftHold false: it must not undo the operator's agent cap of 0
// (2026-10-01: an Injectbuddy release abort restarted 4 agents during a hold).
export function setProjectPaused(project, paused, path = configPath(), extra = {}, { liftHold = true } = {}) {
  const config = JSON.parse(readFileSync(path, 'utf8'))
  if (!config.projects.includes(project) || typeof paused !== 'boolean') throw new Error('Known project and boolean paused required')
  stopCardRun(project, null, paused ? 'Paused by operator' : 'Project control changed; explicit authorization cancelled')
  config.projectControls ||= {}
  // Migrating the old global zero-slot stop must not resume other projects.
  if (config.maxConcurrentAgents === 0) {
    for (const name of config.projects) config.projectControls[name] = { ...config.projectControls[name], paused: true }
    if (!paused && liftHold) config.maxConcurrentAgents = config.resumeMaxConcurrentAgents || 10
  }
  const release = paused ? config.projectControls[project]?.release : undefined
  config.projectControls[project] = { paused, changedAt: new Date().toISOString(), ...(release && { release }), ...extra }
  writeFileSync(path + '.tmp', JSON.stringify(config, null, 2) + '\n')
  renameSync(path + '.tmp', path)
  return config
}
