import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCard, moveCard, findCard, validatePlan } from './lib/cards.mjs'
import { cardFiles } from './lib/review-plan.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kanban-template-'))
try {
  writeFileSync(join(dir, 'PROJECT-CONSTRAINTS.md'), '# Constraints\n\n## all\n\n- Use the project session only.\n\n## ui\n\n- Mobile-first at 390px.\n')
  const card = createCard(dir, { title: 'Center label', brief: 'Center the heading.', category: 'ui', mission: 'CURRENT' })
  const text = readFileSync(card.path, 'utf8')
  assert.match(text, /\*\*Mission:\*\* CURRENT/)
  assert.match(text, /\*\*Category:\*\* ui/)
  assert.match(text, /Use the project session only/)
  assert.match(text, /Mobile-first at 390px/)
  const audit = createCard(dir, { title: 'Audit homepage', brief: 'Audit the homepage.', category: 'ui', audit: 'seo', tools: 'local crawl' })
  const auditText = readFileSync(audit.path, 'utf8')
  assert.match(auditText, /## Project constraints/)
  assert.match(auditText, /Use the project session only/)
  assert.match(auditText, /Mobile-first at 390px/)
  assert.equal(card.category, 'ui')
  assert.equal(card.autoReview, false)
  assert.equal(readFileSync(join(dir, 'TASK-TEMPLATE.md'), 'utf8'), readFileSync(new URL('./TASK-TEMPLATE.md', import.meta.url), 'utf8'))
  assert.throws(() => moveCard(dir, card.id, 'planned'), /fill ## Files/)
  assert.equal(findCard(dir, card.id).column, 'planning')
  const ready = text
    .replace('## Files', '## Files\n- `public/ib-calc.css` — center heading')
    .replace('## Implementation plan', '## Implementation plan\n**Plan readiness:** build-ready\nOutcome: center heading.\nUnchanged constraints: preserve arrow.\nObserved cause: heading lacks centering rule.\nEvidence: inspected current CSS.\nInspected current revision/state: current test fixture.\nChanges: add scoped centering rule.\nCheck: inspect centered heading.\nExpected result: heading centered and arrow unchanged.\nStop rules: stop if CSS target differs.')
    .replace('## Acceptance criteria', '## Acceptance criteria\n- AC1: Heading centered; arrow unchanged.')
    .replace('## Outcome checks', '## Outcome checks\nAC1 | public/ib-calc.css | heading centered, arrow unchanged | removing rule fails')
    .replace('## Prerequisites', '## Prerequisites\nNone; CSS fixture only.')
  validatePlan(ready.replace(/\n/g, '\r\n'))
  assert.throws(() => validatePlan(ready
    .replace('**Trivial:** no', '**Trivial:** yes')
    .replace('- `public/ib-calc.css` — center heading', '- `public/ib-calc.css` — center heading\n- `public/a.css` — copy\n- `public/b.css` — copy')),
  /no more than two files/)
  assert.throws(() => validatePlan(ready.replace('public/ib-calc.css', '../outside.css')), /exact relative/)
  assert.throws(() => createCard(dir, { title: 'Bad category', brief: 'No.', category: 'seo' }), /Category must be one of/)
  writeFileSync(card.path, ready)
  assert.deepEqual(cardFiles(card.path), ['public/ib-calc.css'])
  moveCard(dir, card.id, 'planned')
  assert.equal(moveCard(dir, card.id, 'queue').column, 'queue')
  console.log('Template creation, rejected incomplete handoff, file parsing and ready handoff passed.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
