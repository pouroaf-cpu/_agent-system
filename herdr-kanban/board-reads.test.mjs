// A poll reads the board once, not per queued card and registry entry (audit 2026-09-26 finding 6:
// about 100 board reads per Injectbuddy poll starved the event loop).
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const real = await import('./lib/cards.mjs')
let reads = 0
mock.module('./lib/cards.mjs', { namedExports: {
  ...real,
  readBoard: (...args) => { reads++; return real.readBoard(...args) },
  findCard: (...args) => { reads++; return real.findCard(...args) },
} })
const { autoSpawn, holdsFor } = await import('./lib/autospawn.mjs')

const norm = p => resolve(p).replaceAll('\\', '/').toLowerCase()
const card = (id) => `# ${id} — Card\n\n**Workflow:** card-owned\n**Workspace:** .\n\n## Files\n\n- \`app.js\`\n\n## Approved brief\n\nDo it.\n\n## Implementation plan\n\nChange it.\n\n## Acceptance criteria\n\n- AC1: done\n`

test('one autoSpawn pass reads the board a constant number of times, however many cards wait', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-reads-')), tasks = join(root, 'TASKS'), project = join(root, 'project')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const d of ['queue', 'working', 'archive']) mkdirSync(join(tasks, d), { recursive: true })
  mkdirSync(project)
  const registry = {}
  const add = (id, column) => {
    writeFileSync(join(tasks, column, `${id}-card.md`), card(id))
    registry[id] = { cardId: id, state: 'building', integrationWorkspace: project, files: [norm(join(project, 'app.js'))] }
  }
  for (let i = 1; i <= 5; i++) add(`T-${i}`, 'working')
  add('T-9', 'archive') // Injectbuddy I184/I191: archived, still 'building' in the registry
  for (let i = 11; i <= 20; i++) writeFileSync(join(tasks, 'queue', `T-${i}-card.md`), card(`T-${i}`))
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify(registry))

  reads = 0
  await autoSpawn({ project: 'reads', projectPath: project, tasksDir: tasks, boardRoot: root, model: 'm', agents: [], max: 5, gitSettings: {}, spawn: async () => { throw new Error('must not start') } })
  assert.equal(Object.keys(holdsFor('reads')).length, 10)
  assert.match(holdsFor('reads')['T-11'], /^files busy, held by T-1 — app\.js/)
  assert.ok(reads <= 3, `board read ${reads} times`)
})
