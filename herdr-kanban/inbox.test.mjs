import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { postInbox, inboxLog } from './lib/inbox.mjs'
import { formatNZTime } from './lib/nz-time.mjs'

// the shim (loaded by inbox.mjs) points BOARD_EVENT_COUNTER at a temp file under KANBAN_TEST
const counter = () => JSON.parse(readFileSync(process.env.BOARD_EVENT_COUNTER, 'utf8')).next
const bare = l => l.replace(/^- [A-Z]{2} \d+ /, '- ')

test('an inbox line is also kept in the log after the chat clears the inbox', () => {
  const inbox = join(mkdtempSync(join(tmpdir(), 'inbox-')), 'sub', 'X-INBOX.md')
  const a = postInbox(inbox, '- a\n')
  writeFileSync(inbox, '')
  const b = postInbox(inbox, '- b\n', Date.now(), 'BE')
  assert.match(a, /^GE \d+$/)
  assert.match(b, /^BE \d+$/)
  assert.equal(readFileSync(inbox, 'utf8'), `- ${b} b\n`)
  assert.equal(inboxLog(inbox), inbox.replace(/\.md$/, '.log'))
  assert.equal(readFileSync(inboxLog(inbox), 'utf8'), `- ${a} a\n- ${b} b\n`)
})

// Limits (see lib/inbox.mjs): BOARD/FOUND/WAIT lines over 200 characters are cut to their first
// sentence; same-cause lines (8 shared consecutive words) from different cards within 10 minutes
// merge into one .md line of about 300 characters; the .log keeps each card's own capped line.
const T0 = Date.parse('2026-10-13T10:30:00+13:00')
const MIN = 60 * 1000
const fresh = () => join(mkdtempSync(join(tmpdir(), 'inbox-')), 'X-INBOX.md')
const mdLines = inbox => readFileSync(inbox, 'utf8').split('\n').filter(Boolean)
const logLines = inbox => readFileSync(inboxLog(inbox), 'utf8').split('\n').filter(Boolean)
// distinct letter-only tokens, so two fillers with different prefixes share no 8-word run
const filler = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + String.fromCharCode(97 + i % 26) + String.fromCharCode(97 + (i / 26 | 0))).join(' ')
const line = (kind, id, lane, note, now = T0) => `- ${formatNZTime(now)} ${kind} Injectbuddy ${id} (${lane}): ${note}\n`
const ERROR = "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account"
const board = (id, lead, now) => line('BOARD', id, 'planning', `[board] ${lead} ${ERROR}. ${filler('zz' + id.toLowerCase().replace(/\d/g, 'x'), 140)}`, now)

test('AC1: a 1,700 character BOARD line is cut to one capped line pointing at the card history', () => {
  const inbox = fresh()
  const note = `[board] ${'The planner kept failing to read the card because of a long repeated error '.repeat(23)}end.`
  const original = line('BOARD', 'I1204', 'planning', note)
  assert.ok(original.length >= 1700)
  postInbox(inbox, original, T0)
  const [only, ...rest] = mdLines(inbox)
  assert.deepEqual(rest, [])
  assert.ok(only.length <= 210, `${only.length} characters`)
  assert.match(only, /^- [A-Z]{2} \d+ /)
  assert.ok(bare(only).startsWith(`- ${formatNZTime(T0)} BOARD Injectbuddy I1204 (planning): `))
  assert.ok(only.endsWith('(full note: I1204 history)'))
  assert.ok(only.includes('…'))
})

test('AC2: FOUND and WAIT lines over the limit are capped the same way and the .log gets the capped line', () => {
  const inbox = fresh()
  postInbox(inbox, line('FOUND', 'I1300', 'working', `Pre-existing: the export button is wrong. ${filler('ff', 60)}`), T0)
  postInbox(inbox, line('WAIT', 'I1301', 'planning', `needs a, b — the answer to the question below. ${filler('ww', 60)}`), T0)
  const md = mdLines(inbox)
  assert.equal(md.length, 2)
  assert.match(md[0], /^- .+ FOUND Injectbuddy I1300 \(working\): Pre-existing: the export button is wrong\. \(full note: I1300 history\)$/)
  assert.match(md[1], /^- .+ WAIT Injectbuddy I1301 \(planning\): needs a, b — the answer to the question below\. \(full note: I1301 history\)$/)
  assert.deepEqual(logLines(inbox), md)
})

test('AC3: five same-cause BOARD lines become one .md line naming every card; the .log has five capped lines', () => {
  const inbox = fresh()
  const leads = [
    'Both Builder sessions failed at attempt abc.', // attempt ids differ per card in real notes
    'All 3 attempts ended the same way.',
    'Codex fallback returned HTTP 400 for run def.',
    'The Planner could not start; ghi said no.',
    'Retried twice on jkl with the same answer.',
  ]
  const ids = ['I1204', 'I1208', 'I1206', 'I1207', 'I1197']
  ids.forEach((id, i) => {
    const original = board(id, leads[i], T0 + i * MIN)
    assert.ok(original.length > 900)
    postInbox(inbox, original, T0 + i * MIN)
  })
  const md = mdLines(inbox)
  assert.equal(md.length, 1)
  assert.ok(bare(md[0]).length <= 300, `${md[0].length} characters`)
  for (const id of ids) assert.ok(md[0].includes(id), `${id} missing from ${md[0]}`)
  const log = logLines(inbox)
  assert.equal(log.length, 5)
  assert.ok(log.every(l => bare(l).length <= 200))
})

