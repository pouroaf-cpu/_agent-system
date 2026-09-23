import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cardUsageSummary } from './lib/request-usage.mjs'
const dir = mkdtempSync(join(tmpdir(), 'card-usage-'))
try {
  const delta = { input: 12, uncachedInput: 2, cachedInput: 10, output: 3, reasoningOutput: 1, total: 15 }
  const run = { cardIds: ['T-1'], status: 'complete', delta, start: { at: '2026-09-11T00:00:00Z' }, finish: { at: '2026-09-11T00:01:00Z' } }
  writeFileSync(join(dir, '.request-usage.json'), JSON.stringify({ runs: {
    good: { ...run, runId: 'good' }, duplicate: { ...run, duplicateOf: 'good' },
    ambiguous: { ...run, status: 'ambiguous' }, batch: { ...run, cardIds: ['T-1', 'T-2'] }
  }}))
  const result = cardUsageSummary(dir)
  assert.equal(result['T-1'].tokens.total, 15)
  assert.equal(result['T-1'].unknown, 2)
  assert.equal(result['T-2'].tokens, null)
  assert.equal(result['T-1'].agents[0].finishedAt, run.finish.at)
  console.log('Card attribution checks passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
