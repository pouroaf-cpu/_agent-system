import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditMcpEngine, needsAuditMcp, auditPreflightBlocked, blockAuditPreflight } from './lib/audit-mcp.mjs'
import { agentStartArgs } from './lib/herdr.mjs'

test('audit MCP opt-in is section-scoped, preserves model/engine and blocks unchanged prerequisites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-audit-mcp-'))
  const card = { path: join(dir, 'card.md') }
  const engine = { kind: 'codex', reasoningArgs: ['-c', 'model_reasoning_effort="high"'] }
  try {
    writeFileSync(card.path, '# Card\n## Required tools/MCPs\n- DOM\n## History\nchrome-devtools\n')
    assert.equal(needsAuditMcp([card]), false)
    assert.equal(auditMcpEngine(engine, [card], dir), engine)
    writeFileSync(card.path, '# Card\n## Required tools/MCPs\n- DOM\n- chrome-devtools\n## Scope\nOne target\n')
    assert.equal(needsAuditMcp([card]), true)
    const scoped = auditMcpEngine(engine, [card], dir)
    assert.deepEqual(engine.reasoningArgs, ['-c', 'model_reasoning_effort="high"'])
    const launch = agentStartArgs({ name: 'kb-review-injectbuddy-test', paneId: 'test', model: 'gpt-5.6-luna', engine: scoped })
    assert.ok(launch.some(a => a.startsWith('mcp_servers.chrome-devtools=') && a.includes('required = true') && a.includes('--headless')))
    const builder = agentStartArgs({ name: 'kb-t-999-test', paneId: 'test', model: 'gpt-5.6-luna', engine })
    assert.ok(!builder.some(a => a.includes('mcp_servers')))
    assert.throws(() => auditMcpEngine('claude', [card], dir), /Codex runtime/)
    writeFileSync(card.path, '**Audit preflight:** BLOCKED — tool unavailable\n')
    assert.equal(auditPreflightBlocked(card), true)
    writeFileSync(card.path, '**Audit preflight:** READY — repaired evidence\n')
    assert.equal(auditPreflightBlocked(card), false)
    blockAuditPreflight(card)
    assert.equal(auditPreflightBlocked(card), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
