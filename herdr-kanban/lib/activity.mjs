import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { herdrLog } from './herdr.mjs'

const oneLine = (value) => String(value ?? '-').replace(/[\r\n]+/g, ' ').trim() || '-'
const messageField = (value) => oneLine(value).slice(0, 500)

export function activityLog({ tasksDir, project, cardId, event, message, level = 'info', now = new Date() }) {
  let conciseMessage
  let line
  try {
    conciseMessage = messageField(message)
    line = `${new Date(now).toISOString()} project=${oneLine(project)} card=${oneLine(cardId)} event=${oneLine(event)} message=${conciseMessage}\n`
    appendFileSync(join(tasksDir, 'activity.log'), line)
  } catch {}
  try { herdrLog(`${oneLine(project)} ${oneLine(cardId)} ${oneLine(event)}: ${conciseMessage ?? messageField(message)}`, level) } catch {}
  return line
}
