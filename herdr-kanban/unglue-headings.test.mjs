import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { unglueHeadings, emptySectionError, findCard } from './lib/cards.mjs'

test('a heading glued to the previous line gets its newline back (I996)', () => {
  const glued = '## Implementation\nStage: builder, Blocker: none## Evidence\nStage: builder, Blocker: none## Reviewer evidence\n<!-- x -->\n'
  const fixed = unglueHeadings(glued)
  assert.match(fixed, /^## Evidence$/m)
  assert.match(fixed, /^## Reviewer evidence$/m)
  assert.equal(unglueHeadings(fixed), fixed)
  assert.equal(unglueHeadings('see ## Notes inline\n'), 'see ## Notes inline\n')
})

test('only a heading glued with no space and ending its line is repaired; prose mentions are untouched', () => {
  for (const prose of ['the ## Implementation and ## Evidence headings\n', 'see the `## Evidence` heading\n', 'ends with ## Reviewer evidence\n', '## Implementation plan\n', 'a ## Evidence section in x\n']) {
    assert.equal(unglueHeadings(prose), prose)
  }
  assert.equal(unglueHeadings('Blocker: none## Evidence\r\nx'), 'Blocker: none\n\n## Evidence\r\nx')
  for (const glued of ['Files: `a.mjs`## Evidence\n', 'Blocker: none## Evidence']) {
    const fixed = unglueHeadings(glued)
    assert.notEqual(fixed, glued)
    assert.match(fixed, /^## Evidence$/m)
    assert.equal(unglueHeadings(fixed), fixed)
  }
})

const resultCard = ({ stage = true, glued = false } = {}) => `# T-1 — task
**Workflow:** card-owned
**Auto-review:** no
**Category:** code
**Workspace:** .
**Workflow version:** 2

## Approved brief
Finding: done rewrites the card and splits the ## Implementation and ## Evidence headings.
Look at the \`## Evidence\` heading, which ends this line: ## Evidence

## Acceptance criteria
- AC1: helper() returns 1.

## Implementation plan
Keep a ## Implementation section and an ## Evidence section apart from the prose.

## Implementation
${stage ? 'Stage: builder\n' : ''}Outcome: PASS
Files: example.js
AC1: node --test -> 1 passed
Blocker: none${glued ? '' : '\n'}
## Evidence
${stage ? 'Stage: builder\n' : ''}Outcome: PASS
Check: node --test
Result: passed; the ## Evidence heading is only named here
Evidence: proof
Blocker: none
`

function doneOn(t, text) {
  const root = mkdtempSync(join(tmpdir(), 'unglue-done-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'working'), { recursive: true })
  writeFileSync(join(tasksDir, 'working', 'T-1.md'), text)
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', tasksDir, 'done', 'T-1'], { encoding: 'utf8' })
  return { result, saved: () => readFileSync(findCard(tasksDir, 'T-1').path, 'utf8') }
}

test('AC1: done keeps prose that names the Implementation and Evidence headings mid-line', t => {
  const text = resultCard()
  const { result, saved } = doneOn(t, text)
  assert.equal(result.status, 0, result.stderr)
  const after = saved()
  for (const line of text.split('\n')) assert.ok(after.includes(line + '\n'), `line changed: ${line}`)
  assert.equal((after.match(/^## Evidence$/gm) ?? []).length, 1)
})

test('AC2: done still refuses a result with no Stage line', t => {
  const { result } = doneOn(t, resultCard({ stage: false }))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /version-2 done result requires Stage:/)
})

test('AC3: done still splits a heading glued at a real section boundary', t => {
  const { result, saved } = doneOn(t, resultCard({ glued: true }))
  assert.equal(result.status, 0, result.stderr)
  assert.match(saved(), /^## Evidence$/m)
})

test('empty section errors point to the first section and mention a later duplicate when present', () => {
  const duplicate = '## Evidence\n<!-- placeholder -->\n## Evidence\nPASS\n'
  const single = '## Evidence\n<!-- placeholder -->\n'
  const duplicateError = emptySectionError('done', 'Evidence', duplicate)
  const singleError = emptySectionError('done', 'Evidence', single)
  assert.match(duplicateError, /first ## Evidence section on the card is empty/)
  assert.match(duplicateError, /later ## Evidence heading is not read and must be moved under the first one/)
  assert.match(duplicateError, /Replace the comment under that existing heading/)
  assert.match(duplicateError, /full logs belong in linked evidence files/i)
  assert.doesNotMatch(singleError, /later ## Evidence heading/)
})
