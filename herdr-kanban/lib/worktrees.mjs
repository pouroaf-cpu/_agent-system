// Isolated Git worktrees for Builder cards. Runtime state lives beside the board,
// never in a card or a pushed branch.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, fsyncSync, statSync, lstatSync, symlinkSync, readdirSync, statfsSync, copyFileSync, rmSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { cardFiles, findCard, readBoard, filesOverlap } from './cards.mjs'
import { evidenceFingerprint } from './workflow-state.mjs'
import { recoveryState } from './recovery.mjs'
import { lockOwnerReplaced } from './bindings.mjs'
import { isTransient, nextRetry, retryHold, inBackoff, killTree } from './transient.mjs'
import { fileURLToPath } from 'node:url'

const registryPath = (tasksDir) => join(tasksDir, '.board-worktrees.json')
const lockPath = (tasksDir) => join(tasksDir, '.board-integration.lock')
const busy = new Set()

export function readWorktrees(tasksDir) {
  const path = registryPath(tasksDir)
  if (!existsSync(path)) return {}
  const all = JSON.parse(readFileSync(path, 'utf8'))
  if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error(`invalid worktree registry: ${path}`)
  return all
}

function writeWorktrees(tasksDir, all) {
  mkdirSync(tasksDir, { recursive: true })
  const path = registryPath(tasksDir)
  const temp = `${path}.${process.pid}.tmp`
  const fd = openSync(temp, 'w')
  try { writeFileSync(fd, JSON.stringify(all, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, path)
}

function updateEntry(tasksDir, id, patch) {
  const all = readWorktrees(tasksDir)
  if (patch === null) delete all[id.toUpperCase()]
  else all[id.toUpperCase()] = { ...all[id.toUpperCase()], ...patch }
  writeWorktrees(tasksDir, all)
  return all[id.toUpperCase()]
}

function git(cwd, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { cwd, encoding, maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })
  if (result.error) throw new Error(`git ${args[0]} failed in ${cwd}: ${result.error.message}`)
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args[0]} failed in ${cwd}: ${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`)
  }
  return result
}

const slash = (path) => path.replaceAll('\\', '/')
const norm = (path) => slash(resolve(path)).toLowerCase()
// Compare each layer separately: staged edits must not disappear when the worktree
// happens to cancel them back to HEAD. Git applies its own attributes/EOL filters.
export function semanticDirtyFiles(cwd) {
  if (!git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).stdout) return []
  const args = ['--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none']
  return [...new Set([
    ...git(cwd, ['diff', ...args]).stdout.split('\0'),
    ...git(cwd, ['diff', '--cached', ...args, 'HEAD']).stdout.split('\0'),
    ...git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0'),
    ...git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']).stdout.split('\0'),
  ].filter(Boolean))]
}

function operationInProgress(cwd) {
  const dir = git(cwd, ['rev-parse', '--absolute-git-dir']).stdout.trim()
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].find(name => existsSync(join(dir, name)))
}

export const clean = (cwd) => !operationInProgress(cwd) && semanticDirtyFiles(cwd).length === 0

// Agent tool output (Playwright MCP, Impeccable) lands in whatever checkout an agent
// runs from. Untracked there, it made the Injectbuddy integration checkout "dirty" and
// held every merge (2026-09-25). Ignore it locally for all of a repo's worktrees.
// .codex/hooks.json is the board Stop hook writeCodexWorkspaceHooks drops into each card worktree.
const TOOL_OUTPUT = ['.playwright-mcp/', '.impeccable/', '.codex/hooks.json']
export function ignoreToolOutput(repoRoot) {
  try {
    const common = resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-common-dir']).stdout.trim())
    const path = join(common, 'info', 'exclude')
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const lines = text.split(/\r?\n/)
    const missing = TOOL_OUTPUT.filter(line => !lines.includes(line))
    if (!missing.length) return
    mkdirSync(dirname(path), { recursive: true })
    const sep = text && !text.endsWith('\n') ? '\n' : ''
    writeFileSync(path, `${text}${sep}# kanban: agent tool output\n${missing.join('\n')}\n`)
  } catch { /* best effort: the dirty check still protects the checkout */ }
}

