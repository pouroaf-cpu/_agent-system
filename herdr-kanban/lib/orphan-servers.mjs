import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Agents start servers (`next dev`, `next start`) for their checks and sometimes leave
// them running after their pane closes. The server keeps its port and locks files in the
// worktree (Tradeflow TF66: port 3100 held by TF63's `next start`; Injectbuddy I165).
// ponytail: matches node processes by command-line path only; one started with a relative path is missed.
export function stopServersIn(dir, { list = nodeProcesses, kill = pid => process.kill(pid) } = {}) {
  const needle = resolve(dir).toLowerCase()
  const hits = list().filter(p => p.pid !== process.pid && p.cmd.toLowerCase().replaceAll('/', '\\').includes(needle))
  for (const p of hits) try { kill(p.pid) } catch {}
  return hits.map(p => p.pid)
}

// JSON, because PowerShell wraps long plain-text lines at the console width.
const LIST_NODE = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`

function nodeProcesses() {
  if (process.platform !== 'win32') return []
  const r = spawnSync('powershell', ['-NoProfile', '-Command', LIST_NODE], { encoding: 'utf8', timeout: 20000 })
  let rows = []
  try { rows = [JSON.parse(r.stdout || '[]')].flat() } catch {}
  return rows.map(p => ({ pid: p.ProcessId, cmd: p.CommandLine || '' }))
}
