// Unpaid native-runtime probe: a local mock model requests ONE harmless denied
// command. No credentials, product checkout, real model or board session is used.
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { digest, guardScript, prepareBuilderGuard, operationPrefix } from '../lib/builder-guard.mjs'
import { fileURLToPath } from 'node:url'

const executable = process.argv[2]
if (!executable || !existsSync(executable)) throw new Error('Pass the exact installed native codex executable')
const root = mkdtempSync(join(tmpdir(), 'codex-native-guard-probe-'))
const home = join(root, 'home'); mkdirSync(home)
const card = join(root, 'T-1.md'); writeFileSync(card, 'Unpaid native hook probe only')
const policyPath = join(root, '.builder-guard', 'T-1.json'); mkdirSync(join(root, '.builder-guard'))
const modulePath = fileURLToPath(new URL('../lib/builder-guard.mjs', import.meta.url))
writeFileSync(policyPath, JSON.stringify({ version: 1, approvedBy: 'isolated regression fixture', project: 'Probe', cardId: 'T-1', authorizationId: 'probe-only', workspace: root, cardHash: digest(readFileSync(card)), read: [card], write: [], pins: Object.fromEntries([guardScript, modulePath, process.execPath].map(p => [p, digest(readFileSync(p))])), commands: {} }))
const guard = prepareBuilderGuard({ tasksDir: root, project: 'Probe', card: { id: 'T-1', path: card }, workspacePath: root })
let requests = 0, received = []
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  received.push(body); requests++
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const approvedRead = operationPrefix(policyPath, guard.hash) + Buffer.from(JSON.stringify({ op: 'read', path: card })).toString('base64url')
  const item = requests <= 2
    ? { id: `fc_probe_${requests}`, type: 'function_call', call_id: `probe_call_${requests}`, name: 'exec_command', arguments: JSON.stringify({ cmd: requests === 1 ? approvedRead : 'echo UNGUARDED_PROBE_EXECUTED', login: false, max_output_tokens: 200 }) }
    : { id: 'msg_probe', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Probe complete.' }] }
  const response = { id: `resp_${requests}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  const emit = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
  emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
  emit({ type: 'response.output_item.added', output_index: 0, item })
  emit({ type: 'response.output_item.done', output_index: 0, item })
  emit({ type: 'response.completed', response }); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const args = ['exec', '--skip-git-repo-check', '--cd', root, '--model', 'mock-guard', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider="guard_probe"', '-c', 'model_providers.guard_probe.name="Isolated guard fixture"', '-c', `model_providers.guard_probe.base_url="http://127.0.0.1:${server.address().port}"`, '-c', 'model_providers.guard_probe.wire_api="responses"', '-c', 'model_providers.guard_probe.requires_openai_auth=false', ...guard.args, 'Run the harmless fixture request; this is a local mock model.']
let output = ''
const result = await new Promise(resolve => {
  const child = spawn(executable, args, { cwd: root, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
  child.stdout.on('data', b => { if (output.length < 100000) output += b })
  child.stderr.on('data', b => { if (output.length < 100000) output += b })
  child.on('error', error => resolve({ error: error.message }))
  child.on('close', (code, signal) => resolve({ code, signal }))
})
server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
writeFileSync(join(root, 'probe-output.log'), output)
writeFileSync(join(root, 'mock-requests.json'), JSON.stringify(received))
const events = existsSync(`${policyPath}.events.jsonl`) ? readFileSync(`${policyPath}.events.jsonl`, 'utf8') : ''
const denied = events.includes('unknown, nested or dynamic shell command denied') && received.some(body => body.includes('Builder guard'))
const allowed = received.some(body => JSON.parse(body).input?.some(item => item.type === 'function_call_output' && String(item.output).includes('Unpaid native hook probe only')))
console.log(JSON.stringify({ ...result, root, requests, nativeAllowObserved: allowed, nativeDenyObserved: denied, startupReceipt: existsSync(`${policyPath}.active.json`) }))
if (!allowed || !denied) process.exitCode = 1
