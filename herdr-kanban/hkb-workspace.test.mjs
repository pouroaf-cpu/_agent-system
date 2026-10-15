// `hkb workspace <id> <path>` changes a card's Workspace with createCard's validation (AC3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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
