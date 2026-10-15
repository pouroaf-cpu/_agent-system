import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewerNeedsBrowser, needsBrowser } from './lib/cards.mjs'
import { agentStartArgs } from './lib/agent-launch.mjs'
import { auditMcpEngine, CHROME_DEVTOOLS_MCP_ENTRY } from './lib/audit-mcp.mjs'

// audit 2026-10-16 F4: only Builders that browse, audit agents and Reviewers of ui or audit cards get the
// Chrome DevTools MCP; the MCP runs from a pinned install under herdr-kanban with node, not npx or cmd.exe.

const root = dirname(fileURLToPath(import.meta.url))
const read = name => readFileSync(join(root, name), 'utf8')

test('a Reviewer gets the browser MCP for an audit or a ui card, and not for a plain card', () => {
  assert.equal(reviewerNeedsBrowser([{ audit: true, category: 'code' }]), true)
  assert.equal(reviewerNeedsBrowser([{ audit: false, category: 'ui' }]), true)
  assert.equal(reviewerNeedsBrowser([{ audit: false, category: 'code' }]), false)
  assert.equal(reviewerNeedsBrowser([{ audit: false, category: 'code' }, { audit: false, category: 'ui' }]), true)
  assert.equal(reviewerNeedsBrowser([]), false)
})

test('a Builder card needs the browser MCP for ui or audit, and a plain card with no browser words does not', t => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-mcp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const plain = join(dir, 'plain.md')
  writeFileSync(plain, '# T-9 — rename a helper\nFiles: lib/a.mjs\n')
  assert.equal(needsBrowser({ category: 'ui', path: plain }), true)
  assert.equal(needsBrowser({ audit: true, category: 'code', path: plain }), true)
  assert.equal(needsBrowser({ category: 'code', path: plain }), false)
})

test('the browser MCP flag follows the browser option: present when true, absent when false', () => {
  const on = agentStartArgs({ name: 'b-t-1', paneId: 'p', model: 'claude-sonnet-5-5', engine: { kind: 'claude' }, browser: true })
  assert.ok(on.includes('--mcp-config'))
  assert.match(on[on.indexOf('--mcp-config') + 1], /claude-browser-mcp\.json$/)
  const off = agentStartArgs({ name: 'p-t-1', paneId: 'p', model: 'claude-sonnet-5-5', engine: { kind: 'claude' }, browser: false })
  assert.equal(off.includes('--mcp-config'), false)
  assert.ok(off.includes('--strict-mcp-config'), 'a browser-less agent still gets no user or connector MCPs')
})

test('claude-browser-mcp.json starts chrome-devtools with node from the pinned install, not npx or cmd', () => {
  const cfg = JSON.parse(read('claude-browser-mcp.json'))
  const server = cfg.mcpServers['chrome-devtools']
  assert.equal(server.command, 'node')
  assert.match(server.args[0], /node_modules\/chrome-devtools-mcp\/build\/src\/bin\/chrome-devtools-mcp\.js$/)
  const text = JSON.stringify(server)
  assert.doesNotMatch(text, /npx|cmd\.exe|conhost|@latest/)
  // The config names the live board's path; this checks the same file in the install under this checkout.
  const local = join(root, 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js')
  assert.ok(existsSync(local), `pinned install is missing at ${local}: run npm ci in herdr-kanban`)
})

test('the pinned install is exact chrome-devtools-mcp 1.11.0, and the audit entry resolves inside herdr-kanban', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.dependencies['chrome-devtools-mcp'], '1.11.0')
  assert.equal(pkg.type, undefined, 'public/*.js files need the CommonJS default')
  assert.match(CHROME_DEVTOOLS_MCP_ENTRY, /node_modules[\\/]chrome-devtools-mcp[\\/]build[\\/]src[\\/]bin[\\/]chrome-devtools-mcp\.js$/)
  assert.ok(CHROME_DEVTOOLS_MCP_ENTRY.startsWith(join(root, 'node_modules')), 'the entry is inside herdr-kanban, not a global or npx cache')
})

test('the Codex audit override launches chrome-devtools with node (process.execPath) and no cmd.exe, npx or 1.9.0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-mcp-codex-'))
  const card = { path: join(dir, 'card.md') }
  try {
    writeFileSync(card.path, '# Card\n## Required tools/MCPs\n- chrome-devtools\n## Scope\nOne target\n')
    const scoped = auditMcpEngine({ kind: 'codex', reasoningArgs: [] }, [card], dir)
    const override = scoped.reasoningArgs.find(s => s.startsWith('mcp_servers.chrome-devtools='))
    assert.ok(override, 'override present')
    assert.ok(override.startsWith(`mcp_servers.chrome-devtools={ command = ${JSON.stringify(process.execPath)}, args = `), override)
    assert.ok(override.includes(JSON.stringify(CHROME_DEVTOOLS_MCP_ENTRY)), override)
    assert.doesNotMatch(override, /cmd\.exe|npx|1\.9\.0|conhost/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the Planner and Finder start with no browser MCP in lib/card-planner.mjs, and it no longer reads needsBrowser', () => {
  const src = read('lib/card-planner.mjs')
  const starts = [...src.matchAll(/agentStart\(\{[^}]*\}\)/g)].map(m => m[0])
  const planner = starts.filter(s => /name: owner\.name|agentName\('finder'/.test(s))
  assert.equal(planner.length, 2, 'both Planner amend and Finder starts are found')
  for (const s of planner) assert.match(s, /browser: false/)
  assert.doesNotMatch(src, /needsBrowser/)
})
