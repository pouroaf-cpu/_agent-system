// Board agents must not run Python. bin/python and bin/python3 (sh and cmd) refuse at once, so a stray
// `python - <<EOF` returns in milliseconds instead of hanging the agent shell for 10 minutes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const bin = resolve('bin')
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0

for (const name of ['python', 'python3']) {
  test(`bin/${name} refuses at once, names itself, and exits 1 without reading stdin`, { skip: !hasSh }, () => {
    const started = Date.now()
    const r = spawnSync('sh', [join(bin, name), '-'], { input: 'print(1)\n', encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(r.error, undefined, String(r.error))
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, new RegExp(`^${name} is not available to board agents; use node or Edit`))
    assert.ok(Date.now() - started < 5000)
  })

  test(`bin/${name}.cmd refuses at once and exits 1`, { skip: process.platform !== 'win32' }, () => {
    const r = spawnSync('cmd', ['/d', '/c', join(bin, `${name}.cmd`), '-'], { input: 'print(1)\n', encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(r.error, undefined, String(r.error))
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`)
    assert.match(`${r.stdout}${r.stderr}`, new RegExp(`${name} is not available to board agents; use node or Edit`))
  })
}
