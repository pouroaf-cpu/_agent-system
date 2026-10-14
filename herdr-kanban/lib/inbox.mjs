import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { nextEventId } from './event-id.mjs'

// Chats delete inbox lines once handled; <inbox>.log beside it keeps every line ever sent
// (operator, 2026-10-09: all board and card findings must be logged).
// ponytail: never rotated; a few dozen lines a day, trim by hand if it ever matters.
export const inboxLog = inbox => inbox.replace(/\.md$/i, '') + '.log'

const CAP = 200 // longest BOARD/FOUND/WAIT line in the .md; the full note stays in the card history
const MERGED_CAP = 300 // same, for one line naming several cards; the sentence keeps MERGED_MIN at least
const MERGED_MIN = 60
const WINDOW_MS = 10 * 60 * 1000
const RUN = 8 // consecutive shared words that make two notes one cause
const LINE = /^- (\d{1,2} \S+, \d{1,2}:\d{2}\s\S+) (BOARD|FOUND|WAIT) (\S+) (\S+) \(([^)]+)\): (.*)$/

const causeWords = note => note.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w && !/\d/.test(w))
const runs = words => new Set(Array.from({ length: Math.max(0, words.length - RUN + 1) }, (_, i) => words.slice(i, i + RUN).join(' ')))
const sharesRun = (a, b) => { const seen = runs(a); return [...runs(b)].some(run => seen.has(run)) }

function fit(head, sentence, tail, max, min = 0) {
  if (head.length + sentence.length + tail.length <= max) return head + sentence + tail
  sentence = sentence.replace(/^\[board\]\s*/i, '')
  const room = Math.max(min, max - head.length - tail.length - 1)
  return head + (head.length + sentence.length + tail.length <= max || sentence.length <= room ? sentence : sentence.slice(0, room).trimEnd() + '…') + tail
}

// ponytail: known limits. A merge made after km-wait.mjs reported the first line is not announced
// (the line count does not rise); 8 shared words of boilerplate can merge two causes wrongly, hence
// the .log keeps each capped line and the card its full note; differently worded notes for one cause
// stay separate but capped; a concurrent write between the .md read and rewrite can lose a .md line.
// The event ID ("BE 12334") is written once, right after the dash. A caller that already took the ID
// (it also puts it in an alert) passes it as the line's leading "- BE 12334 "; a merged note keeps the
// first note's ID and takes no new number. Returns the ID. A corrupt counter throws (not caught).
export function postInbox(inbox, line, now = Date.now(), code = 'GE') {
  mkdirSync(dirname(inbox), { recursive: true })
  const given = /^- ([A-Z]{2} \d{5,}) /.exec(line)?.[1]
  if (given) line = '- ' + line.slice(given.length + 3)
  const withId = (l, eventId) => l.replace(/^(- )?/, `- ${eventId} `)
  const text = line.replace(/\r?\n$/, '')
  const m = text.length > CAP && LINE.exec(text)
  if (!m) {
    const eventId = given ?? nextEventId(code)
    appendFileSync(inbox, withId(line, eventId))
    appendFileSync(inboxLog(inbox), withId(line, eventId))
    return eventId
  }
  const [, stamp, kind, project, id, lane, note] = m
  const sentence = /^.*?[.!?](?=\s|$)/.exec(note)?.[0] ?? note
  const capped = fit(`- ${stamp} ${kind} ${project} ${id} (${lane}): `, sentence, ` (full note: ${id} history)`, CAP) + '\n'

  const sidecar = inboxLog(inbox).replace(/\.log$/, '.recent.json')
  const words = causeWords(note)
  let entries = []
  let handled = false
  let hit
  try {
    try {
      entries = JSON.parse(readFileSync(sidecar, 'utf8')).filter(e => now - e?.at < WINDOW_MS &&
        Array.isArray(e.words) && Array.isArray(e.ids) && typeof e.line === 'string' && typeof e.eventId === 'string')
    } catch { entries = [] }
    let md = ''
    try { md = readFileSync(inbox, 'utf8') } catch { /* no inbox yet */ }
    const lines = md.split('\n')
    const found = entries.find(e => e.kind === kind && e.project === project && lines.includes(e.line) && sharesRun(e.words, words))
    if (found) {
      if (!found.ids.some(e => e.id === id)) {
        const ids = [...found.ids, { id, lane }]
        const next = withId(fit(`- ${found.stamp} ${kind} ${project} ${ids.map(e => `${e.id} (${e.lane})`).join(', ')}: `, found.sentence,
          " (full notes: each card's history)", MERGED_CAP, MERGED_MIN), found.eventId)
        lines[lines.indexOf(found.line)] = next
        writeFileSync(inbox, lines.join('\n'))
        Object.assign(found, { ids, line: next, at: now })
      }
      hit = found
      handled = true
    }
  } catch { handled = false }
  const eventId = handled ? hit.eventId : given ?? nextEventId(code)
  appendFileSync(inboxLog(inbox), withId(capped, eventId))
  if (!handled) {
    appendFileSync(inbox, withId(capped, eventId))
    entries.push({ kind, project, words, at: now, stamp, sentence, ids: [{ id, lane }], line: withId(capped, eventId).slice(0, -1), eventId })
  }
  try { writeFileSync(sidecar, JSON.stringify(entries)) } catch { /* the line is already written */ }
  return eventId
}
