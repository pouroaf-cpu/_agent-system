// node run-tests.mjs [files...]
// Runs test.mjs and every *.test.mjs here, one process per file, each killed after 60s
// (slow files get longer: worktrees.test.mjs takes 60-90s under load).
// Needs the local TASK-TEMPLATE.md and board.config.json (both git-ignored).
import { readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { availableParallelism } from 'node:os'

const dir = import.meta.dirname
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(dir).filter(f => f === 'test.mjs' || f.endsWith('.test.mjs')).sort()
const args = ['--test', '--test-isolation=none', '--experimental-test-module-mocks', '--test-timeout=60000']
const SLOW = { 'worktrees.test.mjs': 180000 }
const limit = file => SLOW[file] ?? 60000
const run = file => new Promise(done => execFile(process.execPath, [...args, file], { cwd: dir, timeout: limit(file), maxBuffer: 64 << 20 },
  (err, stdout, stderr) => done({ file, err, out: `${stdout}${stderr}` })))

const queue = [...files], results = []
await Promise.all(Array.from({ length: Math.max(1, availableParallelism() - 1) }, async () => {
  while (queue.length) results.push(await run(queue.shift()))
}))

const failed = []
let tests = 0
for (const { file, err, out } of results.sort((a, b) => a.file.localeCompare(b.file))) {
  const count = Number(out.match(/^ℹ tests (\d+)/m)?.[1] ?? 0)
  tests += count
  if (!err) { console.log(`ok    ${file} (${count})`); continue }
  failed.push(file)
  console.log(`FAIL  ${file}${err.killed ? ` (timed out after ${limit(file) / 1000}s)` : ''}\n${out}`)
}
console.log(`\n${files.length} files, ${tests} tests, ${failed.length} failing files${failed.length ? `: ${failed.join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