// Operator must quiesce external writers; the integration caller already owns
// the serial board lock. The index lock also excludes normal concurrent Git writes.
export function normalizeGuardedEol(cwd) {
  const repo = git(cwd, ['rev-parse', '--show-toplevel']).stdout.trim()
  const indexPath = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).stdout.trim()
  const lock = `${indexPath}.lock`
  const lockFd = openSync(lock, 'wx')
  let backupDir
  try {
    const head = git(repo, ['rev-parse', 'HEAD']).stdout.trim()
    const index = readFileSync(indexPath)
    if (!clean(repo)) throw new Error('EOL recovery requires no staged, substantive, untracked or unfinished changes')
    const unchanged = () => {
      if (git(repo, ['rev-parse', 'HEAD']).stdout.trim() !== head || !readFileSync(indexPath).equals(index) || operationInProgress(repo)) throw new Error('HEAD/index/operation changed during EOL recovery')
    }
    const candidates = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).stdout.split('\0').filter(Boolean)
    const files = candidates.map(entry => {
      if (!entry.startsWith(' M ')) throw new Error('EOL recovery refuses non-unstaged-modification status')
      const path = entry.slice(3)
      if (isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe EOL recovery path')
      let absolute = repo
      for (const part of path.split('/')) {
        absolute = join(absolute, part)
        const stat = lstatSync(absolute)
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsafe EOL recovery file: ${path}`)
      }
      if (!lstatSync(absolute).isFile() || lstatSync(absolute).nlink > 1) throw new Error(`Not an independent regular EOL recovery file: ${path}`)
      const attrs = git(repo, ['check-attr', '-z', 'filter', 'working-tree-encoding', 'ident', '--', path]).stdout.split('\0')
      for (let i = 2; i < attrs.length; i += 3) if (!['unspecified', 'unset'].includes(attrs[i])) throw new Error(`EOL recovery refuses custom transforms: ${path}`)
      const staged = git(repo, ['ls-files', '--stage', '-z', '--', path]).stdout
      if (!/^100(?:644|755) [a-f0-9]+ 0\t[^\0]+\0$/.test(staged)) throw new Error(`EOL recovery requires one regular index entry: ${path}`)
      const original = readFileSync(absolute)
      const lf = bytes => Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
      const blob = git(repo, ['cat-file', 'blob', `HEAD:${path}`], { encoding: null }).stdout
      // Native checkout policy includes core.autocrlf when no eol attribute exists.
      // Custom transforms were rejected above; require exact EOL equivalence again.
      const normalized = git(repo, ['cat-file', '--filters', `HEAD:${path}`], { encoding: null }).stdout
      if (original.includes(0) || original.equals(normalized) || !lf(original).equals(blob) || !lf(normalized).equals(blob)) throw new Error(`Not pure checkout-EOL equivalence: ${path}`)
      return { path, absolute, original, normalized, attrs: attrs.join('\0'), stat: lstatSync(absolute) }
    })
    if (!files.length) return { files: [], backupDir: null }
    const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).stdout.trim()
    const backups = join(gitDir, 'kanban-eol-backups')
    mkdirSync(backups, { recursive: true })
    backupDir = mkdtempSync(join(backups, 'recovery-'))
    const durable = (path, bytes) => { const fd = openSync(path, 'wx'); try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) } }
    files.forEach((file, i) => durable(join(backupDir, `${i}.original`), file.original))
    durable(join(backupDir, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), repo, head, reason: 'Approved byte-proven Git checkout-EOL normalization; no staging', files: files.map((file, i) => ({ path: file.path, backup: `${i}.original` })) }, null, 2))
    unchanged()
    for (const file of files) {
      unchanged()
      const stat = lstatSync(file.absolute)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== file.stat.ino || stat.dev !== file.stat.dev || stat.nlink > 1) throw new Error(`File identity changed during EOL recovery: ${file.path}`)
      if (git(repo, ['check-attr', '-z', 'filter', 'working-tree-encoding', 'ident', '--', file.path]).stdout !== file.attrs) throw new Error(`Attributes changed during EOL recovery: ${file.path}`)
      if (!git(repo, ['cat-file', '--filters', `HEAD:${file.path}`], { encoding: null }).stdout.equals(file.normalized)) throw new Error(`Checkout policy changed during EOL recovery: ${file.path}`)
      if (!readFileSync(file.absolute).equals(file.original)) throw new Error(`File changed during EOL recovery: ${file.path}`)
      writeFileSync(file.absolute, file.normalized)
      if (!readFileSync(file.absolute).equals(file.normalized)) throw new Error(`File changed after EOL recovery: ${file.path}`)
    }
    unchanged()
    return { files: files.map(file => file.path), backupDir }
  } catch (err) { throw new Error(`${err.message}${backupDir ? `; originals preserved at ${backupDir}` : ''}`) }
  finally { closeSync(lockFd); unlinkSync(lock) }
}

// Metadata refresh first; approved byte-proven normalization is the fallback.
function refreshClean(cwd, { normalize = false } = {}) {
  if (!clean(cwd)) throw new Error(`worktree is dirty or has an unfinished Git operation: ${cwd}`)
  const refresh = git(cwd, ['update-index', '--refresh'], { allowFailure: true })
  if (refresh.status === 0) return
  if (!normalize) throw new Error(`metadata refresh blocked; preserved without normalization: ${cwd}`)
  const normalization = normalizeGuardedEol(cwd)
  git(cwd, ['update-index', '--refresh'])
  return normalization
}

export function integrationStartHoldReason({ repoRoot, workspace = repoRoot, card }) {
  const operation = operationInProgress(repoRoot)
  if (operation) return `integration Git operation in progress: ${operation}`
  const files = filesFor(card, workspace)
  if (!files.length) return 'card not ready — no exact files listed'
  const dirty = semanticDirtyFiles(repoRoot).find(path => {
    const absolute = norm(resolve(repoRoot, path))
    return files.some(file => filesOverlap(file, absolute) || filesOverlap(file, `${absolute}/**`) || absolute.startsWith(`${file}/`))
  })
  return dirty ? `integration file has substantive changes: ${dirty}; preserved for reconciliation` : null
}

function gitRoot(workspace) {
  const result = git(workspace, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (result.status === 0) return result.stdout.trim()
  if (/not a git repository/i.test(result.stderr)) return null
  throw new Error(`Git root check failed: ${(result.stderr || result.stdout).trim()}`)
}

export function resolveGitSettings({ projectPath, gitSettings }) {
  // manager is the project chat's registration, not a Git setting: alone it must not make a
  // project without a Git root look Git-integrated.
  if (gitSettings?.manager) {
    const { manager, ...rest } = gitSettings
    gitSettings = Object.keys(rest).length ? rest : undefined
  }
  const repoRoot = gitRoot(gitSettings?.integrationPath || projectPath)
  if (!repoRoot) return gitSettings
  return { ...gitSettings, integrationPath: gitSettings?.integrationPath || repoRoot,
    worktreesRoot: gitSettings?.worktreesRoot || join(dirname(repoRoot), '.kanban-worktrees', repoRoot.split(/[\\/]/).pop()) }
}

// Drift or missing packages carry `installIn`: the board installs in that card
// workspace in the background instead of routing the card to Owner (Tradeflow T-34).
const needsInstall = (workspacePath, message) => Object.assign(new Error(`dependency setup needed: ${message}; installing dependencies in ${workspacePath}`), { installIn: workspacePath })
const LOCKFILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
const sameText = (a, b) => existsSync(a) === existsSync(b) && (!existsSync(a) || readFileSync(a, 'utf8').replaceAll('\r\n', '\n') === readFileSync(b, 'utf8').replaceAll('\r\n', '\n'))

function prepareDependencies(workspacePath, source) {
  if (!existsSync(join(workspacePath, 'package.json'))) return
  const manifest = JSON.parse(readFileSync(join(workspacePath, 'package.json'), 'utf8'))
  const requireInstalled = (root) => {
    const missing = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(name => !existsSync(join(root, 'node_modules', name, 'package.json')))
    if (missing.length) throw needsInstall(workspacePath, `missing ${missing.slice(0, 4).join(', ')}`)
  }
  const local = join(workspacePath, 'node_modules')
  if (existsSync(local) && !lstatSync(local).isSymbolicLink()) { requireInstalled(workspacePath); return }
  if (!existsSync(join(source, 'node_modules'))) {
    const common = git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()
    const mainCheckout = dirname(common)
    if (existsSync(join(mainCheckout, 'node_modules'))) source = mainCheckout
  }
  if (!existsSync(join(source, 'node_modules'))) {
    if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length) throw new Error(`dependency setup needed: install dependencies in ${workspacePath}`)
    return
  }
  const drift = LOCKFILES.find(file => !sameText(join(workspacePath, file), join(source, file)))
  if (drift) throw needsInstall(workspacePath, `${drift} differs from integration`)
  if (existsSync(local)) { requireInstalled(workspacePath); return } // our junction, still matching
  if (git(workspacePath, ['check-ignore', 'node_modules/'], { allowFailure: true }).status !== 0) return
  requireInstalled(source)
  symlinkSync(join(source, 'node_modules'), local, process.platform === 'win32' ? 'junction' : 'dir')
}

export function prepareWorktreeEnvironment(entry) {
  prepareDependencies(entry.workspacePath, entry.integrationWorkspace)
}

export const freeGb = (path) => { const s = statfsSync(path); return s.bavail * s.bsize / 1e9 }
const installs = new Map() // folder -> { running, startedAt, pid, failures, error, retry }
export const INSTALL_TIMEOUT_MS = 20 * 60000

// A restart kills the board with Stop-Process, but its `shell: true` install keeps running
// on Windows. Running installs are recorded beside the board config so the new process
// waits for them instead of starting a second npm ci in the same folder.
const installsPath = () => join(dirname(process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url))), '.dependency-installs.json')
const pidAlive = pid => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }
// ponytail: a PID Windows reuses within the timeout reads as a live install; the timeout bounds that wait
function recordedInstalls(now) {
  let all = {}
  try { all = JSON.parse(readFileSync(installsPath(), 'utf8')) } catch { /* none, or torn: nothing to wait for */ }
  return Object.fromEntries(Object.entries(all).filter(([, r]) => now - r.startedAt < INSTALL_TIMEOUT_MS && pidAlive(r.pid)))
}
function recordInstall(key, record) {
  const all = recordedInstalls(Date.now())
  if (record) all[key] = record
  else delete all[key]
  writeFileSync(installsPath(), JSON.stringify(all, null, 2))
}

function runInstall(folder, command, logPath, onStart) {
  return new Promise((done, fail) => {
    const out = openSync(logPath, 'a')
    let finished = false
    const finish = (err) => { if (finished) return; finished = true; closeSync(out); err ? fail(err) : done() }
    const child = spawn(command, { cwd: folder, shell: true, windowsHide: true, stdio: ['ignore', out, out] })
    if (child.pid) onStart?.(child.pid)
    child.on('error', finish)
    child.on('close', code => finish(code === 0 ? null : installFailure(command, code, logPath)))
  })
}

// npm's exit code alone (4294963248) hides the cause. Name the file-lock errors from its log
// so the transient backoff sees them: I266 went to Owner over EPERM on a .node file a running
// next dev server had loaded (2026-09-26).
export function installFailure(command, code, logPath) {
  let why
  try { why = readFileSync(logPath, 'utf8').slice(-20000).match(/\b(EPERM|EBUSY|ENOTEMPTY|ETIMEDOUT)\b/)?.[1] } catch { /* no log */ }
  return new Error(`${command} exited with code ${code}${why ? ` (${why})` : ''}; see ${logPath}`)
}

const installCommand = folder => existsSync(join(folder, 'pnpm-lock.yaml')) ? 'pnpm install --frozen-lockfile'
  : existsSync(join(folder, 'yarn.lock')) ? 'yarn install --frozen-lockfile'
  : existsSync(join(folder, 'package-lock.json')) ? 'npm ci --no-audit --no-fund' : null

// One background install per folder, behind the 5 GB disk guard. Returns the hold
// reason ("installing dependencies in ..." is an allowed wait), or null when no
// lockfile says how to install. Two failures hold for Owner with the reason; a transient
// one (ENOTEMPTY/EPERM from a locked file, a timeout) backs off instead (I246, I248).
export function startDependencyInstall({ folder, tasksDir, install = runInstall, free = freeGb, minFreeGb = 5, now = Date.now() }) {
  // A hung install would hold the board-wide slot forever: past the timeout its process
  // tree is killed and it retries as a transient failure.
  for (const [hung, run] of installs) {
    if (!run.running || now - run.startedAt < INSTALL_TIMEOUT_MS) continue
    if (run.pid) { killTree(run.pid); recordInstall(hung, null) }
    installs.set(hung, { failures: run.failures, error: `install timed out after ${INSTALL_TIMEOUT_MS / 60000} min and was stopped`, retry: nextRetry(run.retry, now) })
  }
  const key = norm(folder), state = installs.get(key) || { failures: 0 }
  const waiting = `installing dependencies in ${folder}${state.error ? ` (retry after: ${state.error})` : ''}`
  if (state.running) return waiting
  if (state.failures >= 2) return `dependency install failed twice in ${folder}: ${state.error}`
  if (state.retry && !inBackoff(state.retry, now)) return `dependency install kept failing in ${folder} for 3 hours: ${state.error}`
  if (state.retry?.nextAt > now) return retryHold(`installing dependencies in ${folder} (last try failed: ${state.error})`, state.retry.nextAt)
  // One install at a time, board-wide: parallel `npm ci` runs (about 1.5 GB each) on a
  // loaded machine crashed Injectbuddy I246's install three times in two minutes.
  if ([...installs.values()].some(other => other.running)) return `installing dependencies in ${folder} (queued behind another install)`
  const survivors = Object.values(recordedInstalls(now))
  if (survivors.some(r => norm(r.folder) === key)) return `installing dependencies in ${folder} (started before the board restarted; waiting for it to finish)`
  if (survivors.length) return `installing dependencies in ${folder} (queued behind another install)`
  const command = installCommand(folder)
  if (!command) return null
  const gb = free(folder)
  if (gb < minFreeGb) return `Drive ${parse(folder).root.replace(/[\\/]$/, '')} has only ${gb.toFixed(1)} GB free; free up space so dependencies can install`
  // Detach a shared node_modules junction first: unlink the link only, never delete through it.
  const modules = join(folder, 'node_modules')
  try { if (lstatSync(modules).isSymbolicLink()) unlinkSync(modules) } catch (err) { if (err.code !== 'ENOENT') throw err }
  mkdirSync(join(tasksDir, '.evidence'), { recursive: true })
  const logPath = join(tasksDir, '.evidence', `dependency-install-${Date.now()}.log`)
  const run = { ...state, running: true, startedAt: now }
  installs.set(key, run)
  // Only this run may settle its slot: a hung run already expired above must not overwrite a newer one.
  const settle = (err) => {
    if (installs.get(key) !== run) return
    if (run.pid) recordInstall(key, null)
    if (!err) return installs.delete(key)
    const error = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 300)
    installs.set(key, isTransient(error) ? { failures: state.failures, error, retry: nextRetry(state.retry, Date.now()) } : { failures: state.failures + 1, error })
  }
  Promise.resolve().then(() => install(folder, command, logPath, pid => { run.pid = pid; recordInstall(key, { folder, pid, startedAt: Date.now() }) }))
    .then(() => settle(null), settle)
  return waiting
}

// Before a Builder starts: when the integration folder has a lockfile but no
// node_modules, install there once in the background instead of sending the card
// to Owner. A card workspace install (started when the spawn found drift) holds
// the card while it runs. Returns a hold reason, or null when the card may start.
// A node_modules folder is not an install: Tradeflow's shared one was empty and Injectbuddy's
// half-installed, so the board never repaired them and every card downloaded its own copy.
function installedIn(folder, root) {
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).every(name => existsSync(join(root, 'node_modules', name, 'package.json')))
}

