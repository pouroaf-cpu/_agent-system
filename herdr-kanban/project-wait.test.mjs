import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inboxLog } from './lib/inbox.mjs'
import { wakeDecision, digest, stuckCards, isAsk, movable, boardOff, planFails, planSinceFrom, settled, inboxWake, askWake } from './scripts/project-wait.mjs'

test('planFails returns recent plan-check FAIL lines from recently changed history files', () => {
  const root = mkdtempSync(join(tmpdir(), 'km-planfails-'))
  const history = join(root, 'Project', 'TASKS', '.history')
  mkdirSync(history, { recursive: true })
  const since = Date.now() - 5000
  writeFileSync(join(history, 'I123.jsonl'), [
    JSON.stringify({ event: 'plan-check', verdict: 'FAIL', at: new Date().toISOString(), reason: 'Plan check: stale-plan:  two  spaces\ncollapsed' }),
    JSON.stringify({ event: 'plan-check', verdict: 'PASS', at: new Date().toISOString(), reason: 'not rejected' }),
    JSON.stringify({ event: 'plan-check', verdict: 'FAIL', at: new Date(since - 1000).toISOString(), reason: 'old rejection' }),
    '{broken json'
  ].join('\n'))
  try { assert.deepEqual(planFails(root, since), ['Project I123: stale-plan: two spaces collapsed']) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('planSinceFrom uses a saved cursor within a two-hour window', () => {
  const now = 10_000_000
  const twoHours = 2 * 60 * 60e3
  assert.equal(planSinceFrom(String(now - 1000), now), now - 1000)
  assert.equal(planSinceFrom(undefined, now), now)
  assert.equal(planSinceFrom('garbage', now), now)
  assert.equal(planSinceFrom(String(now - twoHours - 1), now), now - twoHours)
  assert.equal(planSinceFrom(String(now + 1), now), now)
})

test('project waiter wakes for Owner/Pou and stuck; FOUND waits for the hourly digest', () => {
  const before = { project: 'Injectbuddy', cards: [], inbox: [], stuck: 1 }
  assert.equal(wakeDecision(before, { ...before }), null)
  assert.equal(wakeDecision(before, { ...before, inbox: ['ASK Injectbuddy I1: choose', 'FOUND Injectbuddy I1: problem'] }), null)
  for (const lane of ['owner', 'pou']) {
    const card = `Injectbuddy/${lane}/I1.md`
    assert.equal(wakeDecision(before, { ...before, cards: [card] }), `OWNER/POU ${card}`)
    assert.equal(wakeDecision({ ...before, cards: [card] }, { ...before, cards: [card] }), null)
  }
  assert.equal(wakeDecision(before, { ...before, stuck: 2 }), 'STUCK Injectbuddy=2')
  assert.equal(stuckCards([{ id: 'I980', lane: 'planned', minutes: 72, reason: 'Plan check pending' }, { id: 'I9', lane: 'queue', minutes: 61 }]), 'I980 planned 72m: Plan check pending; I9 queue 61m: no reason given')
  assert.equal(wakeDecision(before, { ...before, stuck: 0 }), null)
  assert.equal(wakeDecision(before, { ...before, stuck: null }), null)
  assert.equal(digest(3, 3, 'x.md'), 'RE-ARM')
  assert.equal(digest(3, 1, 'x.md'), 'RE-ARM')
  assert.equal(digest(3, 5, 'x.md'), 'INBOX 2 new ASK/FOUND line(s) in x.md: read and handle them')
})

test('an inbox burst settles into one wake with every line', async () => {
  const { settled } = await import('./scripts/project-wait.mjs')
  const inbox = ['old', 'a']
  setTimeout(() => inbox.push('b'), 15)
  setTimeout(() => inbox.push('c'), 35)
  assert.deepEqual(await settled(() => inbox, 1, 50, 1000, 5), ['a', 'b', 'c'])
})

test('settled keeps the wake-up line when the file is emptied during the quiet wait (AC1)', async () => {
  let calls = 0
  assert.deepEqual(await settled(() => calls++ ? [] : ['new'], 0, 30, 1000, 5), ['new'])
  calls = 0
  assert.deepEqual(await settled(() => calls++ ? [] : ['old', 'new'], 1, 30, 1000, 5), ['new'])
})

test('settled returns first-seen and added lines once each, in order, across a mid-wait trim (AC3)', async () => {
  const inbox = ['old', 'a']
  setTimeout(() => inbox.push('b'), 15)
  setTimeout(() => { inbox.length = 0 }, 25)
  setTimeout(() => inbox.push('c', 'a'), 35)
  assert.deepEqual(await settled(() => inbox, 1, 50, 1000, 5), ['a', 'b', 'c'])
})

test('a wake never prints a bare INBOX or ASK 0; an emptied .md falls back to the .log (AC2)', () => {
  assert.equal(inboxWake([], ['- 13 Oct FOUND HK18 (planning): x'], 'i.md'), 'INBOX - 13 Oct FOUND HK18 (planning): x')
  const empty = inboxWake([], [], 'i.md')
  assert.notEqual(empty, 'INBOX')
  assert.doesNotMatch(empty, /^INBOX\s*$/)
  assert.match(empty, /nothing to read/)
  assert.equal(inboxWake(['a', 'b'], ['z'], 'i.md'), 'INBOX a\nb')

  const ask = 'x ASK P I1 (planning): q'
  assert.equal(askWake([ask], [], 'i.md'), 'ASK 1 new question(s) in i.md: answer each now, or ask the operator in chat if only they can')
  assert.equal(askWake([], [ask], 'i.md'), `ASK 1 new question(s) in i.md: answer each now, or ask the operator in chat if only they can\n${ask}`)
  assert.match(askWake([], [], 'i.md'), /nothing to read/)
})

test('an emptied .md with one .log line wakes with that line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wait-'))
  try {
    const md = join(dir, 'KM-INBOX.md')
    writeFileSync(md, '')
    writeFileSync(inboxLog(md), '- 13 Oct FOUND HK18 (planning): x\n')
    const read = f => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
    assert.equal(inboxWake(read(md), read(inboxLog(md)), md), 'INBOX - 13 Oct FOUND HK18 (planning): x')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ASK lines wake the manager; FOUND lines do not count as questions', () => {
  assert.ok(isAsk('- 10 Oct, 5:28 pm ASK Injectbuddy I994 (planning): Approve the investigation?'))
  assert.ok(!isAsk('- 10 Oct, 5:28 pm FOUND Injectbuddy I994 (planning): ASK the vendor later'))
})

test('the 15-minute check counts only cards the manager can move', () => {
  const cards = [{ id: 'A', lane: 'planning' }, { id: 'B', lane: 'pou' }, { id: 'C', lane: 'completed' }, { id: 'D', lane: 'owner' }]
  assert.deepEqual(movable(cards).map(c => c.id), ['A', 'D'])
  assert.deepEqual(movable([]), [])
})

test('night stop or a paused project mutes stuck and CHECK', () => {
  assert.equal(boardOff({ maxConcurrentAgents: 0 }, { paused: false }), true)
  assert.equal(boardOff({ maxConcurrentAgents: 8 }, { paused: true }), true)
  assert.equal(boardOff({ maxConcurrentAgents: 8 }, { paused: false }), false)
  assert.equal(boardOff({ maxConcurrentAgents: 8 }, undefined), false)
})
