import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refusal, commandRefusal } from './bin/npm-guard.mjs'

// Builders ran `npm ci` through a card's node_modules junction and emptied the shared
// install for every card (Tradeflow TF103/TF105, 2026-09-27).
test('npm installs are refused under a node_modules junction and allowed in a normal folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'npm-guard-'))
  try {
    const card = join(root, 'card'), plain = join(root, 'plain')
    mkdirSync(join(root, 'shared', 'node_modules'), { recursive: true })
    mkdirSync(join(card, 'src'), { recursive: true })
    mkdirSync(join(plain, 'node_modules'), { recursive: true })
    symlinkSync(join(root, 'shared', 'node_modules'), join(card, 'node_modules'), 'junction')
    assert.match(refusal(card, ['ci']), /^npm ci refused: node_modules here is the shared install link/)
    assert.match(refusal(join(card, 'src'), ['--silent', 'install', 'x']), /^npm install refused/)
    assert.equal(refusal(card, ['--version']), null)
    assert.equal(refusal(card, ['run', 'build']), null)
    assert.equal(refusal(plain, ['ci']), null)
    // Claude's PowerShell hook: same rule, following a Set-Location in the command.
    assert.match(commandRefusal(`Set-Location '${join(card, 'src')}'; npm.cmd ci`, plain), /npm ci refused/)
    assert.match(commandRefusal('npm test && npm i left-pad', card), /npm i refused/)
    assert.equal(commandRefusal('npm run build; git status', card), null)
    assert.equal(commandRefusal(`cd ${plain} && npm ci`, card), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('board Claude agents load the npm guard for Bash and PowerShell', () => {
  const hooks = JSON.parse(readFileSync(new URL('./claude-agent-settings.json', import.meta.url), 'utf8')).hooks
  assert.match(JSON.stringify(hooks.SessionStart), /npm-guard\.mjs --env/)
  assert.equal(hooks.PreToolUse.find(h => /npm-guard\.mjs --hook/.test(JSON.stringify(h)))?.matcher, 'PowerShell')
})
