// Token-efficiency audit (2026-10-12), finding 5: BUILDER.md held stale Codex/restricted-mode
// text and rules already repeated in the runtime prompt. Guards the trimmed size and content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// BUILDER.md is gitignored, so card worktrees lack it; fall back to the live copy on the main checkout.
const local = join(here, '..', '_roles', 'BUILDER.md')
const path = existsSync(local) ? local : 'C:/Users/PFrew/Projects/_roles/BUILDER.md'

test('BUILDER.md stays at or below 7,000 bytes with no stale text', () => {
  const text = readFileSync(path)
  assert.ok(text.length <= 7000, `BUILDER.md is ${text.length} bytes, want <= 7000`)

  const str = text.toString('utf8')
  assert.doesNotMatch(str, /login:false/)
  assert.doesNotMatch(str, /mcp__cua_repl/)
  assert.doesNotMatch(str, /restricted Builder mode/)

  assert.match(str, /Testing is yours now/)
  assert.match(str, /Planned ahead/)
  assert.match(str, /Keep each file's format/)
})
