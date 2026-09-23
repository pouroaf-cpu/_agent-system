import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCard, findCard, moveCard } from './lib/cards.mjs'
import { recoveryState } from './lib/recovery.mjs'
import { auditDestination, auditArchiveError } from './lib/audit-routing.mjs'
import { notifyManagerException } from './lib/manager-alerts.mjs'
import { explicitOwnerReason } from './lib/owner-reason.mjs'
import { reviewCapabilities } from './lib/review-capabilities.mjs'
import { reviewerPrompt } from './lib/prompt.mjs'
import { auditMcpEngine } from './lib/audit-mcp.mjs'

test('distinct failed returns 1-4 recover, fifth stops, duplicated returns/restarts do not inflate count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-recovery-'))
  try {
    let card = createCard(dir, { title: 'Recovery', brief: 'Approved' })
    const state = () => recoveryState(readFileSync(findCard(dir, card.id).path, 'utf8'))
    assert.equal(state().returns, 0)
    for (let attempt = 1; attempt <= 5; attempt++) {
      moveCard(dir, card.id, 'review')
      moveCard(dir, card.id, 'issues')
      moveCard(dir, card.id, 'issues')
      card = moveCard(dir, card.id, 'planning')
      assert.equal(state().returns, attempt)
      assert.equal(card.column, attempt === 5 ? 'owner' : 'planning')
      if (attempt < 5) {
        moveCard(dir, card.id, 'issues') // repeated delivery, not another issued plan
        moveCard(dir, card.id, 'planning')
        assert.equal(state().returns, attempt)
      }
    }
    const restarted = recoveryState(readFileSync(findCard(dir, card.id).path, 'utf8'))
    assert.equal(restarted.returns, 5)
    assert.ok(restarted.escalatedAt)
    let sent = 0
    const alert = { boardRoot: dir, key: `${card.id}:${restarted.escalatedAt}`, title: 'Five failed returns', detail: `${card.id}: ${card.path}; choose changed approach or cancel`, list: async () => [{ name: 'kanban-observer', agent_status: 'idle' }], prompt: async () => { sent++ }, log: null }
    assert.equal((await notifyManagerException(alert)).sent, true)
    assert.equal((await notifyManagerException({ ...alert })).reason, 'duplicate')
    assert.equal(sent, 1)
    const intake = createCard(dir, { title: 'Successful findings intake', brief: 'Approved' })
    moveCard(dir, intake.id, 'review')
    const planned = moveCard(dir, intake.id, 'planning', { intake: true })
    assert.equal(recoveryState(readFileSync(planned.path, 'utf8')).returns, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('audit disposition, evidence and durable linked fixes; verified access exception only', () => {
  const findings = '# Audit\n## Evidence\nMeasured keyboard result.json\n## Findings\n1. Entry\n2. Containment\n## Audit conclusion\nFINDINGS\n'
  assert.equal(auditDestination(findings, 'FINDINGS'), 'planning')
  assert.equal(auditDestination('**Audit disposition:** report-only-await-owner\n' + findings, 'FINDINGS'), 'owner')
  assert.equal(auditDestination('', 'INCOMPLETE'), 'issues')
  assert.match(auditArchiveError(findings, () => true), /F1/)
  const mapped = findings + '\n## Remediation links\n- F1: T-131\n- F2: T-131\n'
  assert.equal(auditArchiveError(mapped, id => id === 'T-131'), null, 'one deduplicated card can resolve several findings')
  assert.match(auditArchiveError(mapped, () => false), /existing linked/)
  assert.equal(auditArchiveError(findings.replace('FINDINGS', 'CLEAR'), () => false), null)
  assert.match(auditArchiveError(findings.replace('FINDINGS', 'INCOMPLETE'), () => false), /Incomplete/)
  assert.equal(explicitOwnerReason('Only the operator can give login access'), false)
  assert.equal(explicitOwnerReason('Only the operator can grant permission. Verified missing access; approved dev methods exhausted. Evidence: approved helper returned permission denied, grant read-only access.'), true)
})

test('representative scoped reviewer gets only relevant skill references and MCP override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-capabilities-'))
  try {
    const path = join(dir, 'card.md')
    writeFileSync(path, '# T-1\n## Required tools/MCPs\nchrome-devtools\n## Required skills\n')
    const cards = [{ id: 'T-1', path }]
    const skills = reviewCapabilities(cards)
    assert.equal(skills.length, 1)
    assert.match(skills[0].path, /agent-browser\/SKILL.md$/)
    const prompt = reviewerPrompt({ cards, projectPath: dir, boardRoot: dir })
    assert.match(prompt, /visual clipping\/overflow\/keyboard/)
    assert.match(prompt, /do not assume CUA/)
    assert.ok(auditMcpEngine({ kind: 'codex' }, cards, dir).reasoningArgs.some(s => s.startsWith('mcp_servers.chrome-devtools=')))
    writeFileSync(path, '# T-1\n## Required tools/MCPs\nnode --test exact.test.mjs\n')
    assert.deepEqual(reviewCapabilities(cards), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
