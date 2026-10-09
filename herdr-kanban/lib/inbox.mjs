import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Chats delete inbox lines once handled; <inbox>.log beside it keeps every line ever sent
// (operator, 2026-10-09: all board and card findings must be logged).
// ponytail: never rotated; a few dozen lines a day, trim by hand if it ever matters.
export const inboxLog = inbox => inbox.replace(/\.md$/i, '') + '.log'

export function postInbox(inbox, line) {
  mkdirSync(dirname(inbox), { recursive: true })
  appendFileSync(inbox, line)
  appendFileSync(inboxLog(inbox), line)
}
