// `hkb workspace <id> <path>` changes a card's Workspace with createCard's validation (AC3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCard, findCard } from './lib/cards.mjs'

const hkb = fileURLToPath(new URL('./hkb.mjs', import.meta.url))

test('hkb workspace sets the Workspace and refuses ../', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-workspace-'))
  try {
    const project = join(root, 'Proj'), tasks = join(project, 'TASKS')
    mkdirSync(join(tasks, 'queue'), { recursive: true })
    mkdirSync(join(project, 'app'))
    const card = createCard(tasks, { title: 'Ws', brief: 'x', prefix: 'P' })
    const text = () => readFileSync(findCard(tasks, card.id).path, 'utf8')
    const run = (path) => spawnSync(process.execPath, [hkb, '--tasks', tasks, 'workspace', card.id, path], {
      cwd: project, encoding: 'utf8', windowsHide: true, env: { ...process.env, KANBAN_CONFIG: join(root, 'missing.json') },
    })
    let r = run('app')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Workspace is now app/)
    assert.match(text(), /^\*\*Workspace:\*\* app$/m)
    const before = text()
    r = run('../x')
    assert.equal(r.status, 1)
    assert.equal(text(), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('changing Workspace re-bases Files so each path still names the same file, and refuses a path the new Workspace does not hold', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-workspace-files-'))
  try {
    const project = join(root, 'Proj'), tasks = join(project, 'TASKS')
    mkdirSync(join(tasks, 'queue'), { recursive: true })
    mkdirSync(join(project, 'public', 'legacy', 'a'), { recursive: true })
    mkdirSync(join(project, 'scripts'))
    const card = createCard(tasks, { title: 'Files', brief: 'x', prefix: 'P', workspace: 'public' })
    const path = findCard(tasks, card.id).path
    const card1 = (workspace, files) => `# ${card.id} — Files\n\n**Workspace:** ${workspace}\n\n## Files\n- \`${files[0]}\` lines 1-2, \`x\`: edit\n- \`${files[1]}\` — edit\n\n## Approved brief\n\nDo it.\n`
    const text = () => readFileSync(path, 'utf8')
    const run = (workspace) => spawnSync(process.execPath, [hkb, '--tasks', tasks, 'workspace', card.id, workspace], {
      cwd: project, encoding: 'utf8', windowsHide: true, env: { ...process.env, KANBAN_CONFIG: join(root, 'missing.json') },
    })
    writeFileSync(path, card1('public', ['ib-calc.css', 'legacy/a/index.html']))
    let r = run('.')
    assert.equal(r.status, 0, r.stderr)
    assert.match(text(), /^- `public\/ib-calc\.css` lines 1-2, `x`: edit$/m)
    assert.match(text(), /^- `public\/legacy\/a\/index\.html` — edit$/m)
    r = run('public')
    assert.equal(r.status, 0, r.stderr)
    assert.match(text(), /^- `ib-calc\.css` lines 1-2, `x`: edit$/m)
    assert.match(text(), /^- `legacy\/a\/index\.html` — edit$/m)
    writeFileSync(path, card1('.', ['scripts/x.mjs', 'public/ib-calc.css']))
    const before = text()
    r = run('public')
    assert.equal(r.status, 1)
    assert.match(r.stderr + r.stdout, /does not hold these Files: scripts\/x\.mjs/)
    assert.equal(text(), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