test('AC4: different causes, same cause more than 10 minutes apart, and same cause after the chat cleared the inbox stay separate', () => {
  const different = fresh()
  postInbox(different, line('BOARD', 'I1', 'planning', `Cause one. ${filler('aa', 80)}`), T0)
  postInbox(different, line('BOARD', 'I2', 'planning', `Cause two. ${filler('bb', 80)}`), T0 + MIN)
  assert.equal(mdLines(different).length, 2)

  const late = fresh()
  postInbox(late, board('I1204', 'First.', T0), T0)
  postInbox(late, board('I1208', 'Second.', T0 + 11 * MIN), T0 + 11 * MIN)
  assert.equal(mdLines(late).length, 2)

  const cleared = fresh()
  postInbox(cleared, board('I1204', 'First.', T0), T0)
  writeFileSync(cleared, '')
  postInbox(cleared, board('I1208', 'Second.', T0 + MIN), T0 + MIN)
  assert.equal(mdLines(cleared).length, 1)
  assert.ok(mdLines(cleared)[0].includes('I1208') && !mdLines(cleared)[0].includes('I1204'))
})

test('AC5: short lines, ALERT lines and ASK lines are written unchanged after the event ID', () => {
  const inbox = fresh()
  const short = [
    line('BOARD', 'I1204', 'planning', `${ERROR}. ${filler('sh', 6)}`.slice(0, 120)),
    line('BOARD', 'I1208', 'planning', `${ERROR}. ${filler('sh', 6)}`.slice(0, 120)),
  ]
  const long = [
    `- ${formatNZTime(T0)} ALERT Injectbuddy Burst: ${Array.from({ length: 40 }, (_, i) => `I${1200 + i}`).join(', ')} moved to Needs you in 10 minutes\n`,
    `- ${formatNZTime(T0)} ALERT Injectbuddy Usage limit reached for the Claude subscription; ${filler('al', 30)}\n`,
    `- ${formatNZTime(T0)} ASK Injectbuddy I1204 (planning): ${filler('as', 60)}?\n`,
  ]
  let all = ''
  for (const l of [...short, ...long]) {
    assert.ok(l.length <= 200 === short.includes(l))
    all += l.replace(/^- /, `- ${postInbox(inbox, l, T0)} `)
  }
  assert.equal(readFileSync(inbox, 'utf8'), all)
  assert.equal(readFileSync(inboxLog(inbox), 'utf8'), all)
})

test('AC6: the ID is written once before the text in .md and .log; a merge keeps the first ID and takes no number', () => {
  const inbox = fresh()
  const before = counter()
  const first = postInbox(inbox, board('I1204', 'First.', T0), T0, 'BQ')
  assert.match(first, /^BQ \d+$/)
  assert.equal(counter(), before + 1)
  const second = postInbox(inbox, board('I1208', 'Second.', T0 + MIN), T0 + MIN, 'BQ')
  assert.equal(second, first)
  assert.equal(counter(), before + 1)
  const md = mdLines(inbox)
  assert.equal(md.length, 1)
  assert.ok(md[0].startsWith(`- ${first} `) && md[0].split(first).length === 2, md[0])
  assert.ok(md[0].includes('I1204') && md[0].includes('I1208'))
  const log = logLines(inbox)
  assert.equal(log.length, 2)
  assert.ok(log.every(l => l.startsWith(`- ${first} `) && l.split(first).length === 2))

  const other = postInbox(inbox, line('BOARD', 'I9', 'planning', `Cause nine. ${filler('qq', 80)}`), T0, 'BQ')
  assert.notEqual(other, first)
  assert.equal(counter(), before + 2)
})

test('AC6: a leading ID supplied by the caller is kept and no second number is taken', () => {
  const inbox = fresh()
  const before = counter()
  const short = postInbox(inbox, '- BE 12999 ' + line('BOARD', 'I1', 'planning', 'short').slice(2), T0, 'BQ')
  const long = postInbox(inbox, '- TA 12998 ' + board('I2', 'Lead.', T0).slice(2), T0, 'BQ')
  assert.equal(short, 'BE 12999')
  assert.equal(long, 'TA 12998')
  assert.equal(counter(), before)
  assert.ok(mdLines(inbox)[0].startsWith('- BE 12999 13 Oct'))
  assert.ok(mdLines(inbox)[1].startsWith('- TA 12998 '))
  assert.equal(mdLines(inbox)[1].split('TA 12998').length, 2)
})
