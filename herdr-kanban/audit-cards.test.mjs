import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createCard, findCard, moveCard } from './lib/cards.mjs'
import { auditOutcome, cardReadyFindings } from './lib/audit-routing.mjs'
import { needsAuditMcp } from './lib/audit-mcp.mjs'
import { cardsFromAudit } from './lib/audit-cards.mjs'

const finding = (n, extra = {}) => ({
  n, title: `Problem ${n}`, severity: 'high', priority: 7, category: 'ui', workspace: '.',
  files: [`src/app/page-${n}.tsx`], evidence: [`TASKS/reports/x/evidence/${n}.png`],
  problem: `Problem ${n} observed`, recommendation: `Fix ${n}`, acceptance: [`AC1: ${n} is fixed`], dependsOn: [], ...extra,
})
const report = (list, json = JSON.stringify(list, null, 2)) =>
  `\n## Evidence\nScreenshots in TASKS/reports/x/evidence\n## Findings\n${list.map(f => `${f.n}. ${f.title}\n   - Severity: ${f.severity}`).join('\n')}\n## Card-ready findings\n\`\`\`json\n${json}\n\`\`\`\n## Audit conclusion\nStatus: FINDINGS\n`
const fill = (card, body) => {
  const text = readFileSync(card.path, 'utf8')
  writeFileSync(card.path, text.slice(0, text.indexOf('## Evidence')) + body.trimStart())
}
const fixture = () => mkdtempSync(join(tmpdir(), 'audit-cards-'))

