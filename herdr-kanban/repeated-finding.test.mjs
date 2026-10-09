import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHistory, repeatedFinding } from './lib/card-history.mjs'

test('a finding quoting an already-reported snippet is a repeat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-'))
  assert.equal(repeatedFinding(dir, "line 922 'rounded-lgborder' drops the radius"), null)
  appendHistory(dir, 'I967', { event: 'found', note: "LabDashboard.tsx line 922 'rounded-lgborder' (site rotation)", to: 'x' })
  assert.equal(repeatedFinding(dir, "same typo: 'rounded-lgborder' at :922"), 'I967')
  assert.equal(repeatedFinding(dir, "other issue: 'rounded-lgmax-md:rounded'"), null)
  assert.equal(repeatedFinding(dir, 'no quotes here at all'), null)
})
