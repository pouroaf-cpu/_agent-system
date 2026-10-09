import { formatNZText } from './nz-time.mjs'
// Pushover alert when a card lands in Pou, the operator's lane, on any project. Owner
// belongs to the Kanban Manager and never alerts. Same credentials and
// one-attempt rule as watchdog-alert.ps1: the alerted set is persisted before the
// send, so an ambiguous timeout never repeats a push. A card that leaves Pou and
// comes back alerts again.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { join } from 'node:path'
import { readBoard } from './cards.mjs'

const STATE = '.owner-alerted.json'

// The plain question the board wrote for the operator, if any.
export function ownerReason(text) {
  const at = Math.max(text.lastIndexOf('Needs you:'), text.lastIndexOf('**Needs you**'), text.lastIndexOf('**Operator decision needed**'))
  if (at < 0) return ''
  return text.slice(at).replace(/\*\*Needs you\*\*[^\n]*\n+/, '').replace(/^Needs you:\s*/, '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 400)
}

// priority 2 = Pushover emergency: repeats every 60 s until acknowledged (max 30 min) and, with
// Critical Alerts on in the iOS app, sounds through mute and Focus. Only for questions the operator
// must answer (operator, 2026-10-09); board problems stay at 0.
export async function pushover(title, message, env = process.env, priority = 0) {
  const token = env.PUSHOVER_APP_TOKEN, user = env.PUSHOVER_USER_KEY
  if (!token || !user) throw new Error('Pushover credentials are not configured')
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST', body: new URLSearchParams({ token, user, title, message: formatNZText(message), priority: String(priority), ...(priority === 2 ? { retry: '60', expire: '1800' } : {}) }), signal: AbortSignal.timeout(30000),
  })
  if ((await res.json().catch(() => ({})))?.status !== 1) throw new Error(`Pushover did not accept the alert (HTTP ${res.status})`)
}

export const critical = (title, message) => pushover(title, message, undefined, 2)

export async function alertOwnerCards({ project, tasksDir, send = critical }) {
  const path = join(tasksDir, STATE)
  const first = !existsSync(path)
  const alerted = first ? {} : JSON.parse(readFileSync(path, 'utf8'))
  const owner = readBoard(tasksDir).pou
  const fresh = owner.filter(c => !alerted[c.id])
  const next = Object.fromEntries(owner.map(c => [c.id, alerted[c.id] || new Date().toISOString()]))
  const changed = fresh.length || Object.keys(alerted).some(id => !next[id])
  if (changed || first) { writeFileSync(path + '.tmp', JSON.stringify(next, null, 2)); renameSync(path + '.tmp', path) }
  if (!fresh.length) return []
  if (first && fresh.length > 1) {
    await send(`${project}: ${fresh.length} cards need you`, fresh.map(c => `${c.id} ${c.title}`).join('\n').slice(0, 1000))
  } else {
    for (const c of fresh) {
      const reason = ownerReason(readFileSync(c.path, 'utf8'))
      await send(`${project} ${c.id} needs you`, formatNZText(`${c.title}${reason ? `\n\n${reason}` : ''}`).slice(0, 1000))
    }
  }
  return fresh.map(c => c.id)
}