export function dependencyInstallHold({ card, projectPath, tasksDir, gitSettings, install = runInstall, free = freeGb, minFreeGb = 5, now = Date.now() }) {
  try {
    const opts = { tasksDir, install, free, minFreeGb, now }
    const entry = readWorktrees(tasksDir)[card.id.toUpperCase()]
    const own = entry?.workspacePath && installs.get(norm(entry.workspacePath))
    if (own?.running || own?.failures >= 2 || own?.retry) return startDependencyInstall({ folder: entry.workspacePath, ...opts })
    const folder = resolve(gitSettings?.integrationPath || projectPath, card.workspace || '.')
    if (!existsSync(join(folder, 'package.json'))) return null
    const state = installs.get(norm(folder)) || { failures: 0 }
    if (state.running || state.failures >= 2 || state.retry) return startDependencyInstall({ folder, ...opts })
    // Installed, not merely present: a card's node_modules is a junction to integration's,
    // and an emptied integration folder still exists (Tradeflow TF95, Injectbuddy I332).
    if (entry?.workspacePath && installedIn(folder, entry.workspacePath)) return null
    if (!state.failures && installedIn(folder, folder)) return null
    if (!gitRoot(folder)) return null // non-Git projects keep their own workspace
    // The main checkout counts only when integration has no node_modules, exactly as in
    // prepareDependencies; otherwise a partial integration install passed here and failed
    // every card's spawn instead of holding the queue once (throughput audit 2026-09-26 F3).
    if (!state.failures && !existsSync(join(folder, 'node_modules')) && installedIn(folder, dirname(git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()))) return null
    const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
    if (!Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length) return null
    return startDependencyInstall({ folder, ...opts })
  } catch {
    return null // the spawn path reports the dependency problem as before
  }
}

