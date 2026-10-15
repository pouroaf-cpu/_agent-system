import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdAlertKey, notifyManagerException, resolveManagerException } from './lib/manager-alerts.mjs'

// server.mjs logIntegrationResults sends each integration hold with these options: one line per hold,
// keyed by card, never re-sent while the card stays held, re-armed once the card is no longer held.
const HOUR = 60 * 60e3
const T0 = 1_800_000_000_000

test('a standing integration hold reaches the Kanban Manager once, and a second card still alerts (HO)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hold-alert-'))
  try {
    const inbox = join(dir, 'KANBAN_MANAGER-INBOX.md')
    const send = async () => {}
    const hold = (id, now, alertKey = 'integration-check:base') => notifyManagerException({
      boardRoot: dir, key: holdAlertKey(alertKey, 'Proof', id), cooldownMs: Infinity, now, send, inbox, log: null,
      title: `Proof: integration check broken on master, ${id} held`, detail: 'builder-role-size.test.mjs fails on master', code: 'HO',
    })
    assert.equal((await hold('T-1', T0)).sent, true)
    // Polls repeat the hold: an hour later and five hours later, the same card is silent.
    assert.equal((await hold('T-1', T0 + HOUR)).reason, 'cooldown')
    assert.equal((await hold('T-1', T0 + 5 * HOUR)).reason, 'cooldown')
    // The shared key used to swallow this: a second card with the same verdict is its own hold.
    assert.equal((await hold('T-2', T0 + 5 * HOUR)).sent, true)
    // A config hold for the first card is a different hold.
    assert.equal((await hold('T-1', T0 + 6 * HOUR, 'integration-check:config')).sent, true)
    assert.equal(readFileSync(inbox, 'utf8').split('\n').filter(Boolean).length, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('once the card is no longer held, its next hold alerts at once (HO re-arm)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hold-rearm-'))
  try {
    const inbox = join(dir, 'KANBAN_MANAGER-INBOX.md')
    const key = holdAlertKey('integration-check:base', 'Proof', 'T-1')
    const hold = now => notifyManagerException({ boardRoot: dir, key, cooldownMs: Infinity, now, send: async () => {}, inbox, log: null, title: 'Proof: held', detail: 'x', code: 'HO' })
    assert.equal((await hold(T0)).sent, true)
    assert.equal((await hold(T0 + HOUR)).reason, 'cooldown')
    resolveManagerException(dir, key)
    assert.equal((await hold(T0 + 2 * HOUR)).sent, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
