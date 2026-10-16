// IA266 (2026-10-16): `hkb result` and `hkb finish` read their text from stdin when --file is absent. Under an
// agent's shell that stdin can stay open with no data, so the read blocked for 600 s. The wrapper now waits a
// short time for stdin and then refuses with the usage message.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createCard } from './lib/cards.mjs'

function workingBoard(t) {
  const dir = mkdtempSync(join(tmpdir(), 'result-stdin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const card = createCard(dir, { title: 'Working card', brief: 'Preserve the approved scope' })
  mkdirSync(join(dir, 'working'), { recursive: true })
  const path = join(dir, 'working', basename(card.path))
  renameSync(card.path, path)
  return { dir, id: card.id, path }
}

// Runs hkb.mjs with its stdin kept open and never ended, the way an agent shell presents it.
function runOpenStdin(dir, args, { end = '' } = {}) {
  const child = spawn(process.execPath, [resolve('hkb.mjs'), '--tasks', dir, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  if (end) child.stdin.end(end)
  return new Promise(done => {
    const timer = setTimeout(() => { child.kill(); done({ status: 'hung', out }) }, 30000)
    child.on('exit', code => { clearTimeout(timer); done({ status: code, out }) })
  })
}

test('IA266: result with no --file and an open, silent stdin refuses within seconds instead of hanging', async t => {
  const { dir, id } = workingBoard(t)
  const r = await runOpenStdin(dir, ['result', id])
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /result needs the text: hkb result/)
})

test('IA266: finish with no --file and an open, silent stdin refuses within seconds instead of hanging', async t => {
  const { dir, id } = workingBoard(t)
  const r = await runOpenStdin(dir, ['finish', id, '-m', 'x'])
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /finish needs the result text/)
})

test('IA266: text piped on stdin still reaches result and is not refused as empty', async t => {
  const { dir, id } = workingBoard(t)
  const r = await runOpenStdin(dir, ['result', id], { end: 'not a result body' })
  assert.notEqual(r.status, 'hung', r.out)
  assert.doesNotMatch(r.out, /needs the text/)
})
