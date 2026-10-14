// Board event IDs come from one shared helper outside the card worktrees (same absolute-path
// convention as INBOX in board-alerts.mjs). Tests get their own counter so the real one is never touched.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.env.KANBAN_TEST && !process.env.BOARD_EVENT_COUNTER) {
  process.env.BOARD_EVENT_COUNTER = join(tmpdir(), `board-event-id-${process.pid}.json`)
}

// the helper reads BOARD_EVENT_COUNTER at import, so it must load after the line above
export const { nextEventId, EVENT_KINDS } = await import(pathToFileURL('C:/Users/PFrew/Projects/_roles/board-event-id.mjs').href)
