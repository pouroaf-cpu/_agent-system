import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beginStoppage, clearStoppage, dropStoppages, noteStart, readyCard, checkResume, resumeAlert, RESUME_BOUND_MS, watchPath } from './lib/resume-watch.mjs'
import { notifyManagerException } from './lib/manager-alerts.mjs'

const T0 = Date.parse('2026-10-16T00:00:00Z')
const MIN = 60000
const P = 'Injectbuddy'
const queue = [{ id: 'IA10' }]
const fresh = () => mkdtempSync(join(tmpdir(), 'resume-watch-'))

test('readyCard: a queued card with no hold, a free slot and no pause is ready', () => {
  assert.equal(readyCard({ queue, holds: {}, slotsFree: 1 }).id, 'IA10')
  assert.equal(readyCard({ queue, holds: { IA10: 'files busy, held by IA9' }, slotsFree: 1 }), null)
  assert.equal(readyCard({ queue, holds: {}, slotsFree: 0 }), null)
  assert.equal(readyCard({ queue, holds: {}, slotsFree: 1, paused: true }), null)
  assert.equal(readyCard({ queue: [], holds: {}, slotsFree: 1 }), null)
})

test('usage-limit reset: no alert while blocked, one alert naming the card when nothing starts after the reset', () => {
  const root = fresh()
  const reset = T0 + 60 * MIN
  beginStoppage(root, { id: `quota:claude:${reset}`, projects: [P], kind: 'quota', clearedAt: reset, now: T0 })
  // Blocked: the card is held by the quota, so it is not ready and the clock does not run.
  assert.equal(checkResume(root, { project: P, ready: false, now: T0 + 30 * MIN }), null)
  assert.equal(checkResume(root, { project: P, ready: false, now: reset + MIN }), null)
  // After the reset the card is ready, but nothing starts for the bound.
  assert.equal(checkResume(root, { project: P, ready: true, now: reset + MIN }), null)
  assert.equal(checkResume(root, { project: P, ready: true, now: reset + RESUME_BOUND_MS }), null)
  const due = checkResume(root, { project: P, ready: true, now: reset + MIN + RESUME_BOUND_MS })
  assert.equal(due.kind, 'quota')
  const alert = resumeAlert(due, { cardId: 'IA10', now: reset + MIN + RESUME_BOUND_MS })
  assert.match(alert.title, /^Injectbuddy IA10: work has not resumed after a usage-limit reset/)
  assert.match(alert.detail, /IA10 is queued with no hold/)
  // Once only.
  assert.equal(checkResume(root, { project: P, ready: true, now: reset + 60 * MIN }), null)
})

test('usage-limit reset: a Builder start after the reset resumes the stoppage with no alert', () => {
  const root = fresh()
  const reset = T0 + 60 * MIN
  beginStoppage(root, { id: `quota:claude:${reset}`, projects: [P], kind: 'quota', clearedAt: reset, now: T0 })
  assert.equal(checkResume(root, { project: P, ready: true, now: reset + MIN }), null)
  noteStart(root, { project: P, now: reset + 2 * MIN })
  assert.equal(checkResume(root, { project: P, ready: true, now: reset + 60 * MIN }), null)
  const rec = JSON.parse(readFileSync(watchPath(root), 'utf8'))[`${P}|quota:claude:${reset}`]
  assert.equal(rec.resumedAt, reset + 2 * MIN)
})

test('disk floor: no alert while low, and one alert when the disk recovers and nothing starts', () => {
  const root = fresh()
  beginStoppage(root, { id: `disk-low:${T0}`, projects: [P], kind: 'disk', now: T0 })
  assert.equal(checkResume(root, { project: P, ready: false, now: T0 + 120 * MIN }), null)
  // Still low: readiness is withheld by the pause, so nothing counts.
  assert.equal(checkResume(root, { project: P, ready: false, now: T0 + 180 * MIN }), null)
  const cleared = T0 + 200 * MIN
  clearStoppage(root, { kind: 'disk', projects: [P], now: cleared })
  assert.equal(checkResume(root, { project: P, ready: true, now: cleared }), null)
  const due = checkResume(root, { project: P, ready: true, now: cleared + RESUME_BOUND_MS })
  assert.equal(due.kind, 'disk')
  assert.equal(checkResume(root, { project: P, ready: true, now: cleared + 2 * RESUME_BOUND_MS }), null)
})

test('disk floor: a start within the bound after recovery resumes it with no alert', () => {
  const root = fresh()
  beginStoppage(root, { id: `disk-low:${T0}`, projects: [P], kind: 'disk', now: T0 })
  clearStoppage(root, { kind: 'disk', projects: [P], now: T0 + MIN })
  assert.equal(checkResume(root, { project: P, ready: true, now: T0 + 2 * MIN }), null)
  noteStart(root, { project: P, now: T0 + 3 * MIN })
  assert.equal(checkResume(root, { project: P, ready: true, now: T0 + 60 * MIN }), null)
})

