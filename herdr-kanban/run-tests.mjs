// node run-tests.mjs [files...]
// node run-tests.mjs --changed <base>   (only the files a branch touches; see changedFiles)
// Runs test.mjs, planner-prompt-check.mjs and every *.test.mjs here, one process per file on half the cores, each killed
// after 120s. Slow files get longer and start first (see SLOW). worktrees.test.mjs is git processes and no waits
// (86s alone, 98s in the suite, 190-290s beside a second suite) and release.test.mjs builds three origin/clone
// repos plus a server (16s alone, 35s beside a second suite): both only get slower as the machine gets busier.
// Needs the local TASK-TEMPLATE.md (git-ignored). Runs against a temp KANBAN_CONFIG, never the live board.config.json.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFile, spawnSync } from 'node:child_process'
import { availableParallelism, tmpdir } from 'node:os'
import { join, relative, dirname, posix } from 'node:path'

const dir = import.meta.dirname
const allFiles = () => readdirSync(dir).filter(f => f === 'test.mjs' || f === 'planner-prompt-check.mjs' || f.endsWith('.test.mjs')).sort()
const argv = process.argv.slice(2)
// --changed: the always-run list, the slow files that run only when their own source or test changed,
// and how a test names a module (import path, or the path a child process or fixture uses).
const ALWAYS = ['syntax.test.mjs']
const SLOW_ONLY_WHEN_TOUCHED = { 'worktrees.test.mjs': ['lib/worktrees.mjs'], 'agent-process.test.mjs': ['lib/agent-process.mjs'] }
const mentions = (text, mod) => text.includes(mod) || new RegExp(`(^|[^\\w.-])${posix.basename(mod).replaceAll('.', '\\.')}(?![\\w-])`).test(text)
// The entry points import nearly every lib module and 46 tests spawn server.mjs or hkb.mjs, so
// reaching them transitively would select the whole suite for any lib change (100 files, 2m15
// for lib/transient.mjs). They count only when changed themselves; a lib change picks the tests
// that import or name that module or a lib module built on it.
const ENTRY = new Set(['server.mjs', 'hkb.mjs', 'hkb-cli.mjs'])
const changedAt = argv.indexOf('--changed')
const files = changedAt >= 0 ? changedTests(argv[changedAt + 1] || 'master') : argv.length ? argv : allFiles()
if (!files.length) { console.log('0 files, 0 tests, 0 failing files (nothing to run)'); process.exit(0) }
// Tests never read the live board.config.json: its night/off switch (maxConcurrentAgents 0) or a
// project pause made every project count as paused. An empty config pauses nothing and, like no
// config in KANBAN_TEST, selects the herdr backend.
const configDir = process.env.KANBAN_CONFIG ? null : mkdtempSync(join(tmpdir(), 'kanban-tests-'))
if (configDir) { process.env.KANBAN_CONFIG = join(configDir, 'board.config.json'); writeFileSync(process.env.KANBAN_CONFIG, '{}') }
const args = ['--test', '--test-isolation=none', '--experimental-test-module-mocks']
// A file's time roughly triples beside a second suite or live agents (every file spawns node, git or
// PowerShell), so each limit is about 3x its time alone. The kill limit also caps any one test.
const SLOW = {
  'worktrees.test.mjs': 900000, // 50 serial git tests: 80-190s alone, 480s+ with three suites on the machine
  'release.test.mjs': 300000, // four release runs over three repos: 61s in a pair, past 120s on a busy board
  'headless-builder.test.mjs': 150000, // one 45-110s test
  'watchdog-herdr.test.mjs': 240000, // one 50-90s test
  'watchdog.test.mjs': 300000, // ten PowerShell 5.1 watchdog runs: 100s alone, 221s with agents on the machine
  'test.mjs': 240000, // ~35s alone, 100s+ with three suites
  'syntax.test.mjs': 240000, // one serial node --check per .mjs file: 20s alone, 75s+ under load
  'agent-process.test.mjs': 180000, // PowerShell process listings: 25s alone, 37s+ in a pair
  'headless-planner.test.mjs': 120000,
}
const limit = file => SLOW[file] ?? 120000 // 60s was hit by npm-shim and completed-handoff beside three suites
const run = file => { const start = Date.now(); return new Promise(done => execFile(process.execPath, [...args, `--test-timeout=${limit(file)}`, file], { cwd: dir, timeout: limit(file), maxBuffer: 64 << 20, env: { ...process.env, KANBAN_TEST: '1' }, windowsHide: true },
  (err, stdout, stderr) => done({ file, err, out: `${stdout}${stderr}`, secs: Math.round((Date.now() - start) / 1000) }))) }

// Longest first: worktrees.test.mjs started last and alone set the wall time. Half the cores: every
// file spawns git, servers or browsers, and 11 at once only slowed the git-bound files.
const queue = [...files].sort((a, b) => limit(b) - limit(a)), results = []
await Promise.all(Array.from({ length: Math.max(2, availableParallelism() / 2 | 0) }, async () => {
  while (queue.length) results.push(await run(queue.shift()))
}))

