// MAST CLI trial (operator 2026-10-05): find one function in a big JS file without reading it.
//   node C:/Users/PFrew/Projects/herdr-kanban/scripts/mast.mjs <name> [mast search flags, e.g. -n 1 --file "public/app.js"]
// Keeps the index outside the checkout (temp dir, one per checkout), refreshes it before each
// search and logs each call to _roles/worklog/mast-trial.jsonl for the token comparison.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAST = join(process.env.APPDATA || '', 'npm/node_modules/@spikedpunch/mast/dist/cli/index.js')
const EXCLUDE = 'node_modules/**,dist/**,coverage/**,.next/**,**/*.compiled.js,**/*.min.js,**/*.test.*,**/*.spec.*,e2e/**,tests/**'
const args = process.argv.slice(2)
if (!args.length) { console.error('usage: mast.mjs <name> [mast search flags]'); process.exit(2) }
const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
const root = git.status === 0 ? git.stdout.trim() : process.cwd()
const state = join(tmpdir(), 'mast', createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12))
const mast = (...a) => spawnSync(process.execPath, [MAST, ...a], { encoding: 'utf8', cwd: root })

const prep = existsSync(join(state, 'index.json'))
  ? mast('index', '--incremental', '--state-dir', state, root)
  : mast('init', '--state-dir', state, '--exclude', EXCLUDE, root)
if (prep.status !== 0) { process.stderr.write(prep.stderr || prep.stdout); process.exit(1) }
const out = mast('search', ...args, '--state-dir', state, root)
// Absolute paths are noise for the agent; print them relative to the checkout.
const text = (out.stdout || '').split(root.replace(/\\/g, '/') + '/').join('')
process.stdout.write(text); process.stderr.write(out.stderr || '')
try {
  appendFileSync(new URL('../../_roles/worklog/mast-trial.jsonl', import.meta.url),
    JSON.stringify({ at: new Date().toISOString(), root, args, tokens: Math.round(text.length / 4) }) + '\n')
} catch {}
process.exit(out.status ?? 1)