// Cards list files from the workspace (`app/x.tsx`) or from the project root with
// the workspace prefix (`site/app/x.tsx`). Drop that prefix unless the workspace
// really has a folder of that name, so it is never doubled (Tradeflow T-31..T-35).
function workspaceFiles(card, workspace) {
  const prefix = slash(card.workspace || '').replace(/^\.\/|\/+$/g, '')
  return cardFiles(card.path).map((file) => {
    const f = slash(file).replace(/^\.\//, '')
    return prefix && prefix !== '.' && f.toLowerCase().startsWith(`${prefix.toLowerCase()}/`) && !existsSync(join(workspace, prefix)) ? f.slice(prefix.length + 1) : f
  })
}

function filesFor(card, workspace) {
  return workspaceFiles(card, workspace).map((file) => norm(resolve(workspace, file))).sort()
}

function safeInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function uniqueName(card) {
  const id = card.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return `${id}-${Date.now().toString(36)}-${process.pid}`
}

// Git projects isolate by default; non-Git projects retain their workspace.
export function prepareCardWorktree({ projectPath, tasksDir, card, gitSettings }) {
  if (gitSettings?.envFile && !existsSync(gitSettings.envFile)) throw new Error('Required approved environment file is unavailable; restore it before dispatch')
  const integrationBase = resolve(gitSettings?.integrationPath || projectPath)
  const integrationWorkspace = resolve(integrationBase, card.workspace || '.')
  const repoRoot = gitRoot(integrationWorkspace)
  if (!repoRoot) return { git: false, workspacePath: integrationWorkspace, cwd: projectPath, created: false }
  ignoreToolOutput(repoRoot)
  const hold = integrationStartHoldReason({ repoRoot, workspace: integrationWorkspace, card })
  if (hold) throw new Error(hold)

  const id = card.id.toUpperCase()
  let existing = readWorktrees(tasksDir)[id]
  if (existing?.state === 'integrated' && existing.cleaned) {
    updateEntry(tasksDir, id, null) // An explicitly requeued card starts a fresh correction.
    existing = null
  }
  const plan = recoveryState(readFileSync(card.path, 'utf8')).plan
  // Git already removed this worktree but Windows kept its empty folder (Injectbuddy I238),
  // and its branch holds nothing beyond the base: nothing to preserve, start fresh.
  if (existing && existing.state !== 'integrated' && isResidue(existing)) {
    if (existsSync(existing.worktreePath)) removeEmptyResidue(existing.worktreePath)
    finishRegisteredRemoval(existing, false)
    updateEntry(tasksDir, id, null)
    existing = null
  }
  if (existing) {
    if (existing.state === 'integrated') throw new Error(`${id} is already integrated; cleanup is pending`)
    if (!existsSync(existing.worktreePath)) throw new Error(`${id} worktree registry points to missing path: ${existing.worktreePath}`)
  }
  // A worktree from an earlier plan sits on a stale base, often with a failed Builder's
  // work: Injectbuddy I195's next Builder found 192 unrelated changed files and stopped.
  // Save that work on a recovery branch, then start fresh on integration HEAD.
  // No recorded plan means current (worktrees made before this check keep resuming).
  if (existing?.planAttempt && existing.planAttempt !== plan) {
    const wt = existing.worktreePath
    if (!clean(wt)) { git(wt, ['add', '-A']); git(wt, ['commit', '-m', `${id}: work saved from an earlier plan attempt`]) }
    const head = git(wt, ['rev-parse', 'HEAD']).stdout.trim()
    if (head !== existing.baseCommit) {
      const recovery = `recovery/${existing.branch}-${Date.now().toString(36)}`
      git(existing.repoRoot, ['branch', recovery, head])
      git(wt, ['checkout', '--detach', existing.baseCommit]) // the work is on the recovery branch; leave the checkout at its base so it can be removed
      appendFileSync(card.path, `\n\n**Earlier plan's work saved** ${new Date().toISOString()}\n\nThe card worktree from the previous plan attempt held saved work; it is on branch \`${recovery}\`. This attempt starts from a fresh worktree on integration HEAD.\n`)
    }
    removeCleanWorktree(tasksDir, existing)
    existing = null
  }
  // An empty worktree made while the card waited sits on the base it was made from: I195's
  // Builder started on it after its prerequisites I243/I244 landed and never saw their fixes.
  // Fast-forward it (keeping its installed dependencies) before the Builder starts.
  if (existing && clean(existing.worktreePath) && git(existing.worktreePath, ['rev-parse', 'HEAD']).stdout.trim() === existing.baseCommit) {
    const head = git(repoRoot, ['rev-parse', 'HEAD']).stdout.trim()
    if (head !== existing.baseCommit) {
      git(existing.worktreePath, ['merge', '--ff-only', head])
      existing = updateEntry(tasksDir, id, { baseCommit: head })
    }
  }
  if (existing) {
    prepareDependencies(existing.workspacePath, integrationWorkspace)
    const resumed = updateEntry(tasksDir, id, { files: [...new Set([...(existing.files || []), ...filesFor(card, integrationWorkspace)])], state: 'building', reason: null, resumedAt: new Date().toISOString() })
    return { git: true, workspacePath: resumed.workspacePath, cwd: resumed.workspacePath, entry: resumed, created: false }
  }

  const workspaceRel = relative(repoRoot, integrationWorkspace)
  if (workspaceRel.startsWith('..') || resolve(repoRoot, workspaceRel) !== resolve(integrationWorkspace)) {
    throw new Error(`${card.workspace || '.'} is outside its Git repository`)
  }
  const name = uniqueName(card)
  const worktreesRoot = gitSettings?.worktreesRoot || join(dirname(repoRoot), '.kanban-worktrees', repoRoot.split(/[\\/]/).pop())
  const worktreePath = resolve(worktreesRoot, name)
  if (!safeInside(worktreesRoot, worktreePath)) throw new Error(`unsafe card worktree path: ${worktreePath}`)
  mkdirSync(dirname(worktreePath), { recursive: true })
  const branch = `kanban/${name}`
  const baseCommit = git(repoRoot, ['rev-parse', 'HEAD']).stdout.trim()
  git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit])
  const workspacePath = resolve(worktreePath, workspaceRel)
  const entry = {
    cardId: id,
    repoRoot: resolve(repoRoot),
    integrationWorkspace,
    envFile: gitSettings?.envFile,
    worktreePath,
    workspacePath,
    workspaceRel: slash(workspaceRel),
    branch,
    baseCommit,
    files: filesFor(card, integrationWorkspace),
    state: 'building',
    planAttempt: plan,
    createdAt: new Date().toISOString(),
  }
  updateEntry(tasksDir, id, entry)
  prepareDependencies(workspacePath, integrationWorkspace)
  return { git: true, workspacePath, cwd: workspacePath, entry, created: true }
}

