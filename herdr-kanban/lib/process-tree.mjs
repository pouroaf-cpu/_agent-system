import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const powershell = script => {
  const result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 })
  result.child.stdin.end(`${script}\n`)
  return result
}

async function listProcesses() {
  if (process.platform !== 'win32') return []
  const { stdout } = await powershell("@(Get-CimInstance Win32_Process | Where-Object { try { -not [System.Diagnostics.Process]::GetProcessById($_.ProcessId).HasExited } catch { $false } } | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parent';e={$_.ParentProcessId}},@{n='started';e={$_.CreationDate.ToFileTimeUtc().ToString()}},@{n='name';e={$_.Name}}) | ConvertTo-Json -Compress")
  return JSON.parse(stdout || '[]')
}

async function killProcesses(rows) {
  if (!rows.length) return
  // Recheck creation time at the kill boundary: a vanished process's PID may be reused.
  const script = rows.map(p => `$target = Get-CimInstance Win32_Process -Filter 'ProcessId = ${p.pid}'; if ($target -and $target.CreationDate.ToFileTimeUtc().ToString() -eq '${p.started}') { try { Stop-Process -Id ${p.pid} -Force -ErrorAction Stop } catch { $remaining = Get-CimInstance Win32_Process -Filter 'ProcessId = ${p.pid}'; if ($remaining -and $remaining.CreationDate.ToFileTimeUtc().ToString() -eq '${p.started}') { throw } } }`).join('\n')
  await powershell(script)
}

const identity = p => `${p.pid}:${p.started}`
const valid = p => Number.isInteger(p.pid) && p.pid > 0 && /^\d+$/.test(String(p.started))

// Remember descendants while their pane lives, including children whose parent later exits.
export class PaneProcessTrees {
  constructor({ list = listProcesses, kill = killProcesses, boardPid = process.pid } = {}) {
    this.list = list
    this.kill = kill
    this.boardPid = boardPid
    this.panes = new Map()
  }

  async observe(panes) {
    const rows = await this.list()
    const protectedPids = new Set(rows.filter(p => /^herdr(?:\.exe)?$/i.test(p.name)).map(p => p.pid))
    for (let pid = this.boardPid; pid && !protectedPids.has(pid); pid = rows.find(p => p.pid === pid)?.parent) protectedPids.add(pid)
    for (const { key, shellPid } of panes) {
      let tree = this.panes.get(key)
      if (!tree) {
        const root = rows.find(p => p.pid === shellPid)
        if (!root || !valid(root) || protectedPids.has(root.pid)) continue
        tree = new Map([[identity(root), root]])
        this.panes.set(key, tree)
      }
      // Once reuse is observed, the old PID can never establish ancestry again.
      for (const [id, p] of tree) if (rows.some(row => row.pid === p.pid && identity(row) !== id)) tree.delete(id)
      const owned = new Set(rows.filter(p => tree.has(identity(p))).map(p => p.pid))
      for (const p of tree.values()) if (!rows.some(row => row.pid === p.pid)) owned.add(p.pid)
      let changed = true
      while (changed) {
        changed = false
        for (const row of rows) {
          if (!valid(row) || protectedPids.has(row.pid) || owned.has(row.pid) || !owned.has(row.parent)) continue
          const parent = rows.find(p => p.pid === row.parent) ?? [...tree.values()].find(p => p.pid === row.parent)
          if (BigInt(row.started) < BigInt(parent.started)) continue
          tree.set(identity(row), row)
          owned.add(row.pid)
          changed = true
        }
      }
    }
    return rows.filter(p => !protectedPids.has(p.pid))
  }

  async close(key) {
    const tree = this.panes.get(key)
    if (!tree) return
    let previous = new Set()
    while (true) {
      const rows = await this.observe([...this.panes.keys()].map(key => ({ key })))
      // Children first; explicitly killing each identity also works when a parent is gone.
      const live = new Map(rows.map(p => [identity(p), p]))
      const targets = [...tree.keys()].reverse().filter(id => live.has(id)).map(id => live.get(id))
      if (!targets.length) break
      if (targets.some(p => previous.has(identity(p)))) throw new Error(`pane process cleanup did not terminate ${key}`)
      previous = new Set(targets.map(identity))
      await this.kill(targets)
      // Rescan after killing the shell for children spawned during the first snapshot.
    }
    this.panes.delete(key)
  }

  async sweep(session, liveKeys) {
    for (const key of this.panes.keys()) {
      if (key.startsWith(`${session}/`) && !liveKeys.has(key)) await this.close(key)
    }
  }
}