const failed = []
let tests = 0
for (const { file, err, out, secs } of results.sort((a, b) => a.file.localeCompare(b.file))) {
  const count = Number(out.match(/^ℹ tests (\d+)/m)?.[1] ?? 0)
  tests += count
  if (!err) { console.log(`ok    ${file} (${count}) ${secs}s`); continue }
  failed.push(file)
  console.log(`FAIL  ${file}${err.killed ? ` (timed out after ${limit(file) / 1000}s)` : ` (exit ${err.code ?? err.signal}${out.trim() ? '' : `, no output: ${err.message.split('\n')[0]}`})`}\n${out}`)
}
if (configDir) rmSync(configDir, { recursive: true, force: true })
console.log(`\n${files.length} files, ${tests} tests, ${failed.length} failing files${failed.length ? `: ${failed.join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)

// --changed <base> (audit 2026-10-15 F1): the integration check ran all 127 files (10-15 min a card)
// for a one-file change. Run only the test files the branch can affect: changed test files, the tests
// that import or name a changed source or anything that imports it (transitively), the always-run
// list below, and nothing when the branch touches no file here. The slow git and process files
// (worktrees, agent-process) run only when their own source or test changed. A diff that cannot be
// taken (no git, unknown base) falls back to the full suite, named on stdout.
function changedTests(base) {
  const changed = changedFiles(base)
  if (!changed) { console.log(`--changed ${base}: diff unavailable, running the full suite`); return allFiles() }
  const all = allFiles()
  if (!changed.length) { console.log(`--changed ${base}: no file under ${relative(dirname(dir), dir) || '.'} changed`); return [] }
  console.log(`--changed ${base}: ${changed.join(', ')}`)
  const affected = affectedModules(changed)
  const picked = new Set(ALWAYS.filter(f => all.includes(f)))
  for (const file of all) {
    if (changed.includes(file)) { picked.add(file); continue }
    const text = readFileSync(join(dir, file), 'utf8')
    if ([...affected].some(m => mentions(text, m))) picked.add(file)
  }
  for (const [slow, sources] of Object.entries(SLOW_ONLY_WHEN_TOUCHED)) {
    if (!changed.includes(slow) && !sources.some(s => changed.includes(s))) picked.delete(slow)
  }
  const list = [...picked].sort()
  console.log(`running ${list.length} of ${all.length} files: ${list.join(', ')}`)
  return list
}
// Repo-relative diff paths (committed since the merge base with `base`, plus working tree and untracked)
// mapped onto this folder; null when git cannot answer.
function changedFiles(base) {
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true })
  const top = git(['rev-parse', '--show-toplevel'])
  if (top.status !== 0) return null
  const root = top.stdout.trim()
  const mb = git(['merge-base', base, 'HEAD'])
  if (mb.status !== 0) return null
  const diff = git(['diff', '--name-only', mb.stdout.trim()])
  if (diff.status !== 0) return null
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
  const prefix = posix.normalize(relative(root, dir).replaceAll('\\', '/')).replace(/^\.$/, '')
  const here = p => (!prefix || p.startsWith(`${prefix}/`)) ? (prefix ? p.slice(prefix.length + 1) : p) : null
  const paths = `${diff.stdout}${untracked.status === 0 ? untracked.stdout : ''}`.split('\n').map(s => s.trim()).filter(Boolean)
  return [...new Set(paths.map(p => here(p.replaceAll('\\', '/'))).filter(Boolean))].sort()
}
// Everything that imports a changed module, transitively, by the relative-import graph of the
// .mjs files here (lib, scripts, hooks and the entry points). Returns repo-folder-relative paths.
function affectedModules(changed) {
  const modules = new Map() // 'lib/x.mjs' -> Set of imported 'lib/y.mjs'
  const walk = (sub) => { for (const e of readdirSync(join(dir, sub || '.'), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name
    if (e.isDirectory()) { if (!['node_modules', '.git', 'TASKS', 'public'].includes(e.name) && !e.name.startsWith('.')) walk(rel) }
    else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) modules.set(rel, imports(rel))
  } }
  walk('')
  const affected = new Set(changed)
  for (let grew = true; grew;) {
    grew = false
    for (const [mod, deps] of modules) if (!affected.has(mod) && !ENTRY.has(mod) && [...deps].some(d => affected.has(d))) { affected.add(mod); grew = true }
  }
  return affected
}
function imports(rel) {
  const text = readFileSync(join(dir, rel), 'utf8'), out = new Set()
  for (const m of text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+\.mjs)['"]|import\(['"](\.{1,2}\/[^'"]+\.mjs)['"]\)/g)) {
    out.add(posix.normalize(posix.join(posix.dirname(rel), (m[1] || m[2]).replaceAll('\\', '/'))))
  }
  return out
}
