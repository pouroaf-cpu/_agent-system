// node run-tests.mjs [files...]
// Runs test.mjs and every *.test.mjs here, one process per file on half the cores, each killed
// after 60s. Slow files get longer and start first. worktrees.test.mjs is git processes and no waits
// (86s alone, 98s in the suite) and release.test.mjs builds three origin/clone repos plus a server
// (16s alone, 35s beside a second suite): both only get slower as the machine gets busier.
// Needs the local TASK-TEMPLATE.md and board.config.json (both git-ignored).
import { readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { availableParallelism } from 'node:os'

const dir = import.meta.dirname
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(dir).filter(f => f === 'test.mjs' || f.endsWith('.test.mjs')).sort()
const args = ['--test', '--test-isolation=none', '--experimental-test-module-mocks', '--test-timeout=60000']
const SLOW = { 'worktrees.test.mjs': 300000, 'release.test.mjs': 120000, 'test.mjs': 120000, 'watchdog-herdr.test.mjs': 150000 } // test.mjs: ~35s alone, over 60s while agents build
const limit = file => SLOW[file] ?? 60000
const run = file => { const start = Date.now(); return new Promise(done => execFile(process.execPath, [...args, file], { cwd: dir, timeout: limit(file), maxBuffer: 64 << 20 },
  (err, stdout, stderr) => done({ file, err, out: `${stdout}${stderr}`, secs: Math.round((Date.now() - start) / 1000) }))) }

// Longest first: worktrees.test.mjs started last and alone set the wall time. Half the cores: every
// file spawns git, servers or browsers, and 11 at once only slowed the git-bound files.
const queue = [...files].sort((a, b) => limit(b) - limit(a)), results = []
await Promise.all(Array.from({ length: Math.max(2, availableParallelism() / 2 | 0) }, async () => {
  while (queue.length) results.push(await run(queue.shift()))
}))

const failed = []
let tests = 0
for (const { file, err, out, secs } of results.sort((a, b) => a.file.localeCompare(b.file))) {
  const count = Number(out.match(/^ℹ tests (\d+)/m)?.[1] ?? 0)
  tests += count
  if (!err) { console.log(`ok    ${file} (${count}) ${secs}s`); continue }
  failed.push(file)
  console.log(`FAIL  ${file}${err.killed ? ` (timed out after ${limit(file) / 1000}s)` : ''}\n${out}`)
}
console.log(`\n${files.length} files, ${tests} tests, ${failed.length} failing files${failed.length ? `: ${failed.join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
