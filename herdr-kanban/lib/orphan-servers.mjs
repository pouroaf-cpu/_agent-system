import { spawnSync, execFile } from 'node:child_process'
import { resolve } from 'node:path'

// Agents start servers (`next dev`, `next start`) for their checks and sometimes leave
// them running after their pane closes. The server keeps its port and locks files in the
// worktree (Tradeflow TF66: port 3100 held by TF63's `next start`; Injectbuddy I165).
// A server started with a relative path (`node --env-file=... node_modules/next/dist/bin/next`)
// has no worktree path in its command line, so its working directory is matched too. Killing
// the tree also stops Next's workers, which resolve into the junctioned node_modules elsewhere.
export function stopServersIn(dir, { list = () => nodeProcesses({ cwd: true }), kill = killTree } = {}) {
  const hits = matchServersIn(list(), dir)
  for (const p of hits) try { kill(p.pid) } catch {}
  return hits.map(p => p.pid)
}

// Same match, with the listing and kill awaited. autospawn calls this when an agent finishes, on the
// board's event loop; the sync listing blocked it for as long as PowerShell took (up to 20 s per card).
export async function stopServersInAsync(dir, { list = () => nodeProcessesAsync({ cwd: true }), kill = killTreeAsync } = {}) {
  const hits = matchServersIn(await list(), dir)
  for (const p of hits) try { await kill(p.pid) } catch {}
  return hits.map(p => p.pid)
}

function matchServersIn(rows, dir) {
  const needle = resolve(dir).toLowerCase()
  const inside = s => `${s.toLowerCase().replaceAll('/', '\\')}\\`.includes(`${needle}\\`)
  const runs = testRunPids(rows)
  return rows.filter(p => p.pid !== process.pid && !runs.has(p.pid) && (inside(p.cmd) || inside(p.cwd || '')))
}

// A board test run (test-handoff-runner.mjs) outlives the Builder session that submitted it, and its
// Playwright workers inherit the worktree as cwd. The sweep when that session exits matched them and
// killed the run 14-20 s after submit (IA235 and IA236, 2026-10-15). The runner and all it started are never swept.
function testRunPids(rows) {
  const kids = new Map()
  for (const p of rows) if (p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) || []), p.pid])
  const out = new Set()
  const walk = pid => { if (out.has(pid)) return; out.add(pid); for (const k of kids.get(pid) || []) walk(k) }
  for (const p of rows) if (/test-handoff-runner\.mjs/i.test(p.cmd)) walk(p.pid)
  return out
}

function killTree(pid) {
  spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 20000, windowsHide: true })
}

// Operator-chat e2e runs work in C:/Users/PFrew/claude-e2e-* (outside the board) and leave
// their `next dev`/`next start` running for a day (3 servers, ~2.1 GB, efficiency audit
// 2026-10-03 F2). A server there older than maxAgeMs is abandoned: stop its tree.
export async function stopStaleE2eServers({ maxAgeMs = 4 * 3600e3, now = Date.now(), list = () => nodeProcessesAsync({ cwd: true }), kill = killTreeAsync } = {}) {
  const e2e = p => /[\\/]claude-e2e-/i.test(p.cwd || '') || /[\\/]claude-e2e-/i.test(p.cmd)
  const hits = (await list()).filter(p => p.pid !== process.pid && /\bnext\b/i.test(p.cmd) && e2e(p) && p.created && now - p.created > maxAgeMs)
  for (const p of hits) try { await kill(p.pid) } catch {}
  return hits.map(p => p.pid)
}

// An editor's tsserver opened on a board project folder indexes TASKS/.evidence (browser
// profiles, captures) and spins for hours: 10 CPU-hours on KanbanProjects/Injectbuddy
// (2026-09-25) and on Tradeflow-t30 (2026-09-24). Its client restarts it on demand.
export async function stopRunawayTsservers(root, { maxCpuSeconds = 2 * 3600, list = () => nodeProcessesAsync(), kill = pid => process.kill(pid) } = {}) {
  const needle = resolve(root).toLowerCase()
  const hits = (await list()).filter(p => p.cpuSeconds > maxCpuSeconds && /tsserver\.js/i.test(p.cmd) && p.cmd.toLowerCase().replaceAll('/', '\\').includes(needle))
  for (const p of hits) try { await kill(p.pid) } catch {}
  return hits.map(p => p.pid)
}

// JSON, because PowerShell wraps long plain-text lines at the console width.
const LIST_NODE = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine, KernelModeTime, UserModeTime | ConvertTo-Json -Compress`

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
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CommandLine = $_.CommandLine; KernelModeTime = $_.KernelModeTime; UserModeTime = $_.UserModeTime; Created = [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds(); Cwd = [ProcCwd]::Of($_.ProcessId) } } | ConvertTo-Json -Compress`

