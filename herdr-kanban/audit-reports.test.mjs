import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readAuditReports, resolveAuditReport, editorArguments } from './lib/audit-reports.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'audit-reports-'))
  const config = { projectsRoot: root, projects: ['Proof', 'Other'], port: 18783, maxConcurrentAgents: 0, agentPollMs: 600000, editor: 'echo' }
  const put = (path, text) => { const file = join(root, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); return file }
  put('Proof/TASKS/reports/T-1/report.md', '# Private Proof audit\nDate: 2026-09-18\nStatus: INCOMPLETE\nOnly part of the coverage checked.\n')
  put('Proof/TASKS/archive/T-1.md', '# T-1 — Proof audit title\n**Audit:** seo\n## Audit conclusion\nCLEAR\n')
  put('Proof/TASKS/issues/T-2.md', '# T-2 — Missing audit\n**Audit:** seo\n## Audit conclusion\nCLEAR\n')
  put('Other/TASKS/reports/other.md', '# Other project secret\nGenerated: 2026-09-17T01:00:00Z\nReport text.\n')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, config, put }
}

test('project reports expose actual dates/status and missing evidence never inherits Completed/CLEAR', t => {
  const { config, put } = fixture(t)
  put('Proof/TASKS/reports/unverified.md', '# Unverified audit\nSome findings.\n')
  const reports = readAuditReports(config, 'Proof')
  assert.equal(reports.length, 3)
  const actual = reports.find(a => a.title === 'Proof audit title')
  assert.equal(actual.status, 'Incomplete'); assert.equal(actual.date, '2026-09-18')
  assert.equal(actual.dateLabel, 'Report date'); assert.equal(actual.reports.length, 1)
  assert.equal(reports.find(a => a.title === 'Missing audit').status, 'Report missing')
  assert.deepEqual(reports.find(a => a.title === 'Missing audit').reports, [])
  assert.equal(reports.find(a => a.title === 'Unverified audit').dateLabel, 'Updated')
  assert.ok(reports.every(a => !a.title.includes('Other project')))
  assert.equal(readAuditReports(config, 'Other').length, 1)
  assert.throws(() => readAuditReports(config, '../Other'), /Unknown project/)
})

test('known-directory discovery is bounded; explicit deeper metadata links work without borrowing unrelated verdicts', t => {
  const { config, put } = fixture(t)
  put('Proof/TASKS/reports/deep/nested/detail.md', '# Deep report\nStatus: PARTIAL\nEvidence still missing.\n')
  put('Proof/TASKS/reports/ignored/nested/report.md', '# Not scanned\nEvidence.\n')
  put('Proof/TASKS/owner/T-3.md', '# T-3 — Linked audit\n**Audit:** seo\n**Audit report:** `TASKS/reports/deep/nested/detail.md`\n')
  put('Proof/TASKS/reports/T-1/summary.md', '# Supplement\nDetails.\n')
  const reports = readAuditReports(config, 'Proof')
  assert.equal(reports.find(a => a.title === 'Proof audit title').reports.length, 2)
  assert.equal(reports.find(a => a.title === 'Linked audit').status, 'Incomplete')
  assert.ok(reports.every(a => a.title !== 'Not scanned'))
})

test('report identities reject traversal, foreign projects, removed files, shell characters and escaping junctions', t => {
  const { root, config, put } = fixture(t)
  const actual = readAuditReports(config, 'Proof').find(a => a.reports.length).reports[0]
  assert.match(resolveAuditReport(config, 'Proof', actual.id), /report\.md$/)
  assert.throws(() => resolveAuditReport(config, 'Other', actual.id), /missing/)
  assert.throws(() => resolveAuditReport(config, 'Proof', '../../secrets.md'), /identity/)
  assert.throws(() => resolveAuditReport(config, 'Unknown', actual.id), /Unknown project/)
  for (const path of ['C:/report%TEMP%.md', 'C:/report".md', 'C:/report$(whoami).md', 'C:/report&calc.md']) assert.throws(() => editorArguments(path), /characters/)
  assert.deepEqual(editorArguments('C:/safe folder/report.md'), ['"C:/safe folder/report.md"'])
  symlinkSync(join(root, 'Other/TASKS/reports'), join(root, 'Proof/TASKS/reports/escape'), 'junction')
  put('Proof/TASKS/issues/T-4.md', '# T-4 — Escape\n**Audit:** seo\n**Audit report:** `TASKS/reports/escape/other.md`\n')
  assert.ok(readAuditReports(config, 'Proof').every(a => a.title !== 'Other project secret'))
  rmSync(join(root, 'Proof/TASKS/reports/T-1/report.md'))
  assert.throws(() => resolveAuditReport(config, 'Proof', actual.id), /missing/)
})

test('isolated HTTP list/open validates registered report identity and does not dispatch agents', async t => {
  const { root, config, put } = fixture(t)
  const configPath = put('board.config.json', JSON.stringify(config))
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: 'unavailable-audit-test-herdr' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  t.after(() => { if (child.exitCode === null) child.kill() })
  // server.mjs prints its port: another test run may hold the config one.
  const base = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('startup timeout')), 30000); child.stdout.on('data', b => { const port = String(b).match(/127\.0\.0\.1:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`) } }); child.on('exit', c => { clearTimeout(timer); reject(new Error(`exit ${c}`)) }) })
  try {
    const list = await fetch(base + '/api/audits?project=Proof').then(r => r.json())
    assert.equal(list.project, 'Proof'); assert.equal(list.audits.length, 2)
    const reportId = list.audits.find(a => a.reports.length).reports[0].id
    const open = payload => fetch(base + '/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    assert.equal((await open({ project: 'Proof', reportId })).status, 200) // editor is harmless echo fixture
    assert.equal((await open({ project: 'Other', reportId })).status, 400)
    assert.equal((await open({ project: '../Proof', id: 'T-1' })).status, 400)
    assert.equal((await open({ project: 'Proof', reportId: '../x.md', path: 'C:/secret' })).status, 400)
    assert.equal((await fetch(base + '/api/audits?project=../Other')).status, 400)
  } finally { await new Promise(resolve => { child.once('exit', resolve); child.kill() }) }
})
