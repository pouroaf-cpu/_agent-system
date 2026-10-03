import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { needsBrowser } from './lib/cards.mjs'

test('template comments do not make a card need a browser; real browser words still do', t => {
  const dir = mkdtempSync(join(tmpdir(), 'needs-browser-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const card = (name, text) => { const path = join(dir, name); writeFileSync(path, text); return { path } }
  assert.equal(needsBrowser(card('a.md', '# T-1 — fix copy\n<!-- e.g. screenshot at 390px with chrome-devtools -->\nFiles: lib/a.mjs\n')), false)
  assert.equal(needsBrowser(card('b.md', '# T-2 — fix layout\nAC1: screenshot at 390px\n')), true)
})