// Lookup as findCard does (archive never wins; ambiguous or missing is unknown), in the
// board read once per poll: findCard is a full readBoard per registry entry.
function cardIn(cards, id) {
  const all = cards.filter((c) => c.id === id)
  const live = all.filter((c) => c.column !== 'archive')
  return live.length > 1 ? undefined : live[0] ?? all[0]
}

// parallelFiles (projectSettings.<project>.parallelFiles, repo-relative): big shared files
// whose cards edit separate parts. Builders may run on them at once; integration still lands
// one commit at a time, and a real conflict is rebased and goes back to a Builder once.
const notParallel = (projectPath, parallelFiles = []) => {
  const listed = new Set(parallelFiles.map(f => norm(resolve(projectPath, f))))
  return (file) => !listed.has(file)
}

export function overlapHoldReason({ tasksDir, card, projectPath, board = readBoard(tasksDir), parallelFiles }) {
  const all = filesFor(card, resolve(projectPath, card.workspace || '.'))
  if (!all.length) return 'card not ready — no exact files listed'
  const candidate = new Set(all.filter(notParallel(projectPath, parallelFiles)))
  const cards = Object.values(board).flat()
  const registry = readWorktrees(tasksDir)
  for (const [id, entry] of Object.entries(registry)) {
    if (id === card.id.toUpperCase()) {
      if (entry.state === 'integrated' && !entry.cleaned) return 'card is already integrated — cleanup pending'
      continue
    }
    if (entry.state === 'integrated') continue
    const live = cardIn(cards, id) // removed or ambiguous cards keep their saved locks
    // An archived card is closed: its preserved worktree must never block live cards.
    if (live?.column === 'archive') continue
    // A card that is not running holds no locks: its saved work stays on its branch and is
    // rebased at integration, and a real conflict goes back to a Builder once. Locked, one
    // waiting card starved every card behind it (Injectbuddy I164/I169 in Owner overnight;
    // I184 in Queue held 34 cards).
    if (['pou', 'owner', 'planning', 'planned', 'queue'].includes(live?.column)) continue
    // Preserve locks on existing changes even if a correction narrows the card.
    const files =[...new Set([...(entry.files || []), ...(live ? filesFor(live, entry.integrationWorkspace) : [])])]
    if (JSON.stringify(files) !== JSON.stringify(entry.files)) updateEntry(tasksDir, id, { files })
    const overlap = files.find((file) => [...candidate].some(c => filesOverlap(c, norm(file))))
    if (overlap) return `files busy, held by ${id} — ${slash(relative(resolve(projectPath), overlap))}`
  }
  return null
}

// Read-only visualization of persisted exact-file locks, never prose guesses.
export function recordedOverlapBlockers(card, projectPath, registry, parallelFiles) {
  const candidate = new Set(filesFor(card, resolve(projectPath, card.workspace || '.')).filter(notParallel(projectPath, parallelFiles)))
  return Object.entries(registry).filter(([id, entry]) => id !== card.id && entry.state !== 'integrated'
    && (entry.files || []).some(file => [...candidate].some(c => filesOverlap(c, norm(file))))).map(([id]) => id)
}

function commitsAfter(entry) {
  // Commits already on integration are not the card's, even when the card branch
  // was brought up to date by hand and the recorded base is older (Tradeflow T-31).
  const integrationHead = git(entry.repoRoot, ['rev-parse', 'HEAD']).stdout.trim()
  const result = git(entry.worktreePath, ['rev-list', '--reverse', 'HEAD', `^${entry.baseCommit}`, `^${integrationHead}`])
  return result.stdout.trim().split(/\r?\n/).filter(Boolean)
}

function expectedRepoFiles(card, entry) {
  return workspaceFiles(card, entry.integrationWorkspace || entry.workspacePath).map((file) => slash(join(entry.workspaceRel || '', file))).sort()
}

function commitFiles(entry, commit) {
  return git(entry.worktreePath, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]).stdout
    .split('\0').filter(Boolean).map(slash).sort()
}

