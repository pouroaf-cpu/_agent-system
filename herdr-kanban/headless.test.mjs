import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createHeadless, launchArgs } from './lib/headless.mjs'
import { PaneProcessTrees } from './lib/process-tree.mjs'
import { backendFor, validateAgentBackend } from './lib/agent-backend.mjs'
import { formatEvent, followLog } from './scripts/agent-view.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn) { for (let n = 0; n < 150; n++) { const result = await fn(); if (result) return result; await wait(50) } throw new Error('Timed out') }

test('headless launch, registry restart, full prompt argv, session resume and exit code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'headless-'))
  const old = process.env.KANBAN_CONFIG
  const config = join(root, 'config.json'); writeFileSync(config, '{}'); process.env.KANBAN_CONFIG = config
  const script = join(root, 'fake.mjs')
  writeFileSync(script, `console.log(JSON.stringify({type:'thread.started',thread_id:'fake-session'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({argv:process.argv.slice(2),board:process.env.BOARD_AGENT_ID,herdr:process.env.HERDR_PANE_ID})}})); console.error('fake stderr'); setTimeout(()=>process.exit(7), 800)`)
  const command = () => [process.execPath, script]
  const api = createHeadless({ root, command })
  let id
  try {
    id = (await api.tabCreate({ cwd: root, label: 'Review', session: 'project' })).root_pane.pane_id
    await api.agentStart({ name: 'r-T-01', paneId: id, engine: 'codex', model: 'gpt-6-luna', session: 'project', browser: false })
    assert.equal((await api.agentList('project'))[0].agent_status, 'idle')
    const prompt = 'Full task\nwith "quotes", $variables & | `code` and Unicode 🐈'
    assert.equal((await api.agentPrompt(id, prompt, { session: 'project' })).delivered, true)
    await assert.rejects(api.agentPrompt(id, 'duplicate', { session: 'project' }), /already working/)
    const restarted = createHeadless({ root, command })
    assert.equal((await restarted.agentList('project'))[0].agent_status, 'working')
    assert.deepEqual(await restarted.agentList('other'), [])
    const done = await until(async () => { const a = (await restarted.agentList('project'))[0]; return a.agent_status === 'done' && a.exitCode === 7 && a })
    assert.equal(done.sessionId, 'fake-session')
    const lines = (await api.paneRead(id)).split('\n')
    const message = JSON.parse(lines.find(line => line.includes('agent_message')))
    const data = JSON.parse(message.item.text)
    assert.equal(data.argv.at(-1), prompt)
    assert.equal(data.board, id); assert.equal(data.herdr, id)
    assert.match(lines.join('\n'), /fake stderr/)
    await restarted.agentPrompt(id, 'Correction', { session: 'project' })
    assert.equal((await restarted.agentList('project'))[0].agent_status, 'working')
    await until(async () => /Correction/.test(await restarted.paneRead(id)))
    assert.match(await restarted.paneRead(id), /resume/)
    await until(async () => (await restarted.agentList('project'))[0].exitCode === 7)
    assert.equal(JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))[0].exitCode, 7)
    await restarted.paneClose(id)
    assert.deepEqual(await restarted.agentList('project'), [])
  } finally {
    if (id) await api.paneClose(id).catch(() => {})
    if (old === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude and Codex argv preserve model, permission flags and resume settings', () => {
  const options = { name: 'r-T-01', paneId: 'headless-test', model: 'gpt-6-luna', workspacePath: 'C:/checkout', guardArgs: ['-c', 'features.multi_agent=false'], engine: { kind: 'codex', sandbox: 'read-only', approvalPolicy: 'never', reasoningArgs: ['-c', 'model_reasoning_effort="low"'] } }
  const args = launchArgs(options, 'task', 'session')
  assert.deepEqual(args.slice(0, 3), ['--ask-for-approval', 'never', 'exec'])
  assert(args.includes('--sandbox')); assert(args.includes('read-only'))
  assert(args.includes('gpt-6-luna')); assert(args.includes('model_reasoning_effort="low"'))
  assert(args.includes('features.multi_agent=false'))
  assert.deepEqual(args.slice(-4), ['--json', 'resume', 'session', 'task'])
  const claude = launchArgs({ name: 'r-T-01', paneId: 'headless-test', engine: 'claude', model: 'claude-sonnet-5' }, 'task', 'session')
  assert.deepEqual(claude.slice(0, 5), ['-p', 'task', '--output-format', 'stream-json', '--verbose'])
  assert(claude.includes('--dangerously-skip-permissions')); assert(claude.includes('--settings'))
  assert.deepEqual(claude.slice(-2), ['--resume', 'session'])
})

