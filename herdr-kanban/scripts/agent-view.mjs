import { openSync, closeSync, readSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'

const compact = (value, limit = 240) => String(typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').slice(0, limit)
export function formatEvent(line) {
  let e
  try { e = JSON.parse(line) } catch { return line }
  if (!e || typeof e !== 'object') return compact(e)
  if (e.type === 'thread.started') return `Session ${e.thread_id}`
  if (e.type === 'system' && e.subtype === 'init') return `Session ${e.session_id} · ${e.model || 'Claude'}`
  // Bookkeeping the old pane never showed: hooks, token counters, rate limits, heartbeats.
  if (['system', 'rate_limit_event', 'tool_progress', 'stream_event'].includes(e.type) || (e.type === 'thinking' && !e.thinking)) return ''
  if ((e.type === 'assistant' || e.type === 'user') && Array.isArray(e.message?.content)) return e.message.content.map(part => {
    if (part.type === 'text') return part.text
    if (part.type === 'thinking') return part.thinking ? `Thinking: ${part.thinking}` : ''
    if (part.type === 'tool_use') return `→ ${part.name} ${compact(part.input, 1000)}`
    if (part.type === 'tool_result') return `← ${part.is_error ? 'ERROR ' : ''}${compact(part.content)}`
    return compact(part)
  }).join('\n')
  if (e.type?.startsWith('item.')) {
    const item = e.item || {}
    if (item.type === 'agent_message') return item.text || ''
    if (item.type === 'reasoning') return item.text ? `Thinking: ${item.text}` : compact(e)
    const input = item.command || item.arguments || item.input || item.changes || item.query || ''
    const name = item.tool || item.type || 'tool'
    if (e.type === 'item.started') return `→ ${name} ${compact(input, 1000)}`
    return `← ${name} ${compact(input, 400)} [${item.exit_code ?? item.status ?? 'complete'}] ${compact(item.aggregated_output || item.result || item.error || '')}`
  }
  if (e.type === 'result') return `Turn ${e.is_error ? 'ERROR' : 'complete'}${e.result ? `\n${e.result}` : ''}`
  if (e.type === 'turn.completed') return `Turn complete · ${compact(e.usage)}`
  if (e.type === 'error' || e.type === 'turn.failed') return `ERROR ${compact(e.message || e.error)}`
  return compact(e)
}

export function followLog(file, emit = text => process.stdout.write(text + '\n')) {
  let offset = 0, pending = '', decoder = new StringDecoder('utf8')
  const poll = () => {
    let fd
    try {
      const size = statSync(file).size
      if (size < offset) { offset = 0; pending = ''; decoder = new StringDecoder('utf8') }
      fd = openSync(file, 'r')
      while (offset < size) {
        const buffer = Buffer.alloc(Math.min(65536, size - offset))
        const count = readSync(fd, buffer, 0, buffer.length, offset)
        if (!count) break
        offset += count
        pending += decoder.write(buffer.subarray(0, count))
        const lines = pending.split('\n'); pending = lines.pop()
        for (const line of lines) if (line.trim()) { const text = formatEvent(line); if (text) emit(text) }
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
  else { console.log(`Following ${process.argv[2]} · Ctrl+C to close viewer`); followLog(process.argv[2]) }
}
