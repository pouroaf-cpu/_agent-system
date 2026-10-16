#!/usr/bin/env node
// Runs hkb-cli.mjs. While the board's own code is mid-edit it can fail to load (syntax error,
// missing export) and agents gave up on their handoff (IA135, 2026-10-10). A load error is
// retried every 15 s for 90 s, so the command just finishes once the board is back up.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('./hkb-cli.mjs', import.meta.url))
// The first stack frame inside Node's module loader means nothing in hkb ran yet.
export const loadError = stderr => /^\w*Error\b.*\r?\n\s+at [^\n]*node:internal\/modules\/esm\//m.test(stderr)

// IA266 (2026-10-16): result and finish read their text from stdin when --file is absent. Under an agent's
// shell that stdin can stay open with no data, so the read inside hkb-cli blocked for 600 s. The wrapper
// instead waits for stdin only while it is still arriving (idle timeout), then hands what it got to hkb-cli
// on a pipe that closes. Nothing arriving means no text, and hkb-cli refuses at once with its usage message.
export const readsStdin = args => (args.includes('result') || args.includes('finish')) && !args.includes('--file')
export function readStdinIdle(idleMs = 3000) {
  if (process.stdin.isTTY) return Promise.resolve(undefined)
  return new Promise(done => {
    let data = '', timer
    const finish = () => {
      clearTimeout(timer)
      process.stdin.removeAllListeners('data'); process.stdin.removeAllListeners('end'); process.stdin.removeAllListeners('error')
      process.stdin.pause(); process.stdin.destroy()
      done(data)
    }
    const arm = () => { clearTimeout(timer); timer = setTimeout(finish, idleMs) }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk; arm() })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    arm()
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const input = readsStdin(args) ? await readStdinIdle() : undefined
  for (let tries = 1; ; tries++) {
    const r = spawnSync(process.execPath, [cli, ...args], { input, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'pipe'], encoding: 'utf8', windowsHide: true })
    if (r.status === 0 || !loadError(r.stderr) || tries > 6) {
      process.stderr.write(r.stderr)
      if (r.status !== 0 && loadError(r.stderr)) console.error('hkb: the board code is being updated. Wait 2 minutes and run the same hkb command again; do not report it unless it still fails then.')
      process.exit(r.status ?? 1)
    }
    console.error('hkb: the board code is being updated; retrying in 15 s')
    await new Promise(done => setTimeout(done, 15e3))
  }
}
