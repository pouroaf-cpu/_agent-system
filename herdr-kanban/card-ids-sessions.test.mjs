import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isCardId, cardNumber, nextCardId, agentName, agentRole, isBoardAgent, isReviewerAgent, isSweeperAgent } from './lib/ids.mjs'
import { createCard, parseCard, findCard } from './lib/cards.mjs'
import { herdrArgv, projectAgents, splitRef, approvedManagedModel, SHARED_SESSION } from './lib/herdr.mjs'

const tasks = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hkb-ids-'))
  for (const d of ['planning', 'backlog', 'archive']) mkdirSync(join(dir, d))
  return dir
}

test('legacy T- and prefixed card ids both parse', () => {
  for (const id of ['T-7', 'T-148', 'I149', 'TF40', 'HK14', 'LTS3', 'G1']) assert.ok(isCardId(id), id)
  for (const id of ['T7x', 'ABCD1', 'I-149', '149', 'review', '', 'T-']) assert.ok(!isCardId(id), id)
  assert.equal(cardNumber('T-148'), 148)
  assert.equal(cardNumber('I149'), 149)
  assert.equal(cardNumber('notes'), 0)

  const dir = tasks()
  try {
    writeFileSync(join(dir, 'planning', 'I149-approved-job.md'), '# I149 — New style\n')
    writeFileSync(join(dir, 'planning', 'T-7-old.md'), '# T-7 — Old style\n')
    writeFileSync(join(dir, 'planning', 'TF40-no-heading.md'), 'no heading\n')
    writeFileSync(join(dir, 'planning', 'v2-notes.md'), 'lowercase names are not ids\n')
    assert.equal(parseCard(join(dir, 'planning', 'I149-approved-job.md'), 'planning').id, 'I149')
    assert.equal(parseCard(join(dir, 'planning', 'T-7-old.md'), 'planning').id, 'T-7')
    assert.equal(parseCard(join(dir, 'planning', 'TF40-no-heading.md'), 'planning').id, 'TF40')
    assert.equal(parseCard(join(dir, 'planning', 'v2-notes.md'), 'planning').id, 'V2-NOTES')
    assert.equal(findCard(dir, 'i149').title, 'New style')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('new cards continue the project number across T- and prefixed ids', () => {
  assert.equal(nextCardId('I', ['T-148', 'T-3']), 'I149')
  assert.equal(nextCardId('I', ['T-148', 'I150']), 'I151')
  assert.equal(nextCardId('G', []), 'G1')
  assert.equal(nextCardId(undefined, ['T-2']), 'T-3', 'no prefix keeps legacy ids')
  assert.throws(() => nextCardId('ABCD', []), /prefix/)

  const dir = tasks()
  try {
    writeFileSync(join(dir, 'archive', 'T-148-old.md'), '# T-148 — Archived\n')
    const card = createCard(dir, { title: 'First prefixed card', brief: 'Approved.', prefix: 'I' })
    assert.equal(card.id, 'I149')
    assert.match(card.file, /^I149-approved-job\.md$/)
    // T-150 and I150 are the same number, so an existing T-150 moves I past it.
    writeFileSync(join(dir, 'backlog', 'T-150-late.md'), '# T-150 — Late legacy card\n')
    assert.equal(createCard(dir, { title: 'Next', brief: 'Approved.', prefix: 'I' }).id, 'I151')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('board agents are named <role>-<card id> and still recognise old kb- names', () => {
  assert.equal(agentName('planner', 'I149'), 'p-i149')
  assert.equal(agentName('builder', 'TF40'), 'b-tf40')
  assert.equal(agentName('reviewer', 'HK14'), 'r-hk14')
  assert.equal(agentName('issues', 'G2'), 'i-g2')
  assert.equal(agentName('auditor', 'LTS3'), 'a-lts3')
  assert.equal(agentName('builder', 'T-11'), 'b-t-11')
  for (const name of ['p-i149', 'b-t-11', 'b-i149-2', 'r-lts12']) {
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/, 'herdr only accepts lowercase names')
    assert.ok(isBoardAgent({ name }), name)
  }
  assert.equal(agentRole('b-i149-2'), 'b')
  for (const name of ['kb-t-7-herdr-kanban-w1-pt', 'kb-review-x-w1-p2', 'kb-plan-x', 'kb-planner-t-7-x']) assert.ok(isBoardAgent({ name }), name)
  for (const name of ['planner-injectbuddy', 'kanban-observer', 'b-notacard', 'x-i149']) assert.ok(!isBoardAgent({ name }), name)
  assert.ok(isReviewerAgent({ name: 'r-hk14' }) && isReviewerAgent({ name: 'a-i3' }) && isReviewerAgent({ name: 'kb-review-x' }))
  assert.ok(isSweeperAgent({ name: 'i-g2' }) && isSweeperAgent({ name: 'kb-plan-x' }) && !isSweeperAgent({ name: 'kb-planner-t-1' }))
  assert.deepEqual(approvedManagedModel('b-i149'), approvedManagedModel('kb-t-1-x'))
  assert.deepEqual(approvedManagedModel('p-i149'), approvedManagedModel('kb-planner-t-1'))
  assert.equal(approvedManagedModel('i-g2'), approvedManagedModel('kb-plan-x'))
})

test('old bindings keep resolving in their project session; new ones go to the shared session', () => {
  assert.equal(SHARED_SESSION, 'default')
  // Bare pane id from a binding made before the switch: its own project session.
  assert.deepEqual(herdrArgv(['pane', 'read', 'w1:p5'], 'injectbuddy'), ['--session', 'injectbuddy', 'pane', 'read', 'w1:p5'])
  assert.deepEqual(herdrArgv(['agent', 'start', 'b-t-1', '--kind', 'codex', '--pane', 'w2:p3', '--', '-c', 'x@y'], 'tradeflow'),
    ['--session', 'tradeflow', 'agent', 'start', 'b-t-1', '--kind', 'codex', '--pane', 'w2:p3', '--', '-c', 'x@y'])
  // Qualified id stored on a new binding: the shared session, which takes no flag.
  assert.deepEqual(herdrArgv(['pane', 'close', 'w1:p5@default'], 'injectbuddy'), ['pane', 'close', 'w1:p5'])
  assert.deepEqual(herdrArgv(['agent', 'prompt', 'w3:p9@default', 'text with a@b'], 'tradeflow'), ['agent', 'prompt', 'w3:p9', 'text with a@b'])
  assert.deepEqual(herdrArgv(['tab', 'focus', 'w3:t2@default'], 'tradeflow'), ['tab', 'focus', 'w3:t2'])
  assert.deepEqual(herdrArgv(['tab', 'create', '--cwd', 'C:/x'], SHARED_SESSION), ['tab', 'create', '--cwd', 'C:/x'])
  assert.deepEqual(splitRef('w1:p5', 'healthypets'), { id: 'w1:p5', session: 'healthypets' })

  // Same raw pane id in both sessions stays distinct once merged.
  const labels = new Map([['w1', 'Injectbuddy'], ['w2', 'Tradeflow']])
  const legacy = [{ pane_id: 'w1:p5', tab_id: 'w1:t1', name: 'kb-t-7-injectbuddy-w1-p5', workspace_id: 'w1' }]
  const all = [
    { pane_id: 'w1:p5', tab_id: 'w1:t4', name: 'b-i149', workspace_id: 'w1' },
    { pane_id: 'w2:p1', tab_id: 'w2:t1', name: 'b-t-7', workspace_id: 'w2' },
  ]
  const agents = projectAgents('injectbuddy', legacy, all, labels)
  assert.deepEqual(agents.map(a => [a.pane_id, a.session]), [['w1:p5', 'injectbuddy'], ['w1:p5@default', 'default']])
  assert.equal(agents[1].tab_id, 'w1:t4@default')
  assert.deepEqual(projectAgents('tradeflow', [], all, labels).map(a => a.name), ['b-t-7'], 'other projects\' workspaces are not ours')
})
