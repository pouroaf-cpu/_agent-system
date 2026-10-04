import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

test('2026-10-03: node --check catches misplaced shebangs in board modules and scripts', () => {
  const root = import.meta.dirname
  const files = readdirSync(root).filter(f => f.endsWith('.mjs'))
  for (const dir of ['scripts', 'lib']) files.push(...readdirSync(join(root, dir), { recursive: true }).filter(f => f.endsWith('.mjs')).map(f => join(dir, f)))
  for (const file of files) {
    const run = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' })
    assert.equal(run.status, 0, `${file}: ${run.error?.message || run.stderr}`)
  }
})
