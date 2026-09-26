import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Agents start servers (`next dev`, `next start`) for their checks and sometimes leave
// them running after their pane closes. The server keeps its port and locks files in the
// worktree (Tradeflow TF66: port 3100 held by TF63's `next start`; Injectbuddy I165).
// A server started with a relative path (`node --env-file=... node_modules/next/dist/bin/next`)
// has no worktree path in its command line, so its working directory is matched too. Killing
// the tree also stops Next's workers, which resolve into the junctioned node_modules elsewhere.
export function stopServersIn(dir, { list = () => nodeProcesses({ cwd: true }), kill = killTree } = {}) {
  const needle = resolve(dir).toLowerCase()
  const inside = s => `${s.toLowerCase().replaceAll('/', '\\')}\\`.includes(`${needle}\\`)
  const hits = list().filter(p => p.pid !== process.pid && (inside(p.cmd) || inside(p.cwd || '')))
  for (const p of hits) try { kill(p.pid) } catch {}
  return hits.map(p => p.pid)
}

function killTree(pid) {
  spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 20000 })
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

// Windows exposes no process working directory, so it is read from the process's PEB
// (x64: PEB+0x20 -> ProcessParameters, +0x38 -> CurrentDirectory.DosPath). "" when unreadable.
const LIST_NODE_CWD = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class ProcCwd {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr at, byte[] buf, int size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr[] info, int size, out int len);
  static byte[] Read(IntPtr h, long at, int n) { var b = new byte[n]; IntPtr r; if (!ReadProcessMemory(h, new IntPtr(at), b, n, out r)) throw new Exception(); return b; }
  public static string Of(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      var pbi = new IntPtr[6]; int len;
      if (NtQueryInformationProcess(h, 0, pbi, IntPtr.Size * 6, out len) != 0) return "";
      long pp = BitConverter.ToInt64(Read(h, pbi[1].ToInt64() + 0x20, 8), 0);
      var dir = Read(h, pp + 0x38, 16);
      return Encoding.Unicode.GetString(Read(h, BitConverter.ToInt64(dir, 8), BitConverter.ToUInt16(dir, 0)));
    } catch { return ""; } finally { CloseHandle(h); }
  }
}
'@
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; CommandLine = $_.CommandLine; KernelModeTime = $_.KernelModeTime; UserModeTime = $_.UserModeTime; Cwd = [ProcCwd]::Of($_.ProcessId) } } | ConvertTo-Json -Compress`

function nodeProcesses({ cwd = false } = {}) {
  if (process.platform !== 'win32') return []
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cwd ? LIST_NODE_CWD : LIST_NODE], { encoding: 'utf8', timeout: 20000 })
  let rows = []
  try { rows = [JSON.parse(r.stdout || '[]')].flat() } catch {}
  // Kernel/user times are in 100 ns units.
  return rows.map(p => ({ pid: p.ProcessId, cmd: p.CommandLine || '', cwd: p.Cwd || '', cpuSeconds: (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e7 }))
}