function removeCleanWorktree(tasksDir, entry, { integrated = false } = {}) {
  if (norm(process.cwd()) === norm(entry.worktreePath) || safeInside(entry.worktreePath, process.cwd())) throw new Error('Cleanup deferred: caller is inside the target worktree; retry from the board directory')
  if (integrated && entry.commit && entry.branch) {
    const recovery = `recovery/${entry.branch}`
    const existing = git(entry.repoRoot, ['rev-parse', '--verify', `refs/heads/${recovery}`], { allowFailure: true })
    if (existing.status !== 0) git(entry.repoRoot, ['branch', recovery, entry.commit])
    else if (existing.stdout.trim() !== entry.commit) throw new Error('Recovery branch differs; preserve checkout and original refs')
  }
  const finish = () => updateEntry(tasksDir, entry.cardId, integrated ? { state: 'integrated', cleaned: true } : null)
  if (!existsSync(entry.worktreePath)) {
    finish()
    return
  }
  const status = git(entry.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], { allowFailure: true })
  if (status.status !== 0) {
    const listed = git(entry.repoRoot, ['worktree', 'list', '--porcelain']).stdout
      .split(/\r?\n/).some((line) => line === `worktree ${entry.worktreePath}`)
    if (listed) throw new Error(`git status failed in ${entry.worktreePath}: ${(status.stderr || status.stdout).trim()}`)
    // Git already removed its metadata but Windows left a directory behind.
    // Never recursively remove unknown residual contents. An empty directory
    // left by Windows is recoverable after the finished session releases it.
    // A tree of empty folders holds nothing (Tradeflow T-35 after a forced remove;
    // Injectbuddy I238 before integration).
    if (!onlyEmptyDirs(entry.worktreePath)) throw new Error('Residual worktree files require inspection; preserved')
    removeEmptyResidue(entry.worktreePath)
    finishRegisteredRemoval(entry, integrated)
    finish()
    return
  }
  const leftovers = operationInProgress(entry.worktreePath) ? null : semanticDirtyFiles(entry.worktreePath)
  if (!leftovers || (leftovers.length && !integrated)) throw new Error(`refusing to remove dirty worktree: ${entry.worktreePath}`)
  if (!integrated && git(entry.worktreePath, ['rev-parse', 'HEAD']).stdout.trim() !== entry.baseCommit) {
    throw new Error(`refusing to remove unintegrated commit in ${entry.worktreePath}`)
  }
  // Integrated: the card commit is safe, so copy leftovers (evidence, build-regenerated
  // files) to TASKS/.leftovers/<card>/ and remove the checkout, which otherwise piles
  // up with its dependencies until the disk fills (Tradeflow T-34, T-35).
  for (const file of leftovers) {
    const source = join(entry.worktreePath, file)
    if (!existsSync(source) || !lstatSync(source).isFile()) continue
    const target = join(tasksDir, '.leftovers', entry.cardId, file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  }
  const dependencies = join(entry.workspacePath, 'node_modules')
  // Remove only our junction, never its shared target, before Git removes the checkout.
  if (existsSync(dependencies) && lstatSync(dependencies).isSymbolicLink()) unlinkSync(dependencies)
  if (leftovers.length) removeRegistered(entry, ['worktree', 'remove', '--force', entry.worktreePath])
  else {
    refreshClean(entry.worktreePath)
    removeRegistered(entry, ['worktree', 'remove', entry.worktreePath])
  }
  git(entry.repoRoot, ['branch', '-D', entry.branch])
  finish()
}

const onlyEmptyDirs = (dir) => readdirSync(dir, { withFileTypes: true }).every(d => d.isDirectory() && !d.isSymbolicLink() && onlyEmptyDirs(join(dir, d.name)))
// An agent shell that just closed can hold an empty folder open for a moment. Still held:
// leave it. It holds nothing, and every new card worktree gets a fresh path.
function removeEmptyResidue(dir) {
  try { rmSync(dir, { recursive: true, maxRetries: 5, retryDelay: 200 }) } catch { /* empty; released later */ }
}
// The branch goes only when it holds nothing beyond its base, or the card is integrated.
function finishRegisteredRemoval(entry, integrated) {
  const tip = git(entry.repoRoot, ['rev-parse', '--verify', `refs/heads/${entry.branch}`], { allowFailure: true }).stdout.trim()
  if (integrated || !tip || tip === entry.baseCommit) git(entry.repoRoot, ['branch', '-D', entry.branch], { allowFailure: true })
}
// Windows: `git worktree remove` deletes the files and the registration, then fails on the
// folder a handle still holds ("failed to delete ... Permission denied"). Injectbuddy I238
// went to Owner over that empty folder. It is a finished removal.
function removeRegistered(entry, args) {
  try { git(entry.repoRoot, args) } catch (err) {
    if (!/failed to delete/i.test(err.message) || !isResidue(entry, { anyBranch: true })) throw err
    if (existsSync(entry.worktreePath)) removeEmptyResidue(entry.worktreePath)
  }
}
// Not a registered worktree any more and nothing but empty folders (or nothing) on disk.
// Unless anyBranch, its branch must also hold nothing beyond the base.
function isResidue(entry, { anyBranch = false } = {}) {
  const registered = git(entry.repoRoot, ['worktree', 'list', '--porcelain']).stdout
    .split(/\r?\n/).some((line) => line.startsWith('worktree ') && norm(line.slice(9)) === norm(entry.worktreePath))
  if (registered || (existsSync(entry.worktreePath) && !onlyEmptyDirs(entry.worktreePath))) return false
  if (anyBranch) return true
  const tip = git(entry.repoRoot, ['rev-parse', '--verify', `refs/heads/${entry.branch}`], { allowFailure: true }).stdout.trim()
  return !tip || tip === entry.baseCommit
}

export function cleanupPreparedWorktree({ tasksDir, prepared }) {
  if (!prepared?.git || !prepared.created || !prepared.entry) return false
  try {
    removeCleanWorktree(tasksDir, prepared.entry)
    return true
  } catch {
    return false // preservation beats cleanup
  }
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false
  try { process.kill(Number(pid), 0); return true } catch (err) { return err.code === 'EPERM' }
}

function acquireLock(tasksDir) {
  const path = lockPath(tasksDir)
  try {
    const fd = openSync(path, 'wx')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    closeSync(fd)
    return path
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    try {
      const bytes = readFileSync(path, 'utf8')
      const owner = JSON.parse(bytes)
      // Past 30 minutes, a live PID must still be the process that wrote the lock (PID reuse).
      const writtenAt = Date.parse(owner.at)
      if (processAlive(owner.pid) && !(Date.now() - writtenAt > 30 * 60000 && lockOwnerReplaced(owner.pid, writtenAt) && readFileSync(path, 'utf8') === bytes)) return null
      unlinkSync(path)
      return acquireLock(tasksDir)
    } catch {
      // A crash between exclusive creation and writing leaves an empty lock.
      if (existsSync(path) && Date.now() - statSync(path).mtimeMs > 60_000) {
        unlinkSync(path)
        return acquireLock(tasksDir)
      }
      return null
    }
  }
}

