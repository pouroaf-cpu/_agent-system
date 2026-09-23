import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
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
export function setProjectPaused(project, paused, path = configPath()) {
  const config = JSON.parse(readFileSync(path, 'utf8'))
  if (!config.projects.includes(project) || typeof paused !== 'boolean') throw new Error('Known project and boolean paused required')
  stopCardRun(project, null, paused ? 'Paused by operator' : 'Project control changed; explicit authorization cancelled')
  config.projectControls ||= {}
  // Migrating the old global zero-slot stop must not resume other projects.
  if (config.maxConcurrentAgents === 0) {
    for (const name of config.projects) config.projectControls[name] = { ...config.projectControls[name], paused: true }
    if (!paused) config.maxConcurrentAgents = config.resumeMaxConcurrentAgents || 10
  }
  config.projectControls[project] = { paused, changedAt: new Date().toISOString() }
  writeFileSync(path + '.tmp', JSON.stringify(config, null, 2) + '\n')
  renameSync(path + '.tmp', path)
  return config
}
