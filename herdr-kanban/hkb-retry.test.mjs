import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadError } from './hkb.mjs'

test('only a module load error counts as the board being down (IA135)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hkb-retry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'bad.mjs'), 'export const a = (\n')
  writeFileSync(join(dir, 'ok.mjs'), 'export const b = 1\n')
  const run = (name, code) => { writeFileSync(join(dir, name), code); return spawnSync(process.execPath, [join(dir, name)], { encoding: 'utf8', windowsHide: true }).stderr }
  assert.equal(loadError(run('syntax.mjs', "import { a } from './bad.mjs'\n")), true)
  assert.equal(loadError(run('export.mjs', "import { zz } from './ok.mjs'\n")), true)
  assert.equal(loadError(run('runtime.mjs', "import './ok.mjs'\nJSON.parse('{')\n")), false)
  assert.equal(loadError('hkb: done refused: no commit\n'), false)
})
