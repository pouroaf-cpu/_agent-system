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

// An editor's tsserver opened on a board project folder indexes TASKS/.evidence (browser
// profiles, captures) and spins for hours: 10 CPU-hours on KanbanProjects/Injectbuddy
// (2026-09-25) and on Tradeflow-t30 (2026-09-24). Its client restarts it on demand.
export function stopRunawayTsservers(root, { maxCpuSeconds = 2 * 3600, list = nodeProcesses, kill = pid => process.kill(pid) } = {}) {
  const needle = resolve(root).toLowerCase()
  const hits = list().filter(p => p.cpuSeconds > maxCpuSeconds && /tsserver\.js/i.test(p.cmd) && p.cmd.toLowerCase().replaceAll('/', '\\').includes(needle))
  for (const p of hits) try { kill(p.pid) } catch {}
  return hits.map(p => p.pid)
}

// JSON, because PowerShell wraps long plain-text lines at the console width.
const LIST_NODE = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine, KernelModeTime, UserModeTime | ConvertTo-Json -Compress`

function nodeProcesses() {
  if (process.platform !== 'win32') return []
  const r = spawnSync('powershell', ['-NoProfile', '-Command', LIST_NODE], { encoding: 'utf8', timeout: 20000 })
  let rows = []
  try { rows = [JSON.parse(r.stdout || '[]')].flat() } catch {}
  // Kernel/user times are in 100 ns units.
  return rows.map(p => ({ pid: p.ProcessId, cmd: p.CommandLine || '', cpuSeconds: (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e7 }))
}