function validateCompleted(card, entry) {
  if (!existsSync(entry.worktreePath)) throw new Error(`card worktree is missing: ${entry.worktreePath}`)
  // Only the card commit is integrated, so uncommitted files outside the card's own
  // files never reach it and must not hold it: a Builder's evidence log (Injectbuddy
  // T-148) or build-regenerated tracked files like sitemaps (Tradeflow T-35).
  const expected = expectedRepoFiles(card, entry)
  const listed = (file) => expected.some(e => filesOverlap(e, file)) // a generated-files glob covers its matches
  if (operationInProgress(entry.worktreePath) || semanticDirtyFiles(entry.worktreePath).some(f => listed(slash(f)))) throw new Error('card worktree still has uncommitted changes')
  const commits = commitsAfter(entry)
  if (commits.length !== 1) throw new Error(`expected exactly one card commit; found ${commits.length}`)
  const actual = commitFiles(entry, commits[0])
  const outside = actual.filter((file) => !listed(file))
  if (!actual.length || outside.length) {
    throw new Error(`commit must change only card-listed files: allowed [${expected.join(', ')}], got [${actual.join(', ')}]`)
  }
  return commits[0]
}

// The integration gate, run at the Builder's `hkb done` so the Builder fixes its own
// commit while it is still there, instead of integration refusing it on every poll
// (Tradeflow TF51 committed an out-of-scope llms.txt). Null when there is no worktree.
export function handoffCommitError(tasksDir, card) {
  const entry = worktreeForCard(tasksDir, card.id)
  if (!entry?.worktreePath || !existsSync(entry.worktreePath)) return null
  try { validateCompleted(card, entry); return null } catch (err) { return err.message }
}

// Rebase the card's one commit onto the integration HEAD inside its own worktree
// (never the integration checkout). The pre-rebase commit keeps a recovery ref.
function rebaseCardOnto(entry, head) {
  git(entry.repoRoot, ['branch', `recovery/${entry.branch}-${Date.now().toString(36)}`, entry.commit], { allowFailure: true })
  const rebase = git(entry.worktreePath, ['rebase', '--onto', head, entry.baseCommit], { allowFailure: true })
  if (rebase.status === 0) return { clean: true, commit: git(entry.worktreePath, ['rev-parse', 'HEAD']).stdout.trim() }
  const files = git(entry.worktreePath, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true }).stdout.split(/\r?\n/).filter(Boolean)
  const hunks = (git(entry.worktreePath, ['diff'], { allowFailure: true }).stdout || rebase.stderr || '').slice(0, 6000)
  git(entry.worktreePath, ['rebase', '--abort'], { allowFailure: true })
  return { clean: false, files, hunks }
}

export const updateWorktree = updateEntry

// Bring a Completed card's one commit up to the integration HEAD in its own
// worktree, so a project integrationCheck tests exactly what would land.
// Null when reconcile should judge the card itself (not Completed, invalid commit).
export function rebaseCompletedOntoIntegration(tasksDir, cardId) {
  let entry = readWorktrees(tasksDir)[cardId]
  const card = readBoard(tasksDir).completed.find((c) => c.id === cardId)
  if (!entry || !card || !['building', 'ready', 'issue', 'rebased'].includes(entry.state)) return null
  if (entry.rebaseTarget && git(entry.worktreePath, ['merge-base', '--is-ancestor', entry.rebaseTarget, 'HEAD'], { allowFailure: true }).status === 0) {
    entry = updateEntry(tasksDir, cardId, { baseCommit: entry.rebaseTarget, rebaseTarget: null })
  }
  let commit
  try { commit = validateCompleted(card, entry) } catch { return null }
  const head = git(entry.repoRoot, ['rev-parse', 'HEAD']).stdout.trim()
  if (entry.baseCommit === head) return { status: 'current', commit }
  const rebase = rebaseCardOnto({ ...entry, commit }, head)
  if (!rebase.clean) return { status: 'conflict', reason: `integration conflict while rebasing onto master ${head.slice(0, 12)}`, files: rebase.files, hunks: rebase.hunks, head }
  updateEntry(tasksDir, cardId, { baseCommit: head, commit: rebase.commit })
  return { status: 'current', commit: rebase.commit }
}