function nodeProcesses({ cwd = false } = {}) {
  if (process.platform !== 'win32') return []
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cwd ? LIST_NODE_CWD : LIST_NODE], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  let rows = []
  try { rows = [JSON.parse(r.stdout || '[]')].flat() } catch {}
  return rows.map(toNodeRow)
}

// Kernel/user times are in 100 ns units.
function toNodeRow(p) {
  return { pid: p.ProcessId, ppid: Number(p.ParentProcessId) || null, cmd: p.CommandLine || '', cwd: p.Cwd || '', cpuSeconds: (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e7, created: Number(p.Created) || null }
}

// The sweep's listings run async. Each PowerShell start takes seconds on a loaded PC (LIST_NODE_CWD
// also compiles C# every time), and spawnSync held the board's event loop for all of it: every
// board stall on 2026-10-15 (21:14, 21:33, 23:20, 23:44 NZ) came after a sweep tick. Resolves ''
// on failure, as the sync listings return no rows.
function psAsync(script) {
  return new Promise(done => execFile('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) => done(String(out || ''))))
}

async function nodeProcessesAsync({ cwd = false } = {}) {
  if (process.platform !== 'win32') return []
  let rows = []
  try { rows = [JSON.parse(await psAsync(cwd ? LIST_NODE_CWD : LIST_NODE) || '[]')].flat() } catch {}
  return rows.map(toNodeRow)
}

function killTreeAsync(pid) {
  return new Promise(done => execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 20000, windowsHide: true }, () => done()))
}

// A Playwright WebKit check leaves WebKitNetworkProcess.exe behind when its browser is killed
// rather than closed: 8 of them, ~250 MB of commit each, were up to 7 h old when the PC ran out
// of virtual memory and the board died (2026-10-10 22:43). One whose parent is gone, or whose
// parent's pid now belongs to a younger process, has no browser left to serve. minAgeMs leaves a
// browser that is still starting or closing alone.
// Returns only the pids that are gone afterwards, so the log never claims a stop that did not happen.
export async function stopOrphanWebKit({ minAgeMs = 10 * 60000, now = Date.now(), list = allProcessesAsync, kill = cimTerminateAsync } = {}) {
  const all = await list(), byPid = new Map(all.map(p => [p.pid, p]))
  const orphan = p => { const parent = byPid.get(p.ppid); return !parent || parent.created > p.created }
  const hits = all.filter(p => /^WebKit\w*\.exe$/i.test(p.name) && p.created && now - p.created > minAgeMs && orphan(p)).map(p => p.pid)
  if (!hits.length) return []
  try { await kill(hits) } catch {}
  const left = new Set((await list()).map(p => p.pid))
  return hits.filter(pid => !left.has(pid))
}

// taskkill and Stop-Process both answered "no running instance" for these orphans while they still
// held their commit; the CIM Terminate call ended them (2026-10-10).
function cimTerminateAsync(pids) {
  return new Promise(done => execFile('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "${pids.map(pid => `ProcessId=${Number(pid)}`).join(' or ')}" | Invoke-CimMethod -MethodName Terminate | Out-Null`], { timeout: 20000, windowsHide: true }, () => done()))
}

const LIST_ALL = `Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; Created = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } } } | ConvertTo-Json -Compress`

async function allProcessesAsync() {
  if (process.platform !== 'win32') return []
  try { return [JSON.parse(await psAsync(LIST_ALL) || '[]')].flat().map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name || '', cmd: p.CommandLine || '', created: Number(p.Created) || 0 })) } catch { return [] }
}

