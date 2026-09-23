import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readAuditReports } from './lib/audit-reports.mjs'
import { reviewerPrompt } from './lib/prompt.mjs'

test('report-only Auditor is selectable, distinct from Reviewer/legacy routing, and shared report indexes safely', t => {
  const roles = 'C:/Users/PFrew/Projects/_roles'
  const profile = readFileSync(join(roles, 'AUDITOR.md'), 'utf8')
  const template = readFileSync(join(roles, 'AUDIT-REPORT-TEMPLATE.md'), 'utf8')
  assert.match(profile, /Default to read-only/)
  assert.match(profile, /Do not change live user data/)
  assert.match(profile, /Do not turn findings into work automatically/)
  assert.doesNotMatch(profile, /Injectbuddy/)
  assert.match(readFileSync(join(roles, 'REVIEWER.md'), 'utf8'), /specific completed change/)
  const registry = spawnSync('powershell.exe', ['-NoProfile', '-Command', '. C:/Users/PFrew/herdr-roles.ps1; @{path=$HerdrRoles.auditor.RoleFile; prompt=(Get-HerdrRolePrompt -RoleKey auditor -Project Proof -ProjDir C:/Proof -AgentId fixture)} | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true })
  assert.equal(registry.status, 0, registry.stderr)
  const selected = JSON.parse(registry.stdout)
  assert.equal(selected.path.replaceAll('\\', '/'), `${roles}/AUDITOR.md`)
  assert.match(selected.prompt, /report-only Auditor for Proof/)
  assert.match(selected.prompt, /No product fixes, card creation\/routing/)
  assert.doesNotMatch(selected.prompt, /ORCHESTRATION\.md|hkb audit/)
  const root = mkdtempSync(join(tmpdir(), 'auditor-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'Proof', 'TASKS', 'reports', 'scoped-check-20260918')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.md'), template.replace('<Audit title>', 'Scoped button audit').replace('<registered project name>', 'Proof').replace('<YYYY-MM-DD or ISO timestamp with timezone>', '2026-09-18'))
  const config = { projectsRoot: root, projects: ['Proof'] }
  let reports = readAuditReports(config, 'Proof')
  assert.equal(reports.length, 1); assert.equal(reports[0].title, 'Scoped button audit')
  assert.equal(reports[0].status, 'Incomplete'); assert.equal(reports[0].date, '2026-09-18')
  assert.equal(reports[0].reports[0].file, 'TASKS/reports/scoped-check-20260918/report.md')
  const cardPath = join(root, 'T-1.md'); writeFileSync(cardPath, '# T-1 — fixture\n')
  const prompt = reviewerPrompt({ cards: [{ id: 'T-1', path: cardPath, audit: 'seo' }], projectPath: root, boardRoot: root })
  assert.match(prompt, /AUDITOR-CARD-WORKFLOW\.md/)
  assert.doesNotMatch(prompt, /_roles\/AUDITOR\.md/)
})