// Completed card commits are integrated one at a time. Results are intentionally
// data-only: the server owns board routing and logging.
export function reconcileCompletedWorktrees({ tasksDir, onlyIds }) {
  if (busy.has(tasksDir)) return []
  const lock = acquireLock(tasksDir)
  if (!lock) return []
  busy.add(tasksDir)
  const results = []
  try {
    const completed = new Map(readBoard(tasksDir).completed.map((card) => [card.id, card]))
    for (let entry of Object.values(readWorktrees(tasksDir))) {
      if (onlyIds && !onlyIds.includes(entry.cardId)) continue
      if (entry.state === 'integrated') {
        if (entry.cleaned) continue
        try {
          removeCleanWorktree(tasksDir, entry, { integrated: true })
          results.push({ id: entry.cardId, status: 'cleaned', commit: entry.commit })
        } catch (err) {
          results.push({ id: entry.cardId, status: 'cleanup-held', commit: entry.commit, reason: err.message })
        }
        continue
      }
      const card = completed.get(entry.cardId)
      if (!card || !['building', 'ready', 'issue', 'integrating'].includes(entry.state)) continue
      try {
        // A Builder that resolved a conflict rebased its one commit onto rebaseTarget.
        if (entry.rebaseTarget && git(entry.worktreePath, ['merge-base', '--is-ancestor', entry.rebaseTarget, 'HEAD'], { allowFailure: true }).status === 0) {
          entry = updateEntry(tasksDir, entry.cardId, { baseCommit: entry.rebaseTarget, rebaseTarget: null })
        }
        const commit = validateCompleted(card, entry)
        // Persist intent before Git. Its -x trailer makes a post-pick crash replayable.
        const alreadyPicked = entry.state === 'integrating' && git(entry.repoRoot, ['log', '--format=%B', `${entry.integrationBase}..HEAD`]).stdout.includes(`(cherry picked from commit ${commit})`)
        if (alreadyPicked) {
          updateEntry(tasksDir, entry.cardId, { state: 'integrated', commit, integratedAt: new Date().toISOString(), reason: null })
          results.push({ id: entry.cardId, status: 'integrated', commit, cleanupPending: true })
          continue
        }
        // An interrupted operation may now contain human conflict resolutions.
        // Preserve it; never abort a pre-existing cherry-pick automatically.
        updateEntry(tasksDir, entry.cardId, { state: 'ready', commit })
        ignoreToolOutput(entry.repoRoot)
        if (!clean(entry.repoRoot)) {
          results.push({ id: entry.cardId, status: 'held', reason: `integration worktree is dirty: ${entry.repoRoot}` })
          break
        }
        let normalization
        try { normalization = refreshClean(entry.repoRoot, { normalize: true }) } catch (err) {
          results.push({ id: entry.cardId, status: 'held', reason: `integration metadata refresh blocked; content-normalized EOL/stat differences need explicit safe reconciliation, not Builder rework; files preserved: ${err.message}` })
          break
        }
        updateEntry(tasksDir, entry.cardId, { state: 'integrating', commit, integrationBase: git(entry.repoRoot, ['rev-parse', 'HEAD']).stdout.trim(), ...(normalization?.files.length ? { eolNormalization: normalization } : {}) })
        const pick = git(entry.repoRoot, ['cherry-pick', '-x', commit], { allowFailure: true })
        if (pick.status !== 0) {
          git(entry.repoRoot, ['cherry-pick', '--abort'], { allowFailure: true })
          const reason = `integration conflict: ${(pick.stderr || pick.stdout).trim()}`
          // Never retry the pick in a loop: rebase once in the card's own worktree.
          // 'rebased' and 'conflict' are not retried here; completed-handoff runs
          // the check or returns the card to a Builder.
          const head = git(entry.repoRoot, ['rev-parse', 'HEAD']).stdout.trim()
          const rebase = rebaseCardOnto({ ...entry, commit }, head)
          if (rebase.clean) {
            updateEntry(tasksDir, entry.cardId, { state: 'rebased', baseCommit: head, commit: rebase.commit, reason: `rebased onto integration HEAD ${head.slice(0, 12)}; the recorded check must pass before integration` })
            results.push({ id: entry.cardId, status: 'rebased', commit: rebase.commit })
          } else {
            updateEntry(tasksDir, entry.cardId, { state: 'conflict', commit, reason, rebaseTarget: head })
            results.push({ id: entry.cardId, status: 'conflict', reason, files: rebase.files, hunks: rebase.hunks, head })
          }
          continue
        }
        updateEntry(tasksDir, entry.cardId, { state: 'integrated', commit, integratedAt: new Date().toISOString(), reason: null })
        try {
          removeCleanWorktree(tasksDir, { ...entry, commit }, { integrated: true })
          results.push({ id: entry.cardId, status: 'integrated', commit })
        } catch (err) {
          results.push({ id: entry.cardId, status: 'integrated', commit, cleanupPending: true, reason: err.message })
        }
      } catch (err) {
        if (readWorktrees(tasksDir)[entry.cardId]?.state === 'integrating') {
          results.push({ id: entry.cardId, status: 'held', reason: `integration recovery pending: ${err.message}` })
          break
        }
        updateEntry(tasksDir, entry.cardId, { state: 'issue', reason: err.message })
        results.push({ id: entry.cardId, status: 'issue', reason: err.message })
      }
    }
  } finally {
    busy.delete(tasksDir)
    try { unlinkSync(lock) } catch {}
  }
  return results
}

export function recoverAbandonedWorktree({ tasksDir, cardId }) {
  const id = String(cardId).toUpperCase()
  const entry = readWorktrees(tasksDir)[id]
  if (!entry) return { id, status: 'requeue', reason: 'agent disappeared before creating a card worktree' }
  try {
    if (!existsSync(entry.worktreePath)) throw new Error(`card worktree is missing: ${entry.worktreePath}`)
    const unchanged = clean(entry.worktreePath) && git(entry.worktreePath, ['rev-parse', 'HEAD']).stdout.trim() === entry.baseCommit
    if (unchanged) {
      removeCleanWorktree(tasksDir, entry)
      return { id, status: 'requeue', reason: 'agent disappeared without changing files' }
    }
    const reason = clean(entry.worktreePath)
      ? 'agent disappeared with an unintegrated commit'
      : 'agent disappeared with uncommitted changes'
    updateEntry(tasksDir, id, { state: 'issue', reason })
    return { id, status: 'issue', reason, worktreePath: entry.worktreePath }
  } catch (err) {
    updateEntry(tasksDir, id, { state: 'issue', reason: err.message })
    return { id, status: 'issue', reason: err.message, worktreePath: entry.worktreePath }
  }
}

export function worktreeForCard(tasksDir, cardId) {
  return readWorktrees(tasksDir)[String(cardId).toUpperCase()] ?? null
}

export function isIntegrated(tasksDir, cardId) {
  return worktreeForCard(tasksDir, cardId)?.state === 'integrated'
}

// Explicit verification receipt for work already satisfied at the current base.
// An absent commit alone is never evidence that a card succeeded.
export function completeUnchangedWorktree({ tasksDir, cardId, evidence }) {
  if (typeof evidence !== 'string' || !evidence.trim()) throw new Error('no-op completion requires check evidence')
  const lock = acquireLock(tasksDir)
  if (!lock) throw new Error('integration busy; retry no-op completion')
  try {
    const entry = worktreeForCard(tasksDir, cardId)
    if (!entry) throw new Error(`no worktree for ${cardId}`)
    const card = findCard(tasksDir, cardId)
    const environmentSignature = entry.envFile ? (existsSync(entry.envFile) ? `${statSync(entry.envFile).size}:${statSync(entry.envFile).mtimeMs}` : 'missing') : null
    if (entry.state === 'integrated' && entry.noOp && entry.environmentSignature === environmentSignature && entry.inputFingerprint === evidenceFingerprint(card, entry.integrationWorkspace)) return { id: cardId, status: 'integrated', noOp: true, commit: entry.commit, cleanupPending: !entry.cleaned }
    const files = expectedRepoFiles(card, entry)
    if (!files.length || !clean(entry.worktreePath) || commitsAfter(entry).length) throw new Error('no-op completion requires an unchanged clean worktree')
    if (!clean(entry.repoRoot)) throw new Error('no-op completion requires a clean integration worktree')
    const integrationHead = git(entry.repoRoot, ['rev-parse', 'HEAD']).stdout.trim()
    const diff = git(entry.worktreePath, ['diff', '--quiet', entry.baseCommit, integrationHead, '--', ...files], { allowFailure: true })
    if (diff.status !== 0) throw new Error('no-op card files differ from integration; check the latest files first')
    const done = updateEntry(tasksDir, cardId, { state: 'integrated', noOp: true, environmentSignature, inputFingerprint: evidenceFingerprint(card, entry.integrationWorkspace), commit: integrationHead, evidence: evidence.trim(), integratedAt: new Date().toISOString(), reason: null })
    try { removeCleanWorktree(tasksDir, done, { integrated: true }) }
    catch (err) { return { id: cardId, status: 'integrated', noOp: true, commit: integrationHead, cleanupPending: true, reason: err.message } }
    return { id: cardId, status: 'integrated', noOp: true, commit: integrationHead }
  } finally { try { unlinkSync(lock) } catch {} }
}
