// Board activity line for the operator's sidebar log. Fire-and-forget: the board must never
// block on, or die because of, the log sink failing.

import { execFile } from 'node:child_process'

const HERDR = process.env.HERDR_BIN_PATH || 'herdr'

export function boardLog(text, level = 'info') {
  try {
    const child = execFile(
      HERDR,
      ['log', 'append', String(text), '--source', 'kanban', '--level', level],
      { timeout: 5000, windowsHide: true },
      () => {},
    )
    child.on('error', () => {})
    child.unref()
  } catch { /* herdr missing from PATH; the board carries on regardless */ }
}
