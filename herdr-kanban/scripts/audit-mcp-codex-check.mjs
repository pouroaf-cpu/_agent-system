// Single real Codex tool-call check using the same scoped launch configuration.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { auditMcpEngine } from '../lib/audit-mcp.mjs'
import { agentStartArgs } from '../lib/herdr.mjs'

const output = resolve('artifacts/audit-mcp-smoke')
const fixture = resolve(output, 'runtime-card.md')
writeFileSync(fixture, '# Runtime smoke\n## Required tools/MCPs\nchrome-devtools\n')
const engine = auditMcpEngine({ kind: 'codex', reasoningArgs: ['-c', 'model_reasoning_effort="high"'] }, [{ path: fixture }], output)
const managed = agentStartArgs({ name: 'kb-review-mcp-smoke', paneId: 'smoke', model: 'gpt-5.6-luna', engine })
const overrides = managed.slice(managed.indexOf('--') + 1)
const cli = resolve(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js')
const child = spawn(process.execPath, [cli, 'exec', ...overrides, '--skip-git-repo-check', '--json', 'Tool-availability smoke only. Discover the configured chrome-devtools MCP tools using tool search if deferred, then call its list_pages tool exactly once. Report whether it succeeded. No filesystem work, browsing to websites, account writes, or delegation.'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const events = []
let buffer = ''
child.stdout.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) break
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    try {
      const event = JSON.parse(line)
      if (event.item?.type === 'mcp_tool_call' || event.item?.type === 'agent_message' || event.type === 'turn.failed' || event.type === 'error') {
        events.push(event)
        console.log(JSON.stringify(event))
      }
    } catch {}
  }
})
child.stderr.on('data', chunk => { if (/error/i.test(String(chunk))) console.error(String(chunk).slice(0, 500)) })
const timer = setTimeout(() => child.kill(), 120000)
const code = await new Promise(resolve => child.once('exit', resolve))
clearTimeout(timer)
writeFileSync(resolve(output, 'codex-runtime.json'), JSON.stringify({ model: 'gpt-5.6-luna', engine: 'codex', exitCode: code, events }, null, 2))
if (code !== 0 || !events.some(e => e.item?.type === 'mcp_tool_call' && e.item.status === 'completed')) process.exitCode = 1
