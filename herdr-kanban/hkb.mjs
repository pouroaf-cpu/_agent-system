#!/usr/bin/env node
// Runs hkb-cli.mjs. While the board's own code is mid-edit it can fail to load (syntax error,
// missing export) and agents gave up on their handoff (IA135, 2026-10-10). A load error is
// retried every 15 s for 90 s, so the command just finishes once the board is back up.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('./hkb-cli.mjs', import.meta.url))
// The first stack frame inside Node's module loader means nothing in hkb ran yet.
export const loadError = stderr => /^\w*Error\b.*\r?\n\s+at [^\n]*node:internal\/modules\/esm\//m.test(stderr)

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (let tries = 1; ; tries++) {
    const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8' })
    if (r.status === 0 || !loadError(r.stderr) || tries > 6) {
      process.stderr.write(r.stderr)
      if (r.status !== 0 && loadError(r.stderr)) console.error('hkb: the board code is being updated. Wait 2 minutes and run the same hkb command again; do not report it unless it still fails then.')
      process.exit(r.status ?? 1)
    }
    console.error('hkb: the board code is being updated; retrying in 15 s')
    await new Promise(done => setTimeout(done, 15e3))
  }
}
