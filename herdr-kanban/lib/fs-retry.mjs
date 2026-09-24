import { renameSync as fsRename } from 'node:fs'

// Windows refuses a rename while another process (antivirus, an agent's Get-Content,
// another board process) has the target open. Retry briefly, as graceful-fs does:
// Tradeflow T-43's `hkb done` died half-applied on EPERM renaming .workflow-state.json.
export function renameSync(from, to, { tries = 40, waitMs = 50, rename = fsRename } = {}) {
  for (let i = 1; ; i++) {
    try { return rename(from, to) } catch (err) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
    }
  }
}
