import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wakeDecision } from './scripts/project-wait.mjs'

test('project waiter wakes for decisions and findings, never integration', () => {
  const before = { project: 'Injectbuddy', cards: [], inbox: [], activity: [], stuck: 1 }
  assert.equal(wakeDecision(before, { ...before }), null)
  assert.equal(wakeDecision(before, { ...before, inbox: ['ASK Injectbuddy I1: choose', 'another question'] }), 'INBOX ASK Injectbuddy I1: choose | another question')
  for (const lane of ['owner', 'pou']) {
    const card = `Injectbuddy/${lane}/I1.md`
    assert.equal(wakeDecision(before, { ...before, cards: [card] }), `OWNER/POU ${card}`)
    assert.equal(wakeDecision({ ...before, cards: [card] }, { ...before, cards: [card] }), null)
  }
  assert.equal(wakeDecision(before, { ...before, stuck: 2 }), 'STUCK Injectbuddy=2')
  assert.equal(wakeDecision(before, { ...before, stuck: 0 }), null)
  assert.equal(wakeDecision(before, { ...before, stuck: null }), null)
  for (const line of ['FOUND Injectbuddy I1: problem', 'project=Injectbuddy card=I1 event=found message=problem']) {
    assert.equal(wakeDecision(before, { ...before, activity: [line] }), `FOUND ${line}`)
  }
  const integrated = { ...before, activity: ['project=Injectbuddy card=I1 event=integrated message=merged'] }
  assert.equal(wakeDecision(before, integrated), null)
  assert.equal(wakeDecision(before, { ...before, activity: ['event=integrated message=FOUND fixed'] }), null)
  assert.equal(wakeDecision(integrated, { ...integrated, activity: [...integrated.activity, 'event=found message=problem'] }), 'FOUND event=found message=problem')
  const trimmed = { ...before, inbox: [] }
  assert.equal(wakeDecision({ ...before, inbox: ['old'] }, trimmed), null)
  assert.equal(wakeDecision(trimmed, { ...trimmed, inbox: ['new'] }), 'INBOX new')
})