test('general audit template: free-text scope, default headless tools, report-only disposition', () => {
  const dir = fixture()
  try {
    const card = createCard(dir, { title: 'User journey audit', brief: 'Topic: visual flow. Targets: https://example.com/', audit: 'general' })
    const text = readFileSync(card.path, 'utf8')
    assert.equal(card.column, 'review')
    assert.equal(card.audit, 'general')
    assert.match(text, /\*\*Audit disposition:\*\* report-only-await-owner/)
    assert.match(text, /Topic: visual flow/)
    assert.match(text, /## Card-ready findings/)
    assert.ok(needsAuditMcp([card]), 'default tools opt into the scoped chrome-devtools MCP')
    const custom = createCard(dir, { title: 'Copy audit', brief: 'Tone', audit: 'general', tools: 'firecrawl scrape' })
    assert.equal(needsAuditMcp([custom]), false, 'tools can be overridden')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('card-ready findings validate strictly', () => {
  const ok = report([finding(1), finding(2, { dependsOn: [1] })])
  assert.equal(cardReadyFindings(ok).length, 2)
  assert.deepEqual(auditOutcome(ok, 'general'), { status: 'FINDINGS' })
  assert.match(auditOutcome(report([finding(1)], '[{oops'), 'general').reason, /does not parse/)
  assert.match(auditOutcome(ok.replace(/## Card-ready findings[\s\S]*?(?=## Audit)/, ''), 'general').reason, /json block/)
  assert.match(auditOutcome(report([finding(1, { title: 'x'.repeat(121) })]), 'general').reason, /120/)
  assert.match(auditOutcome(report([finding(1, { category: 'seo' })]), 'general').reason, /category/)
  assert.match(auditOutcome(report([finding(1, { dependsOn: [2] }), finding(2, { dependsOn: [1] })]), 'general').reason, /cycle/)
  assert.match(auditOutcome(ok.replace('2. Problem 2', ''), 'general').reason, /must match/)
  assert.deepEqual(auditOutcome(ok.replace(/## Card-ready findings[\s\S]*?(?=## Audit)/, ''), 'design'), { status: 'FINDINGS' }, 'optional for other kinds')
})

test('hkb audit: FINDINGS without valid JSON is INCOMPLETE; valid JSON lands in Owner', () => {
  const dir = fixture()
  const hkb = (id, note) => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', dir, 'audit', id, note], { encoding: 'utf8' })
  try {
    const card = createCard(dir, { title: 'Journey', brief: 'Visual flow', audit: 'general' })
    fill(card, report([finding(1)], 'not json'))
    assert.equal(hkb(card.id, 'FINDINGS').status, 0)
    const held = findCard(dir, card.id)
    assert.equal(held.column, 'review')
    assert.match(readFileSync(held.path, 'utf8'), /Kicked back: INCOMPLETE: FINDINGS not card-ready: Card-ready findings JSON does not parse/)
    fill(held, report([finding(1)]))
    assert.equal(hkb(card.id, 'FINDINGS').status, 0)
    assert.equal(findCard(dir, card.id).column, 'owner')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('audit-cards: Blocked by, links, idempotency, decline and archive', () => {
  const dir = fixture()
  try {
    const audit = createCard(dir, { title: 'Journey', brief: 'Visual flow', audit: 'general', prefix: 'I' })
    fill(audit, report([finding(1), finding(2, { dependsOn: [1], category: 'code', workspace: 'app', priority: 3 }), finding(3, { severity: 'low' })]))
    assert.throws(() => cardsFromAudit(dir, { id: audit.id, findings: 'all', prefix: 'I' }), /Owner or Planning/)
    moveCard(dir, audit.id, 'owner')

    const first = cardsFromAudit(dir, { id: audit.id, findings: [1, 2], prefix: 'I' })
    assert.equal(first.created.length, 2)
    assert.equal(first.archived, false)
    assert.deepEqual(first.remaining, [3])
    const [c1, c2] = first.created.map(({ id }) => findCard(dir, id))
    assert.equal(c1.column, 'planning')
    assert.equal(c1.title, 'Problem 1')
    assert.equal(c2.category, 'code')
    assert.equal(c2.workspace, 'app')
    assert.equal(c2.priority, 3)
    assert.deepEqual(c2.blockedBy, [c1.id])
    assert.match(readFileSync(c2.path, 'utf8'), new RegExp(`Source: ${audit.id} finding 2`))
    assert.match(readFileSync(c2.path, 'utf8'), /- AC1: 2 is fixed/)
    assert.match(readFileSync(findCard(dir, audit.id).path, 'utf8'), new RegExp(`- F1: ${c1.id}\\n- F2: ${c2.id}`))

    const again = cardsFromAudit(dir, { id: audit.id, findings: 'all', decline: [3], reason: 'Not worth it now', prefix: 'I' })
    assert.deepEqual(again.created, [], 'already linked findings are never duplicated')
    assert.equal(again.archived, true)
    const archived = findCard(dir, audit.id)
    assert.equal(archived.column, 'archive')
    assert.match(readFileSync(archived.path, 'utf8'), /- F3: declined — Not worth it now/)
    assert.equal(cardsFromAudit(dir, { id: audit.id, findings: 'all', prefix: 'I' }).created.length, 0)
    assert.throws(() => cardsFromAudit(dir, { id: c1.id, findings: 'all' }), /not an audit/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('audit-cards: off-board report.md source links in the report and never archives', () => {
  const dir = fixture()
  try {
    const path = join(dir, 'report.md')
    const shot = join(dir, 'evidence', '1.png').replaceAll('\\', '/')
    mkdirSync(join(dir, 'evidence')); writeFileSync(shot, 'png')
    writeFileSync(path, `# Journey audit\n\nAudit ID: 2026-09-24-injectbuddy-journey\n${report([finding(1, { evidence: [shot] }), finding(2, { dependsOn: [1] })])}`)
    const first = cardsFromAudit(dir, { report: path, findings: [1, 2], prefix: 'I' })
    assert.equal(first.audit, '2026-09-24-injectbuddy-journey')
    assert.deepEqual(first.remaining, [])
    assert.equal(first.archived, false, 'the orchestrator archives report folders')
    assert.match(readFileSync(path, 'utf8'), /## Remediation links[\s\S]*- F1: I-?\d+[\s\S]*- F2: I-?\d+/)
    assert.match(readFileSync(findCard(dir, first.created[1].id).path, 'utf8'), new RegExp(String.raw`Blocked by:\*\* ${first.created[0].id}`))
    assert.match(readFileSync(findCard(dir, first.created[0].id).path, 'utf8'), /Source: 2026-09-24-injectbuddy-journey finding 1/)
    // Evidence is copied into the project so archiving the audit folder never breaks the card.
    const local = join(dir, '.evidence', '2026-09-24-injectbuddy-journey', 'evidence', '1.png').replaceAll('\\', '/')
    assert.equal(readFileSync(local, 'utf8'), 'png')
    assert.ok(readFileSync(findCard(dir, first.created[0].id).path, 'utf8').includes(`- ${local}`))
    assert.equal(cardsFromAudit(dir, { report: path, findings: 'all', prefix: 'I' }).created.length, 0)
    const legacy = join(dir, 'legacy.md')
    writeFileSync(legacy, `# Old\n\nStatus: FINDINGS\n${report([finding(1)]).replace(/## Audit conclusion[\s\S]*$/, '')}`)
    assert.equal(cardsFromAudit(dir, { report: legacy, findings: 'all', prefix: 'I' }).created.length, 1, 'legacy Status: header is accepted')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('audit-cards: findings sharing a file become one card of at most 5 findings (throughput audit F1)', () => {
  const dir = fixture()
  try {
    const path = join(dir, 'report.md')
    const hot = (n, extra) => finding(n, { files: ['src/LabDashboard.tsx', `src/part-${n}.ts`], acceptance: [`AC1: ${n} first`, `${n} second`], ...extra })
    const list = [hot(1, { priority: 4 }), hot(2, { dependsOn: [1], priority: 9 }), hot(3), hot(4), hot(5), hot(6), hot(7),
      finding(8), finding(9, { dependsOn: [1] }),
      // 10 -> 11 and 12 -> 13 across two shared files would make the two cards block each other.
      finding(10, { files: ['x.ts'], dependsOn: [11] }), finding(11, { files: ['y.ts'] }), finding(12, { files: ['y.ts'], dependsOn: [13] }), finding(13, { files: ['x.ts'] })]
    writeFileSync(path, `# Hot file audit

Audit ID: 2026-09-26-hot
${report(list)}`)
    const result = cardsFromAudit(dir, { report: path, findings: 'all', prefix: 'I' })
    const idOf = Object.fromEntries(result.created.map(({ n, id }) => [n, id]))
    assert.deepEqual(Object.keys(idOf).map(Number), list.map(f => f.n), 'every finding maps to a card')
    assert.equal(new Set(result.created.map(c => c.id)).size, 2 + 1 + 1 + 3, 'seven hot findings make ceil(7/5) = 2 cards')
    assert.equal(new Set([1, 2, 3, 4, 5].map(n => idOf[n])).size, 1)
    assert.equal(new Set([6, 7].map(n => idOf[n])).size, 1)
    assert.notEqual(idOf[1], idOf[6])
    const hotCard = findCard(dir, idOf[1]), text = readFileSync(hotCard.path, 'utf8')
    assert.match(hotCard.title, /src\/LabDashboard\.tsx/)
    assert.equal(hotCard.priority, 9)
    assert.deepEqual(hotCard.blockedBy, [], 'a dependency inside the card is not a blocker')
    for (const n of [1, 2, 3, 4, 5]) for (const part of [`Problem ${n} observed`, `Fix ${n}`, `TASKS/reports/x/evidence/${n}.png`]) assert.ok(text.includes(part), part)
    assert.equal(text.match(/^- AC\d+:/gm).length, 10)
    assert.equal(new Set(text.match(/^- AC\d+:/gm)).size, 10, 'AC numbers are unique across the grouped findings')
    assert.match(text, /- AC10: 5 second/)
    assert.equal(findCard(dir, idOf[8]).title, 'Problem 8', 'a lone finding keeps its own card')
    assert.deepEqual(findCard(dir, idOf[9]).blockedBy, [idOf[1]])
    assert.notEqual(idOf[10], idOf[13], 'a grouped card that would deadlock is split back into one card per finding')
    assert.deepEqual(findCard(dir, idOf[10]).blockedBy, [idOf[11]])
    assert.deepEqual(findCard(dir, idOf[11]).blockedBy, [idOf[13]])
    assert.deepEqual(findCard(dir, idOf[13]).blockedBy, [])
    const links = readFileSync(path, 'utf8')
    for (const n of list.map(f => f.n)) assert.match(links, new RegExp(`^- F${n}: ${idOf[n]}$`, 'm'))
    assert.equal(cardsFromAudit(dir, { report: path, findings: 'all', prefix: 'I' }).created.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
