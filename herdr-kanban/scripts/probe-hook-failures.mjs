// Harmless native Codex capability probe. Loopback mock responses, fresh CODEX_HOME,
// no real model/auth, product checkout, shared hook configuration or board runtime.
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'

const [mode, ...args] = process.argv.slice(2)
if (mode === 'hook') {
  const [scenario, log] = args
  let input = ''; for await (const chunk of process.stdin) input += chunk
  const event = JSON.parse(input)
  appendFileSync(log, JSON.stringify(event) + '\n')
  if (scenario === 'crash') process.exit(7)
  if (scenario === 'timeout') { await new Promise(r => setTimeout(r, 5000)); process.exit(0) }
  if (scenario === 'malformed') { process.stdout.write('{"hookSpecificOutput":'); process.exit(0) }
  if (scenario.startsWith('exit2')) { process.stderr.write('Fixture explicit denial'); process.exit(2) }
  if (scenario === 'allow' || (scenario === 'stdin' && event.tool_name === 'Bash')) process.stdout.write('{}')
  else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Fixture explicit denial' } }))
  process.exit(0)
}
if (mode === 'stdin-target') {
  process.stdout.write('READY\n')
  process.stdin.once('data', () => { writeFileSync(args[0], 'stdin delivered'); process.exit(0) })
  setTimeout(() => process.exit(0), 10000)
} else {
  const executable = mode
  if (!executable || !existsSync(executable)) throw new Error('Pass exact native codex executable')
  const scenarios = args.length ? args : ['allow', 'deny', 'exit2', 'exit2-propagated', 'missing', 'crash', 'timeout', 'malformed', 'untrusted', 'event-disabled', 'feature-disabled', 'apply-patch', 'stdin']
  const root = mkdtempSync(join(tmpdir(), 'codex-hook-failure-matrix-'))
  const self = fileURLToPath(import.meta.url), quote = s => `'${s.replaceAll("'", "''")}'`
  const results = []
  console.log(JSON.stringify({ root, runtime: execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim() }))
  for (const scenario of scenarios) {
    const dir = join(root, scenario), home = join(dir, 'home'); mkdirSync(home, { recursive: true })
    const sentinel = join(dir, 'sentinel.txt'), hookLog = join(dir, 'hook-events.jsonl'), hookFile = join(home, 'hooks.json')
    const command = `& ${quote(process.execPath)} ${quote(scenario === 'missing' ? join(dir, 'missing.mjs') : self)} hook ${scenario} ${quote(hookLog)}` + (scenario === 'exit2-propagated' ? '; exit $LASTEXITCODE' : '')
    writeFileSync(hookFile, JSON.stringify({ hooks: { PreToolUse: scenario === 'event-disabled' ? [] : [{ hooks: [{ type: 'command', command, timeout: scenario === 'timeout' ? 1 : 10 }] }] } }))
    let requests = 0, bodies = []
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk
      bodies.push(body); const parsed = JSON.parse(body); requests++
      let item = { id: 'msg_probe', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture finished.' }] }
      if (requests === 1) {
        if (scenario === 'apply-patch') item = { type: 'custom_tool_call', id: 'ct_probe', call_id: 'probe_1', name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${sentinel.replaceAll('\\', '/')}\n+patched\n*** End Patch` }
        else item = { type: 'function_call', id: 'fc_probe', call_id: 'probe_1', name: 'exec_command', arguments: JSON.stringify({ cmd: scenario === 'stdin' ? `& ${quote(process.execPath)} ${quote(self)} stdin-target ${quote(sentinel)}` : `Set-Content -LiteralPath ${quote(sentinel)} -Value 'executed'`, login: false, ...(scenario === 'stdin' ? { tty: true } : {}), yield_time_ms: 1000, max_output_tokens: 200 }) }
      } else if (scenario === 'stdin' && requests === 2) {
        const outputs = (parsed.input || []).filter(i => i.type === 'function_call_output').map(i => i.output).join('\n')
        const session = outputs.match(/session ID\s*:?\s*(\d+)/i)?.[1]
        if (session) item = { type: 'function_call', id: 'fc_stdin', call_id: 'probe_2', name: 'write_stdin', arguments: JSON.stringify({ session_id: Number(session), chars: 'probe\n', yield_time_ms: 1000, max_output_tokens: 200 }) }
      }
      const response = { id: `resp_${requests}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const argv = ['exec', '--skip-git-repo-check', '--cd', dir, '--model', 'gpt-5.5', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider="guard_probe"', '-c', 'model_providers.guard_probe.name="Isolated fixture"', '-c', `model_providers.guard_probe.base_url="http://127.0.0.1:${server.address().port}"`, '-c', 'model_providers.guard_probe.wire_api="responses"', '-c', 'model_providers.guard_probe.requires_openai_auth=false', '-c', 'web_search="disabled"', '-c', 'features.plugins=false']
    if (scenario !== 'untrusted') argv.push('--dangerously-bypass-hook-trust')
    if (scenario === 'feature-disabled') argv.push('-c', 'features.hooks=false')
    argv.push('Execute only the harmless local fixture request.')
    const env = { ...process.env, CODEX_HOME: home }; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY
    let output = ''
    const result = await new Promise(r => {
      const child = spawn(executable, argv, { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000 })
      child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
      child.once('error', e => r({ error: e.message })); child.once('close', (code, signal) => r({ code, signal }))
    })
    server.closeAllConnections(); await new Promise(r => server.close(r))
    writeFileSync(join(dir, 'native-output.log'), output); writeFileSync(join(dir, 'mock-requests.json'), JSON.stringify(bodies))
    const hooks = existsSync(hookLog) ? readFileSync(hookLog, 'utf8').trim().split('\n').map(l => JSON.parse(l).tool_name) : []
    const record = { scenario, ...result, requests, sentinelWritten: existsSync(sentinel), hookTools: hooks, artifact: dir }
    results.push(record); writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(record))
  }
}
