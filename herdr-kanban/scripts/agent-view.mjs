import { openSync, closeSync, readSync, readFileSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'

const compact = (value, limit = 240) => String(typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').slice(0, limit)
const full = value => compact(value, 20000)
const entry = (kind, text, at = null) => ({ kind, text: String(text).slice(0, 20000), at })

export function eventEntries(line) {
  let e
  try { e = JSON.parse(line) } catch {
    const entries = [entry('info', line)]
    Object.defineProperty(entries, 'terminal', { value: line })
    return entries
  }
  const entries = []
  let terminal = ''
  if (!e || typeof e !== 'object') { terminal = compact(e); if (e === null) entries.push(entry('info', terminal)) }
  else if (e.type === 'thread.started') { terminal = `Session ${e.thread_id}`; entries.push(entry('info', terminal)) }
  else if (e.type === 'system' && e.subtype === 'init') { terminal = `Session ${e.session_id} · ${e.model || 'Claude'}`; entries.push(entry('info', terminal)) }
  // Bookkeeping the old pane never showed: hooks, token counters, rate limits, heartbeats.
  else if (['system', 'rate_limit_event', 'tool_progress', 'stream_event'].includes(e.type) || (e.type === 'thinking' && !e.thinking)) terminal = ''
  else if ((e.type === 'assistant' || e.type === 'user') && Array.isArray(e.message?.content)) {
    const at = e.timestamp || null
    const legacy = []
    for (const part of e.message.content) {
      if (part.type === 'text') { entries.push(entry(e.type === 'assistant' ? 'agent' : 'received', part.text || '', at)); legacy.push(part.text || '') }
      else if (part.type === 'thinking') {
        if (part.thinking) { entries.push(entry('thinking', part.thinking, at)); legacy.push(`Thinking: ${part.thinking}`) }
        else legacy.push('')
      } else if (part.type === 'tool_use') {
        const input = full(part.input)
        entries.push(entry('sent', `→ ${part.name} ${input}`, at))
        legacy.push(`→ ${part.name} ${compact(part.input, 1000)}`)
      } else if (part.type === 'tool_result') {
        entries.push(entry('received', `← ${part.is_error ? 'ERROR ' : ''}${full(part.content)}`, at))
        legacy.push(`← ${part.is_error ? 'ERROR ' : ''}${compact(part.content)}`)
      } else { entries.push(entry('info', full(part), at)); legacy.push(compact(part)) }
    }
    terminal = legacy.join('\n')
  } else if (e.type?.startsWith('item.')) {
    const item = e.item || {}
    if (item.type === 'agent_message') { terminal = item.text || ''; entries.push(entry('agent', terminal)) }
    else if (item.type === 'reasoning') { terminal = item.text ? `Thinking: ${item.text}` : compact(e); if (item.text) entries.push(entry('thinking', item.text)); else entries.push(entry('info', terminal)) }
    else {
      const input = item.command || item.arguments || item.input || item.changes || item.query || ''
      const name = item.tool || item.type || 'tool'
      if (e.type === 'item.started') {
        entries.push(entry('sent', `→ ${name} ${full(input)}`))
        terminal = `→ ${name} ${compact(input, 1000)}`
      } else {
        entries.push(entry('received', `← ${name} ${full(input)} [${item.exit_code ?? item.status ?? 'complete'}] ${full(item.aggregated_output || item.result || item.error || '')}`))
        terminal = `← ${name} ${compact(input, 400)} [${item.exit_code ?? item.status ?? 'complete'}] ${compact(item.aggregated_output || item.result || item.error || '')}`
      }
    }
  } else if (e.type === 'result') { terminal = `Turn ${e.is_error ? 'ERROR' : 'complete'}${e.result ? `\n${e.result}` : ''}`; entries.push(entry(e.is_error ? 'error' : 'info', terminal)) }
  else if (e.type === 'turn.completed') { terminal = `Turn complete · ${compact(e.usage)}`; entries.push(entry('info', terminal)) }
  else if (e.type === 'error' || e.type === 'turn.failed') { terminal = `ERROR ${compact(e.message || e.error)}`; entries.push(entry('error', `ERROR ${full(e.message || e.error)}`)) }
  else { terminal = compact(e); entries.push(entry('info', full(e))) }
  Object.defineProperty(entries, 'terminal', { value: terminal })
  return entries
}

export function formatEvent(line) { return eventEntries(line).terminal }

// `<log>.times` holds `<epoch ms> <log bytes>` lines from agent-process.mjs; a missing or bad file just means no times.
export function readTimes(file) {
  try { return readFileSync(file + '.times', 'utf8').split('\n').map(l => l.split(' ').map(Number)).filter(([at, size]) => at > 0 && size >= 0).map(([at, size]) => ({ at, size })) } catch { return [] }
}
export const timeAt = (index, offset) => index.find(r => r.size > offset)?.at ?? null
// An entry's own time wins; the rest get the time the log first grew past their line's start.
export function fillTimes(entries, index, offset) {
  for (const e of entries) if (e.at == null) { const t = timeAt(index, offset); if (t != null) e.at = new Date(t).toISOString() }
}

const SGR = { sent: 36, received: 32, error: 31, thinking: 2, info: 2 }
export function terminalLine(e, color = false) {
  const text = e.kind === 'thinking' ? `Thinking: ${e.text}` : e.kind === 'sent' || e.kind === 'received' ? compact(e.text, 1000) : e.text
  const paint = (code, s) => color && code ? `\x1b[${code}m${s}\x1b[0m` : s
  const d = new Date(e.at ?? NaN)
  return (isNaN(d) ? '' : paint(2, d.toLocaleTimeString('en-GB', { timeZone: 'Pacific/Auckland', hour12: false })) + ' ') + paint(SGR[e.kind], text)
}

export function followLog(file, emit = text => process.stdout.write(text + '\n'), color = false) {
  let offset = 0, lineStart = 0, pending = '', decoder = new StringDecoder('utf8')
  const poll = () => {
    let fd
    try {
      const size = statSync(file).size
      if (size < offset) { offset = 0; lineStart = 0; pending = ''; decoder = new StringDecoder('utf8') }
      fd = openSync(file, 'r')
      while (offset < size) {
        const buffer = Buffer.alloc(Math.min(65536, size - offset))
        const count = readSync(fd, buffer, 0, buffer.length, offset)
        if (!count) break
        offset += count
        pending += decoder.write(buffer.subarray(0, count))
        const lines = pending.split('\n'); pending = lines.pop()
        const index = lines.length ? readTimes(file) : []
        for (const line of lines) {
          if (line.trim()) { const entries = eventEntries(line); fillTimes(entries, index, lineStart); for (const e of entries) emit(terminalLine(e, color)) }
          lineStart += Buffer.byteLength(line) + 1
        }
      }
    } catch (err) { if (err.code !== 'ENOENT') emit(`Viewer: ${err.message}`) }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  poll()
  const timer = setInterval(poll, 250)
  return () => clearInterval(timer)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('Usage: node agent-view.mjs <log>'); process.exitCode = 1 }
  else { console.log(`Following ${process.argv[2]} · Ctrl+C to close viewer`); followLog(process.argv[2], undefined, Boolean(process.stdout.isTTY) && !process.env.NO_COLOR) }
}
