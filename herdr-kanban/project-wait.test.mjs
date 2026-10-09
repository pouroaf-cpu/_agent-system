import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wakeDecision, digest } from './scripts/project-wait.mjs'

test('project waiter wakes only for Owner/Pou and stuck; ASK/FOUND wait for the hourly digest', () => {
  const before = { project: 'Injectbuddy', cards: [], inbox: [], stuck: 1 }
  assert.equal(wakeDecision(before, { ...before }), null)
  assert.equal(wakeDecision(before, { ...before, inbox: ['ASK Injectbuddy I1: choose', 'FOUND Injectbuddy I1: problem'] }), null)
  for (const lane of ['owner', 'pou']) {
    const card = `Injectbuddy/${lane}/I1.md`
    assert.equal(wakeDecision(before, { ...before, cards: [card] }), `OWNER/POU ${card}`)
    assert.equal(wakeDecision({ ...before, cards: [card] }, { ...before, cards: [card] }), null)
  }
  assert.equal(wakeDecision(before, { ...before, stuck: 2 }), 'STUCK Injectbuddy=2')
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
