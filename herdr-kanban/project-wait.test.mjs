import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wakeDecision, digest, stuckCards, isAsk, movable } from './scripts/project-wait.mjs'

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

test('ASK lines wake the manager; FOUND lines do not count as questions', () => {
  assert.ok(isAsk('- 10 Oct, 5:28 pm ASK Injectbuddy I994 (planning): Approve the investigation?'))
  assert.ok(!isAsk('- 10 Oct, 5:28 pm FOUND Injectbuddy I994 (planning): ASK the vendor later'))
})

test('the 15-minute check counts only cards the manager can move', () => {
  const cards = [{ id: 'A', lane: 'planning' }, { id: 'B', lane: 'pou' }, { id: 'C', lane: 'completed' }, { id: 'D', lane: 'owner' }]
  assert.deepEqual(movable(cards).map(c => c.id), ['A', 'D'])
  assert.deepEqual(movable([]), [])
})