test('Claude process tree closes, launch failures surface, pause blocks dispatch, focus opens the readable viewer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'headless-tree-')), old = process.env.KANBAN_CONFIG
  const config = join(root, 'config.json'); writeFileSync(config, '{}'); process.env.KANBAN_CONFIG = config
  const script = join(root, 'fake.mjs')
  writeFileSync(script, `import {spawn} from 'node:child_process'; const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({type:'system',subtype:'init',session_id:'claude-session',childPid:child.pid})); setInterval(()=>{},1000)`)
  const opens = []
  let processRows = []
  const trees = new PaneProcessTrees({ list: async () => processRows.filter(p => running(p.pid)), kill: async rows => { for (const row of rows) if (running(row.pid)) process.kill(row.pid); await until(() => rows.every(row => !running(row.pid))) } })
  const api = createHeadless({ root, trees, command: () => [process.execPath, script], openTerminal: (...args) => { opens.push(args); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child } })
  let id, descendant
  const running = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    id = (await api.tabCreate({ cwd: root, label: 'Review', session: 'project' })).root_pane.pane_id
    await api.agentStart({ name: 'r-T-02', paneId: id, engine: 'claude', model: 'claude-sonnet-5', session: 'project' })
    writeFileSync(config, '{"maxConcurrentAgents":0}')
    await assert.rejects(api.agentPrompt(id, 'blocked', { session: 'project' }), /paused/)
    writeFileSync(config, '{}')
    await api.agentPrompt(id, 'task', { session: 'project' })
    descendant = await until(async () => { try { return JSON.parse((await api.paneRead(id)).trim()).childPid } catch { return null } })
    assert(running(descendant))
    const agent = (await api.agentList('project'))[0]
    processRows = [{ pid: agent.pid, parent: process.pid, started: '1', name: 'node' }, { pid: agent.childPid, parent: agent.pid, started: '2', name: 'node' }, { pid: descendant, parent: agent.childPid, started: '3', name: 'node' }]
    assert.equal(agent.sessionId, 'claude-session')
    await api.focusAgent(id)
    assert.equal(opens[0][0], 'wt'); assert(opens[0][1].some(arg => String(arg).endsWith('agent-view.mjs')))
    assert.equal(opens[0][1].at(-1), agent.log)
    assert.equal(opens[0][2].detached, true)
    await api.paneClose(id)
    await until(() => !running(agent.pid) && !running(descendant))
    const failing = createHeadless({ root, command: () => [join(root, 'missing-executable.exe')] })
    const bad = (await failing.tabCreate({ cwd: root, session: 'project' })).root_pane.pane_id
    await failing.agentStart({ name: 'r-T-03', paneId: bad, engine: 'claude', model: 'claude-sonnet-5' })
    await assert.rejects(failing.agentPrompt(bad, 'task'), /ENOENT/)
    await failing.paneClose(bad)
  } finally {
    if (id) await api.paneClose(id).catch(() => {})
    if (descendant && running(descendant)) process.kill(descendant)
    if (old === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = old
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('backend validation and live role selection include Builders', () => {
  const root = mkdtempSync(join(tmpdir(), 'backend-')), config = join(root, 'config.json'), old = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = config
  try {
    assert.equal(backendFor('reviewer'), 'herdr')
    for (const value of ['invalid', null, [], { review: 'headless' }, { reviewer: true }]) assert.throws(() => validateAgentBackend(value))
    writeFileSync(config, JSON.stringify({ agentBackend: { reviewer: 'headless', plancheck: 'headless' } }))
    assert.equal(backendFor('reviewer'), 'headless'); assert.equal(backendFor('plancheck'), 'headless'); assert.equal(backendFor('builder'), 'herdr')
    writeFileSync(config, JSON.stringify({ agentBackend: 'headless' }))
    assert.equal(backendFor('planner'), 'headless'); assert.equal(backendFor('builder'), 'headless'); assert.equal(backendFor('reviewer'), 'headless')
    writeFileSync(config, JSON.stringify({ agentBackend: 'herdr' })); assert.equal(backendFor('reviewer'), 'herdr')
  } finally { if (old === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = old; rmSync(root, { recursive: true, force: true }) }
})

test('viewer renders messages, tools, commands, results and unknown events; follows partial lines once', async () => {
  const render = e => formatEvent(JSON.stringify(e))
  assert.equal(render({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello' } }), 'Hello')
  assert.match(render({ type: 'item.started', item: { type: 'command_execution', command: 'node test.mjs' } }), /→.*node test.mjs/)
  assert.match(render({ type: 'item.completed', item: { type: 'command_execution', command: 'node test.mjs', exit_code: 0, aggregated_output: 'passed' } }), /←.*\[0\].*passed/)
  assert.match(render({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', name: 'Read', input: { file_path: 'app.mjs' } }] } }), /Checking\n→ Read.*app.mjs/)
  assert.match(render({ type: 'user', message: { content: [{ type: 'tool_result', content: 'all good' }] } }), /← all good/)
  assert.equal(formatEvent('stderr'), 'stderr')
  assert(render({ type: 'future', data: 'x'.repeat(1000) }).length <= 240)
  const root = mkdtempSync(join(tmpdir(), 'viewer-')), file = join(root, 'agent.log'), output = []
  writeFileSync(file, '')
  const stop = followLog(file, line => output.push(line))
  try {
    appendFileSync(file, '{"type":"item.completed","item":{"type":"agent_message","text":"Hello 🐈"}}')
    await wait(300); assert.equal(output.length, 0)
    appendFileSync(file, '\nraw stderr\n')
    await until(() => output.length === 2)
    assert.deepEqual(output, ['Hello 🐈', 'raw stderr'])
    await wait(300); assert.equal(output.length, 2)
  } finally { stop(); rmSync(root, { recursive: true, force: true }) }
})
