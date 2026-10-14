// HK25: hkb result writes a Builder's ## Implementation and ## Evidence bodies from text,
// refusing exactly what hkb done refuses (the board no longer asks Builders for a scripted replace).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const IMPL = `<!-- Builder: placeholder -->`
const EVID = `<!-- Builder: placeholder -->`
const card = ({ impl = IMPL, evid = EVID, evidenceHeading = true } = {}) => `# T-1 — card
**Workflow:** card-owned
**Workflow version:** 2
## Approved brief
Keep the brief; it names the sections as see ## Implementation and ## Evidence in prose.
## Acceptance criteria
- AC1: first
- AC2: second
## Implementation
${impl}
## Files
- \`herdr-kanban/x.mjs\`
${evidenceHeading ? `## Evidence\n${evid}\n` : ''}## Reviewer evidence
none yet
## Custom notes
keep  me
`
const FIELDS = {
  Stage: 'Stage: builder',
  Outcome: 'Outcome: PASS',
  Files: 'Files: herdr-kanban/x.mjs',
  Check: 'Check: node run-tests.mjs',
  Result: 'Result: 3 passing',
  Evidence: 'Evidence: TASKS/.evidence/T-1/log.txt',
  Blocker: 'Blocker: none',
}
const text = (skip, { ac2 = true } = {}) => `## Implementation
AC1: node run-tests.mjs a -> 1 passing
${ac2 ? 'AC2: node run-tests.mjs b -> 2 passing\n' : ''}${['Stage', 'Outcome', 'Files'].filter(f => f !== skip).map(f => FIELDS[f]).join('\n')}
## Evidence
${['Check', 'Result', 'Evidence', 'Blocker'].filter(f => f !== skip).map(f => FIELDS[f]).join('\n')}
`

function board(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'result-command-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasks, 'working'), { recursive: true })
  const path = join(tasks, 'working', 'T-1.md')
  writeFileSync(path, body)
  return { tasks, path, root }
}
const hkb = (tasks, opts, ...args) => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', tasks, ...args], { encoding: 'utf8', windowsHide: true, ...opts })
const withoutBodies = s => s.replace(/^(## (?:Implementation|Evidence)\r?\n)[\s\S]*?(?=^## |$(?![\s\S]))/gm, '$1')

test('AC1: result replaces both bodies and leaves every other section byte-identical', t => {
  const { tasks, path, root } = board(t, card())
  const before = readFileSync(path, 'utf8')
  const input = join(root, 'result.md')
  writeFileSync(input, text())
  const r = hkb(tasks, {}, 'result', 'T-1', '--file', input)
  assert.equal(r.status, 0, r.stderr)
  const after = readFileSync(path, 'utf8')
  assert.match(after, /## Implementation\n\nAC1: node run-tests\.mjs a -> 1 passing\nAC2: .*\nStage: builder\nOutcome: PASS\nFiles: herdr-kanban\/x\.mjs\n\n## Files/)
  assert.match(after, /## Evidence\n\nCheck: .*\nResult: .*\nEvidence: .*\nBlocker: none\n\n## Reviewer evidence/)
  assert.doesNotMatch(after, /placeholder/)
  assert.equal(withoutBodies(after), withoutBodies(before), 'only the two bodies changed')
  // second run replaces, never duplicates
  assert.equal(hkb(tasks, {}, 'result', 'T-1', '--file', input).status, 0)
  assert.equal(readFileSync(path, 'utf8'), after)
})

test('AC1: stdin gives the same file, and a missing ## Evidence heading is appended', t => {
  const file = board(t, card())
  const stdin = board(t, card())
  const input = join(file.root, 'result.md')
  writeFileSync(input, text())
  assert.equal(hkb(file.tasks, {}, 'result', 'T-1', '--file', input).status, 0)
  assert.equal(hkb(stdin.tasks, { input: text() }, 'result', 'T-1').status, 0)
  assert.equal(readFileSync(stdin.path, 'utf8'), readFileSync(file.path, 'utf8'))

  const bare = board(t, card({ evidenceHeading: false }))
  const r = hkb(bare.tasks, { input: text() }, 'result', 'T-1')
  assert.equal(r.status, 0, r.stderr)
  const out = readFileSync(bare.path, 'utf8')
  assert.match(out, /\n## Evidence\n\nCheck: node run-tests\.mjs\n/)
  assert.ok(out.startsWith(withoutBodies(card({ evidenceHeading: false })).split('## Implementation')[0]))
  assert.match(out, /## Custom notes\nkeep  me\n/)
})

test('AC1: hkb done is not refused for the Implementation/Evidence sections afterwards', t => {
  const { tasks } = board(t, card())
  assert.equal(hkb(tasks, { input: text() }, 'result', 'T-1').status, 0)
  const done = hkb(tasks, {}, 'done', 'T-1')
  assert.doesNotMatch(done.stderr, /requires a current|result requires|recorded test|requires Stage/)
})

test('AC2: a result missing a required field is refused with the message done gives, card unchanged', t => {
  for (const field of Object.keys(FIELDS)) {
    const mine = board(t, card())
    const before = readFileSync(mine.path, 'utf8')
    const r = hkb(mine.tasks, { input: text(field) }, 'result', 'T-1')
    assert.notEqual(r.status, 0, field)
    assert.equal(readFileSync(mine.path, 'utf8'), before, `${field}: card unchanged`)
    // the same sections on a card hkb done reads
    const [impl, evid] = text(field).split('## Evidence\n')
    const copy = board(t, card({ impl: impl.replace('## Implementation\n', '').trimEnd(), evid: evid.trimEnd() }))
    const done = hkb(copy.tasks, {}, 'done', 'T-1')
    assert.match(done.stderr, new RegExp(`version-2 done result requires ${field}:|done requires Stage: builder and Outcome: PASS`), done.stderr)
    assert.equal(r.stderr, done.stderr, field)
  }
})

test('AC2: a glued heading name is refused (done would split the card there); a spaced prose mention is kept', t => {
  const { tasks, path } = board(t, card())
  const before = readFileSync(path, 'utf8')
  const glued = hkb(tasks, { input: text().replace('Stage: builder', 'Wrote the result.## Evidence\nStage: builder') }, 'result', 'T-1')
  assert.notEqual(glued.status, 0)
  assert.match(glued.stderr, /in the middle of a line/)
  assert.equal(readFileSync(path, 'utf8'), before)
  const prose = hkb(tasks, { input: text().replace('Stage: builder', 'Wrote the ## Evidence text\nStage: builder') }, 'result', 'T-1')
  assert.equal(prose.status, 0, prose.stderr)
  assert.match(readFileSync(path, 'utf8'), /Wrote the ## Evidence text/)
})

test('AC2: a missing AC test line and a one-section text are refused', t => {
  const { tasks, path } = board(t, card())
  const before = readFileSync(path, 'utf8')
  const r = hkb(tasks, { input: text(null, { ac2: false }) }, 'result', 'T-1')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /version-2 done result is missing a recorded test for AC2/)
  const half = hkb(tasks, { input: '## Implementation\nStage: builder\n' }, 'result', 'T-1')
  assert.notEqual(half.status, 0)
  assert.match(half.stderr, /result needs both a ## Implementation and a ## Evidence section/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('AC1: labelled lines with no headings are filed under Implementation and Evidence', t => {
  const { tasks, path } = board(t, card())
  const before = readFileSync(path, 'utf8')
  const bare = text().replace(/^## .*\n/gm, '')
  const r = hkb(tasks, { input: bare }, 'result', 'T-1')
  assert.equal(r.status, 0, r.stderr)
  const after = readFileSync(path, 'utf8')
  assert.match(after, /## Implementation\n\nStage: builder\nOutcome: PASS\nFiles: .*\nBlocker: none\n\n## Files/)
  assert.match(after, /## Evidence\n\nAC1: .*\nAC2: .*\nCheck: .*\nResult: .*\nEvidence: .*\n\n## Reviewer evidence/)
  assert.equal(withoutBodies(after), withoutBodies(before))
  assert.doesNotMatch(hkb(tasks, {}, 'done', 'T-1').stderr, /requires a current|result requires|recorded test|requires Stage/)
})

test('AC2: text with no labelled content is refused and names the missing part', t => {
  const { tasks, path } = board(t, card())
  const before = readFileSync(path, 'utf8')
  const input = 'I finished the work and everything passes.\n'
  const r = hkb(tasks, { input }, 'result', 'T-1')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /result needs both a ## Implementation and a ## Evidence section/)
  const f = hkb(tasks, { input }, 'finish', 'T-1')
  assert.notEqual(f.status, 0)
  assert.match(f.stderr, /requires a current Implementation result/)
  assert.match(f.stderr, /Evidence/)
  assert.equal(readFileSync(path, 'utf8'), before)
})
