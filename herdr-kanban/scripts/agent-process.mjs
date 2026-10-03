// Detached supervisor records the real exit even after the board has stopped.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { renameSync } from '../lib/fs-retry.mjs'
const file = process.argv[2]
const spec = JSON.parse(readFileSync(file, 'utf8'))
unlinkSync(file)
const child = spawn(spec.exe, spec.args, { cwd: spec.cwd, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
const report = message => { if (process.connected) process.send(message, () => {}) }
const finished = value => { writeFileSync(spec.exitFile + '.tmp', JSON.stringify(value)); renameSync(spec.exitFile + '.tmp', spec.exitFile) }
child.once('spawn', () => { report({ pid: child.pid }) })
child.once('error', err => { console.error(err.message); finished({ exitCode: 1, error: err.message }); report({ error: err.message }); process.exitCode = 1 })
child.once('exit', (code, signal) => { finished({ exitCode: code ?? 1, signal }); process.exitCode = code ?? 1 })
