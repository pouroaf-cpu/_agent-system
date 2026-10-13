// node --test worktrees-tool-output.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clean, ignoreToolOutput, semanticDirtyFiles } from './lib/worktrees.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe', windowsHide: true })

// Temp checkout with tracked app.js and sub/keep.js, removed afterwards.
function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'hk21-'))
  try {
    git(repo, 'init', '-q')
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'app.js'), 'ok\n')
    writeFileSync(join(repo, 'sub', 'keep.js'), 'ok\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    fn(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

const writeE2eOut = repo => {
  for (const dir of [join(repo, 'e2e-out'), join(repo, 'sub', 'e2e-out')]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(repo, 'e2e-out', 'checkpoint.json'), '{"step":1}\n')
  writeFileSync(join(repo, 'sub', 'e2e-out', 'findings.md'), '# findings\n')
}

test('AC1: untracked e2e-out/ folders (root and nested) do not make a checkout dirty', () => {
  withRepo(repo => {
    writeE2eOut(repo)
    assert.equal(clean(repo), false)
    ignoreToolOutput(repo)
    assert.equal(clean(repo), true)
    assert.deepEqual(semanticDirtyFiles(repo), [])
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
    for (const line of ['.playwright-mcp/', '.impeccable/', '.codex/hooks.json']) assert.ok(exclude.includes(line), line)
  })
})

test('AC2: an untracked source file beside e2e-out/ still makes a checkout dirty', () => {
  withRepo(repo => {
    writeE2eOut(repo)
    writeFileSync(join(repo, 'src.js'), 'x\n')
    ignoreToolOutput(repo)
    assert.equal(clean(repo), false)
    assert.deepEqual(semanticDirtyFiles(repo), ['src.js'])
  })
})

test('AC2: a tracked-file edit still makes a checkout dirty after ignoreToolOutput', () => {
  withRepo(repo => {
    ignoreToolOutput(repo)
    writeFileSync(join(repo, 'app.js'), 'changed\n')
    assert.equal(clean(repo), false)
  })
})
