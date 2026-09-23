import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createCard, findCard, moveCard } from './lib/cards.mjs'

const dir = mkdtempSync(join(tmpdir(), 'owner-routing-'))
const handoff = (verb, id, note) => {
  const result = spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', dir, verb, id, note], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return findCard(dir, id)
}
try {
  const card = createCard(dir, { title: 'Failed review', brief: 'Approved change' })
  writeFileSync(join(dir, '.card-planners.json'), JSON.stringify({ [card.id]: { paneId: 'original-planner', submitted: true } }))
  for (let i = 0; i < 4; i++) {
    moveCard(dir, card.id, 'review')
    assert.equal(handoff('rework', card.id, '[planning] missing mobile criterion').column, 'planning')
    const planner = JSON.parse(readFileSync(join(dir, '.card-planners.json'), 'utf8'))[card.id]
    assert.equal(planner.paneId, 'original-planner')
    assert.equal(planner.submitted, false)
  }
  assert.equal(findCard(dir, card.id).autoReview, true)
  assert.match(readFileSync(findCard(dir, card.id).path, 'utf8'), /"returns":4/)
  assert.equal(handoff('owner', card.id, 'Browser check could not log in').column, 'planning')
  assert.equal(handoff('park', card.id, 'Third technical check failed').column, 'planning')
  assert.equal(handoff('owner', card.id, 'Only the operator can grant permission. Verified access unavailable; approved methods exhausted. Evidence: access check returned permission denied.').column, 'owner')
  const audit = createCard(dir, { title: 'Audit', brief: 'Report only', audit: 'design', tools: 'browser' })
  writeFileSync(audit.path, readFileSync(audit.path, 'utf8').replace('## Audit conclusion', '## Audit conclusion\nINCOMPLETE\n'))
  assert.equal(handoff('owner', audit.id, 'Audit report ready: INCOMPLETE — missing evidence').column, 'review')
  const returned = findCard(dir, audit.id)
  writeFileSync(returned.path, readFileSync(returned.path, 'utf8').replace('## Evidence', '## Evidence\nMeasured DOM evidence saved.\n').replace('## Audit conclusion\nINCOMPLETE', '## Audit conclusion\nFINDINGS'))
  assert.equal(handoff('owner', audit.id, 'Audit report ready: FINDINGS — 2 findings for remediation choices').column, 'planning')
  const untouched = createCard(dir, { title: 'Unrelated', brief: 'No review opted in' })
  assert.equal(findCard(dir, untouched.id).autoReview, false)
  const original = readFileSync(untouched.path, 'utf8')
  writeFileSync(untouched.path, original.replace('\n', '\n' + 'Assignment evidence. '.repeat(200) + '\n'))
  assert.equal(findCard(dir, untouched.id).cardOwned, true, 'long assignment does not hide metadata')
  handoff('rework', untouched.id, 'needs verification')
  assert.equal(findCard(dir, untouched.id).autoReview, true, 'review survives long assignment text')
  console.log('Owner routing: repeated review, technical blockers, human permission, audit gaps and review isolation passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
