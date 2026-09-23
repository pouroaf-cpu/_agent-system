// Bounded config regression + one read via the same cached server/environment.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditMcpEngine, gscReviewerConfig } from '../lib/audit-mcp.mjs'
import { capabilityBrief } from '../lib/review-capabilities.mjs'
const tasks = 'C:/Users/PFrew/KanbanProjects/Injectbuddy/TASKS'
const config = gscReviewerConfig(tasks)
assert.throws(() => gscReviewerConfig('C:/Other/TASKS'), /only for Injectbuddy/)
const dir = mkdtempSync(join(tmpdir(), 'gsc-reviewer-check-'))
try {
  const card = { path: join(dir, 'card.md') }
  const engine = { kind: 'codex', reasoningArgs: [] }
  writeFileSync(card.path, '# Card\n## Required tools/MCPs\n- DOM\n## History\ngsc\n')
  assert.equal(auditMcpEngine(engine, [card], tasks), engine)
  assert.ok(!capabilityBrief([card]).includes('GSC:'))
  writeFileSync(card.path, '# SEO review\n## Required tools/MCPs\n- gsc\n')
  const scoped = auditMcpEngine(engine, [card], tasks)
  const override = scoped.reasoningArgs.find(arg => arg.startsWith('mcp_servers.gsc='))
  assert.ok(override.includes(`enabled_tools = ${JSON.stringify(config.enabled_tools)}`))
  assert.ok(override.includes('sc-domain:injectbuddy.com'))
  assert.ok(!scoped.reasoningArgs.some(arg => arg.includes('chrome-devtools')))
  assert.deepEqual(engine.reasoningArgs, [])
  assert.ok(capabilityBrief([card]).includes('never submit/delete'))
  assert.ok(config.enabled_tools.every(name => !/submit|delete|generate|write/i.test(name)))
  const require = createRequire(config.args[0])
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
  const client = new Client({ name: 'kanban-gsc-read-preflight', version: '1' })
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env }, stderr: 'ignore' })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    const permitted = listed.tools.filter(tool => config.enabled_tools.includes(tool.name) && !config.disabled_tools.includes(tool.name))
    assert.deepEqual(permitted.map(tool => tool.name).sort(), [...config.enabled_tools].sort())
    const result = await client.callTool({ name: 'site_snapshot', arguments: { days: 7 } })
    assert.ok(!result.isError, 'GSC read failed (response omitted)')
    const body = JSON.parse(result.content.find(item => item.type === 'text').text)
    assert.ok(!body.error, 'GSC response contains an error (omitted)')
    const proof = { at: new Date().toISOString(), property: config.env.GSC_SITE_URL, permitted: permitted.map(tool => tool.name), directRead: 'site_snapshot(days=7)', success: true, responseKeys: Object.keys(body), configRegression: 'PASS', credentialScope: 'Existing broader OAuth grant unchanged; Codex tool allowlist only', runtimeActivation: 'Board reload not attempted; pending existing safe activation' }
    mkdirSync('artifacts', { recursive: true })
    writeFileSync('artifacts/gsc-reviewer-check.json', JSON.stringify(proof, null, 2))
    console.log(JSON.stringify(proof))
  } finally { await client.close() }
} finally { rmSync(dir, { recursive: true, force: true }) }
