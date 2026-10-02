#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

const file = process.argv[2]
let request
const save = (state, error) => {
  request.state = state
  request.pid = process.pid
  if (error) request.error = error
  writeFileSync(file, JSON.stringify(request))
}
try {
  request = JSON.parse(readFileSync(file, 'utf8'))
  const tasks = dirname(dirname(dirname(file)))
  const name = `${request.id}-${request.type}.spec.ts`
  const dir = join(tasks, 'test-lab', 'specs')
  mkdirSync(dir, { recursive: true })
  request.spec = join(dir, name)
  save('writing')
  const run = (script, args) => {
    const child = spawnSync(process.execPath, [join(import.meta.dirname, script), ...args], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 })
    if (child.status !== 0) throw new Error(child.error?.message || child.stderr?.trim() || child.stdout?.trim() || `${script} exited ${child.status}`)
  }
  run('test-writer.mjs', ['--type', request.type, '--pages', request.pages.join(','), '--out', request.spec])
  save('running')
  run('e2e-nightly.mjs', ['--', 'e2e/test-lab/' + name])
  save('done')
} catch (err) {
  if (request) save('failed', err.message)
  console.error(err.message)
  process.exitCode = 1
}
