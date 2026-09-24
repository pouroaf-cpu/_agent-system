// Isolated Git worktrees for Builder cards. Runtime state lives beside the board,
// never in a card or a pushed branch.

import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, renameSync, fsyncSync, statSync, lstatSync, symlinkSync, readdirSync, rmdirSync, statfsSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { cardFiles, findCard, readBoard } from './cards.mjs'
import { evidenceFingerprint } from './workflow-state.mjs'

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

const clean = (cwd) => !operationInProgress(cwd) && semanticDirtyFiles(cwd).length === 0

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
    return files.some(file => file === absolute || file.startsWith(`${absolute}/`) || absolute.startsWith(`${file}/`))
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
const installs = new Map() // folder -> { running, failures, error }

function runInstall(folder, command, logPath) {
  return new Promise((done, fail) => {
    const out = openSync(logPath, 'a')
    let finished = false
    const finish = (err) => { if (finished) return; finished = true; closeSync(out); err ? fail(err) : done() }
    const child = spawn(command, { cwd: folder, shell: true, windowsHide: true, stdio: ['ignore', out, out] })
    child.on('error', finish)
    child.on('close', code => finish(code === 0 ? null : new Error(`${command} exited with code ${code}; see ${logPath}`)))
  })
}

const installCommand = folder => existsSync(join(folder, 'pnpm-lock.yaml')) ? 'pnpm install --frozen-lockfile'
  : existsSync(join(folder, 'yarn.lock')) ? 'yarn install --frozen-lockfile'
  : existsSync(join(folder, 'package-lock.json')) ? 'npm ci --no-audit --no-fund' : null

// One background install per folder, behind the 5 GB disk guard. Returns the hold
// reason ("installing dependencies in ..." is an allowed wait), or null when no
// lockfile says how to install. Two failures hold for Owner with the reason.
export function startDependencyInstall({ folder, tasksDir, install = runInstall, free = freeGb, minFreeGb = 5 }) {
  const key = norm(folder), state = installs.get(key) || { failures: 0 }
  const waiting = `installing dependencies in ${folder}${state.error ? ` (retry after: ${state.error})` : ''}`
  if (state.running) return waiting
  if (state.failures >= 2) return `dependency install failed twice in ${folder}: ${state.error}`
  const command = installCommand(folder)
  if (!command) return null
  const gb = free(folder)
  if (gb < minFreeGb) return `Drive ${parse(folder).root.replace(/[\\/]$/, '')} has only ${gb.toFixed(1)} GB free; free up space so dependencies can install`
  // Detach a shared node_modules junction first: unlink the link only, never delete through it.
  const modules = join(folder, 'node_modules')
  try { if (lstatSync(modules).isSymbolicLink()) unlinkSync(modules) } catch (err) { if (err.code !== 'ENOENT') throw err }
  mkdirSync(join(tasksDir, '.evidence'), { recursive: true })
  const logPath = join(tasksDir, '.evidence', `dependency-install-${Date.now()}.log`)
  installs.set(key, { ...state, running: true })
  Promise.resolve().then(() => install(folder, command, logPath)).then(
    () => installs.delete(key),
    err => installs.set(key, { failures: state.failures + 1, error: String(err?.message || err).replace(/\s+/g, ' ').slice(0, 300) }))
  return waiting
}

