import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Dynamic import: the event-ID counter must be a temp file before project-wait loads the helper.
process.env.BOARD_EVENT_COUNTER ||= join(mkdtempSync(join(tmpdir(), 'ww-event-id-')), 'counter.json')
const { ledgerDecision, checkDecision, stuckKey, checkKey } = await import('./scripts/project-wait.mjs')
const { wakeLedger, WAKE_REARM_MS } = await import('./lib/waiter-wakes.mjs')

const T0 = 1_800_000_000_000
const PROJECT = 'Injectbuddy'
const card = (id, reason = 'Plan check pending') => ({ project: PROJECT, id, lane: 'planned', minutes: 72, reason })

// A waiter life, as scripts/project-wait.mjs main() runs it: the baseline is what is stuck when it starts,
// and what it saw holding is recorded in the ledger file before it prints anything.
function startLife(file, stuckCards, count, at) {
  const ledger = wakeLedger(file)
  ledger.observe(stuckCards.map(stuckKey), at)
  return { ledger, before: { project: PROJECT, cards: [], inbox: [], stuck: count, stuckCards } }
}
function tick(life, stuckCards, count, at) {
  const now = { project: PROJECT, cards: [], inbox: [], stuck: count, stuckCards }
  const wake = ledgerDecision(life.before, now, life.ledger, at)
  life.ledger.observe(stuckCards.map(stuckKey), at)
  life.ledger.flush(at, { force: Boolean(wake) })
  life.before = now
  return wake
}

test('a respawned waiter stays quiet about a stuck card it already woke for (STUCK I1322 overnight)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-replay-'))
  try {
    const file = join(dir, 'project-wait-Injectbuddy.json')
    const I1322 = card('I1322')
    // Life 1: the card goes stuck and the chat is woken once.
    const first = startLife(file, [], 0, T0)
    assert.equal(tick(first, [I1322], 1, T0 + 60e3), 'STUCK Injectbuddy=1')
    // Life 2: the chat re-arms the waiter while the card is briefly unstuck (count 0), then it sticks again.
    const second = startLife(file, [], 0, T0 + 10 * 60e3)
    assert.equal(tick(second, [], 0, T0 + 11 * 60e3), null)
    assert.equal(tick(second, [I1322], 1, T0 + 12 * 60e3), null, 'the same card must not wake the chat again')
    // Life 3: the chat re-arms with the card already stuck, then a second card gets stuck: that one is news.
    const third = startLife(file, [I1322], 1, T0 + 20 * 60e3)
    assert.equal(tick(third, [I1322], 1, T0 + 21 * 60e3), null)
    assert.equal(tick(third, [I1322, card('I1339')], 2, T0 + 22 * 60e3), 'STUCK Injectbuddy=2')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a stuck card with a new reason is news, the same reason is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-reason-'))
  try {
    const file = join(dir, 'w.json')
    const life = startLife(file, [], 0, T0)
    assert.equal(tick(life, [card('I1322', 'Plan check pending')], 1, T0 + 60e3), 'STUCK Injectbuddy=1')
    const again = startLife(file, [], 0, T0 + 120e3)
    assert.equal(tick(again, [card('I1322', 'Plan check pending')], 1, T0 + 180e3), null)
    // The same card, now stuck for another reason, after a respawn at count 0: that is news.
    const changed = startLife(file, [], 0, T0 + 240e3)
    assert.equal(tick(changed, [card('I1322', 'Blocked by I1300')], 1, T0 + 300e3), 'STUCK Injectbuddy=1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the stuck card is re-armed after six hours unseen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-rearm-'))
  try {
    const file = join(dir, 'w.json')
    const I1322 = card('I1322')
    const life = startLife(file, [I1322], 1, T0)
    life.ledger.flush(T0, { force: true })
    const later = wakeLedger(file)
    assert.equal(later.isNews(stuckKey(I1322), T0 + WAKE_REARM_MS - 1), false)
    assert.equal(later.isNews(stuckKey(I1322), T0 + WAKE_REARM_MS), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unreadable stuck list never swallows a rise in the count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-empty-'))
  try {
    const life = startLife(join(dir, 'w.json'), [], 1, T0)
    const now = { project: PROJECT, cards: [], inbox: [], stuck: 2, stuckCards: [] }
    assert.equal(ledgerDecision(life.before, now, life.ledger, T0 + 60e3), 'STUCK Injectbuddy=2')
    const unknown = { project: PROJECT, cards: [], inbox: [], stuck: 2 }
    assert.equal(ledgerDecision(life.before, unknown, life.ledger, T0 + 60e3), 'STUCK Injectbuddy=2')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the 15-minute CHECK repeats only when a movable card is news', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-check-'))
  try {
    const file = join(dir, 'w.json')
    const I1339 = { id: 'I1339', lane: 'queue', minutes: 20, reason: '' }
    const first = wakeLedger(file)
    assert.match(checkDecision(PROJECT, [I1339], first, T0), /^CHECK Injectbuddy: 1 card\(s\) could move/)
    first.observe([checkKey(I1339)], T0)
    first.flush(T0, { force: true })
    const respawned = wakeLedger(file)
    assert.equal(checkDecision(PROJECT, [I1339], respawned, T0 + 15 * 60e3), null)
    assert.match(checkDecision(PROJECT, [{ ...I1339, reason: 'waiting on the operator' }], respawned, T0 + 30 * 60e3), /^CHECK Injectbuddy/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an owner card that leaves and comes back still wakes the chat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-owner-'))
  try {
    const life = startLife(join(dir, 'w.json'), [], 0, T0)
    const owner = 'Injectbuddy/owner/I1.md'
    assert.equal(ledgerDecision({ project: PROJECT, cards: [owner], inbox: [], stuck: 0 }, { project: PROJECT, cards: [], inbox: [], stuck: 0 }, life.ledger, T0), null)
    assert.equal(ledgerDecision({ project: PROJECT, cards: [], inbox: [], stuck: 0 }, { project: PROJECT, cards: [owner], inbox: [], stuck: 0 }, life.ledger, T0 + 60e3), `OWNER/POU ${owner}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a ledger that cannot be written does not stop the waiter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-unwritable-'))
  try {
    const ledger = wakeLedger(join(dir, 'missing-folder', 'w.json'))
    ledger.observe(['stuck:x'], T0)
    assert.doesNotThrow(() => ledger.flush(T0, { force: true }))
    assert.equal(ledger.isNews('stuck:x', T0 + 1), false, 'the memory still holds for this process')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
