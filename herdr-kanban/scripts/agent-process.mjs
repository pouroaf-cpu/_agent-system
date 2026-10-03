// Detached supervisor records the real exit even after the board has stopped.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { renameSync } from '../lib/fs-retry.mjs'
import { PaneProcessTrees } from '../lib/process-tree.mjs'
const file = process.argv[2]
const spec = JSON.parse(readFileSync(file, 'utf8'))
unlinkSync(file)
const child = spawn(spec.exe, spec.args, { cwd: spec.cwd, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
const report = message => { if (process.connected) process.send(message, () => {}) }
const finished = value => { writeFileSync(spec.exitFile + '.tmp', JSON.stringify(value)); renameSync(spec.exitFile + '.tmp', spec.exitFile) }
// Agents leave dev servers, browsers and MCP servers running after they exit (efficiency audit
// 2026-10-03; 52 stale herdr tabs the same day). Track the agent's tree while it runs and kill
// whatever is left when it exits. ponytail: 30 s snapshots; a grandchild born and orphaned
// between snapshots is missed.
const trees = new PaneProcessTrees()
const watch = () => trees.observe([{ key: 'agent', shellPid: child.pid }]).catch(() => {})
let timer
const cleanup = async () => { clearInterval(timer); await watch(); await trees.close('agent').catch(() => {}) }
child.once('spawn', () => { report({ pid: child.pid }); watch(); timer = setInterval(watch, 30000) })
child.once('error', err => { console.error(err.message); clearInterval(timer); finished({ exitCode: 1, error: err.message }); report({ error: err.message }); process.exitCode = 1 })
child.once('exit', async (code, signal) => { await cleanup(); finished({ exitCode: code ?? 1, signal, childPid: child.pid }); process.exitCode = code ?? 1 })