// Before a Builder starts: when the integration folder has a lockfile but no
// node_modules, install there once in the background instead of sending the card
// to Owner. A card workspace install (started when the spawn found drift) holds
// the card while it runs. Returns a hold reason, or null when the card may start.
export function dependencyInstallHold({ card, projectPath, tasksDir, gitSettings, install = runInstall, free = freeGb, minFreeGb = 5 }) {
  try {
    const entry = readWorktrees(tasksDir)[card.id.toUpperCase()]
    const own = entry?.workspacePath && installs.get(norm(entry.workspacePath))
    if (own?.running || own?.failures >= 2) return startDependencyInstall({ folder: entry.workspacePath, tasksDir })
    const folder = resolve(gitSettings?.integrationPath || projectPath, card.workspace || '.')
    if (!existsSync(join(folder, 'package.json'))) return null
    const state = installs.get(norm(folder)) || { failures: 0 }
    if (state.running || state.failures >= 2) return startDependencyInstall({ folder, tasksDir })
    if (entry?.workspacePath && existsSync(join(entry.workspacePath, 'node_modules'))) return null
    if (!state.failures && existsSync(join(folder, 'node_modules'))) return null
    if (!gitRoot(folder)) return null // non-Git projects keep their own workspace
    if (!state.failures && existsSync(join(dirname(git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()), 'node_modules'))) return null
    const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
    if (!Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length) return null
    return startDependencyInstall({ folder, tasksDir, install, free, minFreeGb })
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
  const hold = integrationStartHoldReason({ repoRoot, workspace: integrationWorkspace, card })
  if (hold) throw new Error(hold)

  const id = card.id.toUpperCase()
  let existing = readWorktrees(tasksDir)[id]
  if (existing?.state === 'integrated' && existing.cleaned) {
    updateEntry(tasksDir, id, null) // An explicitly requeued card starts a fresh correction.
    existing = null
  }
  if (existing) {
    if (existing.state === 'integrated') throw new Error(`${id} is already integrated; cleanup is pending`)
    if (!existsSync(existing.worktreePath)) throw new Error(`${id} worktree registry points to missing path: ${existing.worktreePath}`)
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
    createdAt: new Date().toISOString(),
  }
  updateEntry(tasksDir, id, entry)
  prepareDependencies(workspacePath, integrationWorkspace)
  return { git: true, workspacePath, cwd: workspacePath, entry, created: true }
}

export function overlapHoldReason({ tasksDir, card, projectPath }) {
  const candidate = new Set(filesFor(card, resolve(projectPath, card.workspace || '.')))
  if (!candidate.size) return 'card not ready — no exact files listed'
  for (const [id, entry] of Object.entries(readWorktrees(tasksDir))) {
    if (id === card.id.toUpperCase()) {
      if (entry.state === 'integrated' && !entry.cleaned) return 'card is already integrated — cleanup pending'
      continue
    }
    if (entry.state === 'integrated') continue
    let live
    try { live = findCard(tasksDir, id) } catch { /* Preserve saved locks for removed or ambiguous cards. */ }
    // An archived card is closed: its preserved worktree must never block live cards.
    if (live?.column === 'archive') continue
    // Preserve locks on existing changes even if a correction narrows the card.
    const files = [...new Set([...(entry.files || []), ...(live ? filesFor(live, entry.integrationWorkspace) : [])])]
    if (JSON.stringify(files) !== JSON.stringify(entry.files)) updateEntry(tasksDir, id, { files })
    const overlap = files.find((file) => candidate.has(norm(file)))
    if (overlap) return `files busy, held by ${id} — ${slash(relative(resolve(projectPath), overlap))}`
  }
  return null
}

// Read-only visualization of persisted exact-file locks, never prose guesses.
export function recordedOverlapBlockers(card, projectPath, registry) {
  const candidate = new Set(filesFor(card, resolve(projectPath, card.workspace || '.')))
  return Object.entries(registry).filter(([id, entry]) => id !== card.id && entry.state !== 'integrated'
    && (entry.files || []).some(file => candidate.has(norm(file)))).map(([id]) => id)
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
    if (!integrated || listed) throw new Error(`git status failed in ${entry.worktreePath}: ${(status.stderr || status.stdout).trim()}`)
    // Git already removed its metadata but Windows left a directory behind.
    // Never recursively remove unknown residual contents. An empty directory
    // left by Windows is recoverable after the finished session releases it.
    if (readdirSync(entry.worktreePath).length) throw new Error('Residual worktree files require inspection; preserved')
    rmdirSync(entry.worktreePath)
    git(entry.repoRoot, ['branch', '-D', entry.branch], { allowFailure: true })
    finish()
    return
  }
  if (!clean(entry.worktreePath)) throw new Error(`refusing to remove dirty worktree: ${entry.worktreePath}`)
  if (!integrated && git(entry.worktreePath, ['rev-parse', 'HEAD']).stdout.trim() !== entry.baseCommit) {
    throw new Error(`refusing to remove unintegrated commit in ${entry.worktreePath}`)
  }
  const dependencies = join(entry.workspacePath, 'node_modules')
  // Remove only our junction, never its shared target, before Git removes the checkout.
  if (existsSync(dependencies) && lstatSync(dependencies).isSymbolicLink()) unlinkSync(dependencies)
  refreshClean(entry.worktreePath)
  git(entry.repoRoot, ['worktree', 'remove', entry.worktreePath])
  git(entry.repoRoot, ['branch', '-D', entry.branch])
  finish()
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
      const owner = JSON.parse(readFileSync(path, 'utf8'))
      if (processAlive(owner.pid)) return null
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
  // Untracked files outside the card's own files (a Builder's evidence log) never
  // reach integration, so they must not hold it (Injectbuddy T-148).
  const untracked = new Set(git(entry.worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean))
  const cardOwn = new Set(expectedRepoFiles(card, entry))
  if (operationInProgress(entry.worktreePath) || semanticDirtyFiles(entry.worktreePath).some(f => !untracked.has(f) || cardOwn.has(slash(f)))) throw new Error('card worktree still has uncommitted changes')
  const commits = commitsAfter(entry)
  if (commits.length !== 1) throw new Error(`expected exactly one card commit; found ${commits.length}`)
  const actual = commitFiles(entry, commits[0])
  const expected = expectedRepoFiles(card, entry)
  const outside = actual.filter((file) => !expected.includes(file))
  if (!actual.length || outside.length) {
    throw new Error(`commit must change only card-listed files: allowed [${expected.join(', ')}], got [${actual.join(', ')}]`)
  }
  return commits[0]
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