test('low memory: the same resume check applies, and a stop that ends in a pause never alerts', () => {
  const root = fresh()
  beginStoppage(root, { id: `memory-low:${T0}`, projects: [P], kind: 'memory', now: T0 })
  // Pause ends the clock: a card that is ready at 1 min, then the pause returns at 5 min, is not overdue.
  assert.equal(checkResume(root, { project: P, ready: false, now: T0 + MIN }), null)
  clearStoppage(root, { kind: 'memory', projects: [P], now: T0 + 2 * MIN })
  assert.equal(checkResume(root, { project: P, ready: true, now: T0 + 3 * MIN }), null)
  assert.equal(checkResume(root, { project: P, ready: false, now: T0 + 5 * MIN }), null)
  assert.equal(checkResume(root, { project: P, ready: true, now: T0 + 6 * MIN }), null)
  const due = checkResume(root, { project: P, ready: true, now: T0 + 6 * MIN + RESUME_BOUND_MS })
  assert.equal(due.kind, 'memory')
})

test('board restart: a queued card that does not start after the relaunch alerts once', () => {
  const root = fresh()
  dropStoppages(root, ['disk', 'memory'])
  beginStoppage(root, { id: `boot:${T0}`, projects: [P], kind: 'restart', clearedAt: T0, now: T0 })
  assert.equal(checkResume(root, { project: P, ready: true, now: T0 }), null)
  const due = checkResume(root, { project: P, ready: true, now: T0 + RESUME_BOUND_MS })
  assert.equal(due.kind, 'restart')
  assert.match(resumeAlert(due, { cardId: 'IA10', now: T0 + RESUME_BOUND_MS }).detail, /since a board restart at/)
  // A second boot record is a second stoppage; it is not repeated by a later poll of the first.
  assert.equal(checkResume(root, { project: P, ready: true, now: T0 + 3 * RESUME_BOUND_MS }), null)
})

test('board restart: a start after the relaunch resumes it, and a restart with nothing ready never alerts', () => {
  const root = fresh()
  beginStoppage(root, { id: `boot:${T0}`, projects: [P], kind: 'restart', clearedAt: T0, now: T0 })
  assert.equal(checkResume(root, { project: P, ready: false, now: T0 + 60 * MIN }), null)
  noteStart(root, { project: P, now: T0 + 61 * MIN })
  assert.equal(checkResume(root, { project: P, ready: true, now: T0 + 90 * MIN }), null)
})

test('code update: the relaunch after a pull is a restart stoppage, so the same check applies', async () => {
  const root = fresh()
  beginStoppage(root, { id: `boot:${T0}`, projects: [P], kind: 'restart', clearedAt: T0, now: T0 })
  checkResume(root, { project: P, ready: true, now: T0 })
  const due = checkResume(root, { project: P, ready: true, now: T0 + RESUME_BOUND_MS })
  assert.equal(due.kind, 'restart')
  // The alert line goes through the manager inbox with a key that never repeats.
  const dir = fresh()
  const inbox = join(dir, 'KANBAN_MANAGER-INBOX.md')
  const { key, title, detail } = resumeAlert(due, { cardId: 'IA10', now: T0 + RESUME_BOUND_MS })
  const send = async () => {}
  const first = notifyManagerException({ boardRoot: dir, key, title, detail, code: 'RW', now: T0, cooldownMs: Infinity, inbox, send, log: null })
  return first.then(async res => {
    assert.equal(res.sent, true)
    const again = await notifyManagerException({ boardRoot: dir, key, title, detail, code: 'RW', now: T0 + 999 * MIN, cooldownMs: Infinity, inbox, send, log: null })
    assert.equal(again.sent, false)
    assert.equal(again.reason, 'cooldown')
    const lines = readFileSync(inbox, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /IA10: work has not resumed after a board restart/)
  })
})

test('no stoppage on record (a browser refresh or any ordinary poll): ready cards never alert and no file is written', () => {
  const root = fresh()
  for (let t = 0; t <= 300; t += 5) {
    assert.equal(checkResume(root, { project: P, ready: true, now: T0 + t * MIN }), null)
    noteStart(root, { project: P, now: T0 + t * MIN })
  }
  assert.equal(existsSync(watchPath(root)), false)
})

test('stoppages are per project: a stoppage on one project never alerts another', () => {
  const root = fresh()
  beginStoppage(root, { id: `boot:${T0}`, projects: ['Other'], kind: 'restart', clearedAt: T0, now: T0 })
  assert.equal(checkResume(root, { project: P, ready: true, now: T0 + 3 * RESUME_BOUND_MS }), null)
  checkResume(root, { project: 'Other', ready: true, now: T0 })
  assert.equal(checkResume(root, { project: 'Other', ready: true, now: T0 + RESUME_BOUND_MS }).kind, 'restart')
})
