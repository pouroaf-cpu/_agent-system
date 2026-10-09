import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { postInbox, inboxLog } from './lib/inbox.mjs'

test('an inbox line is also kept in the log after the chat clears the inbox', () => {
  const inbox = join(mkdtempSync(join(tmpdir(), 'inbox-')), 'sub', 'X-INBOX.md')
  postInbox(inbox, '- a\n')
  writeFileSync(inbox, '')
  postInbox(inbox, '- b\n')
  assert.equal(readFileSync(inbox, 'utf8'), '- b\n')
  assert.equal(inboxLog(inbox), inbox.replace(/\.md$/, '.log'))
  assert.equal(readFileSync(inboxLog(inbox), 'utf8'), '- a\n- b\n')
})