// Reads a process's environment block from its PEB (x64: PEB+0x20 -> ProcessParameters, +0x80 -> Environment)
// and returns the process's BOARD_AGENT_ID value only when it equals the agent id passed in. Values are never printed.
// The block is NUL-separated; the NUL pair is built with new string() so no escape sequence is needed in this JS template.
const PROC_ENV_CS = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class ProcEnv {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr at, byte[] buf, int size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr[] info, int size, out int len);
  static bool Read(IntPtr h, long at, byte[] b, int n) { IntPtr r; return ReadProcessMemory(h, new IntPtr(at), b, n, out r) && r.ToInt64() == n; }
  public static string Of(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var pbi = new IntPtr[6]; int len;
      if (NtQueryInformationProcess(h, 0, pbi, IntPtr.Size * 6, out len) != 0) return null;
      var word = new byte[8];
      if (!Read(h, pbi[1].ToInt64() + 0x20, word, 8)) return null;
      long pp = BitConverter.ToInt64(word, 0);
      if (!Read(h, pp + 0x80, word, 8)) return null;
      long at = BitConverter.ToInt64(word, 0);
      string nul2 = new string((char)0, 2);
      var block = new StringBuilder();
      for (int i = 0; i < 64; i++) {
        int chunk = (int)(4096 - (at % 4096));
        var buf = new byte[chunk];
        if (!Read(h, at, buf, chunk)) break;
        string s = Encoding.Unicode.GetString(buf);
        int end = s.IndexOf(nul2, StringComparison.Ordinal);
        if (end >= 0) { block.Append(s, 0, end + 1); break; }
        block.Append(s); at += chunk;
      }
      return block.ToString();
    } catch { return null; } finally { CloseHandle(h); }
  }
}
'@
`

// Only the agent's own marker is listed. The script takes the id from the caller, which has checked it is
// plain letters, digits, '-' or '_'.
const agentMarkedScript = agentId => `${PROC_ENV_CS}$m = 'BOARD_AGENT_ID=${agentId}'
Get-CimInstance Win32_Process | ForEach-Object { $e = [ProcEnv]::Of([int]$_.ProcessId); if ($e -and (($e -split [char]0) -contains $m)) { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; Created = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } } } } | ConvertTo-Json -Compress`

async function agentMarkedProcessesAsync(agentId) {
  if (process.platform !== 'win32') return []
  try { return [JSON.parse(await psAsync(agentMarkedScript(agentId)) || '[]')].flat().map(p => ({ pid: p.ProcessId, ppid: Number(p.ParentProcessId) || null, name: p.Name || '', cmd: p.CommandLine || '', created: Number(p.Created) || 0 })) } catch { return [] }
}

// Operator processes that a board agent's leftovers must never take with them: the Expo and basic-memory
// tools the operator runs, the board server and the agent supervisors, and the test runner (see testRunPids).
const PROTECTED = /basic[-_]memory|\bexpo\b|server\.mjs|agent-process\.mjs|test-handoff-runner\.mjs/i

// A board agent's supervisor stamps BOARD_AGENT_ID into the agent's environment (headless.mjs agentPrompt).
// Every process the agent starts inherits it, even after its parent exits, so the marker finds the
// leftovers that the tree snapshots miss (a grandchild born and orphaned between two 30 s snapshots).
// Runs when the turn ends, from the supervisor. Test runs that outlive the Builder session keep running.
// Returns the pids it issued a kill for (no re-list after the kill).
export async function stopAgentLeftovers(agentId, { list = agentMarkedProcessesAsync, kill = killTreeAsync } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId || '')) return []
  const rows = await list(agentId)
  const runs = testRunPids(rows)
  const hits = rows.filter(p => p.pid !== process.pid && !runs.has(p.pid) && !PROTECTED.test(p.cmd))
  for (const p of hits) try { await kill(p.pid) } catch {}
  return hits.map(p => p.pid)
}

// A helper the agent started and left behind has no one to report to once its parent is gone. A find
// ran for 2 h on 2026-10-16 with no parent, and KM ended it by hand. Only these four programs are considered.
// node.exe needs a board path in its command line, so an operator dev server in a non-board folder is left alone.
const LEFTOVER_NAMES = /^(find|python|bash|node)\.exe$/i
const BOARD_PATH = /KanbanProjects|herdr-kanban|\.kanban-worktrees|\.worktrees/i

// Ends leftovers whose parent is gone (or whose parent pid now belongs to a younger process) and that are
// older than minAgeMs. Returns { pid, name, cmd } only for pids that are gone afterwards, so the log never
// claims a stop that did not happen.
export async function stopDeadParentLeftovers({ minAgeMs = 10 * 60000, now = Date.now(), list = allProcessesAsync, kill = killTreeAsync } = {}) {
  const all = await list(), byPid = new Map(all.map(p => [p.pid, p]))
  const runs = testRunPids(all)
  const orphan = p => { const parent = byPid.get(p.ppid); return !parent || parent.created > p.created }
  const hits = all.filter(p => p.pid !== process.pid && !runs.has(p.pid) && LEFTOVER_NAMES.test(p.name) && p.created && now - p.created > minAgeMs && orphan(p) && !PROTECTED.test(p.cmd) && (!/^node\.exe$/i.test(p.name) || BOARD_PATH.test(p.cmd)))
  if (!hits.length) return []
  for (const p of hits) try { await kill(p.pid) } catch {}
  const left = new Set((await list()).map(p => p.pid))
  return hits.filter(p => !left.has(p.pid)).map(p => ({ pid: p.pid, name: p.name, cmd: p.cmd }))
}

// Free commit (RAM + pagefile), the limit Windows kills at; os.freemem() is RAM only.
// Rejects when it cannot be read.
export function freeCommitGb() {
  return new Promise((done, fail) => execFile('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory'], { timeout: 20000, windowsHide: true }, (err, out) => {
    const kb = Number(String(out).trim())
    err || !kb ? fail(err || new Error('free commit unreadable')) : done(kb / 1024 / 1024)
  }))
}
