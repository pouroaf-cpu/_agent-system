import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { renameSync } from './fs-retry.mjs'
import { PaneProcessTrees } from './process-tree.mjs'
import * as herdr from './herdr.mjs'
import { assertPromptAllowed } from './project-control.mjs'
import * as bindings from './bindings.mjs'

export const isHeadless = id => String(id).startsWith('headless-')
export function launchArgs(options, prompt, sessionId) {
  const raw = herdr.agentStartArgs(options)
  const flags = raw.slice(raw.indexOf('--') + 1)
  const engine = options.kind || (typeof options.engine === 'string' ? options.engine : options.engine?.kind) || 'claude'
  if (engine !== 'codex') return ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...flags, ...(sessionId ? ['--resume', sessionId] : [])]
  // Approval is a global Codex option; exec has no --ask-for-approval.
  const approval = flags.indexOf('--ask-for-approval')
  const global = approval < 0 ? [] : flags.splice(approval, 2)
  return [...global, 'exec', ...flags, '--json', ...(sessionId ? ['resume', sessionId] : []), prompt]
}

// Bypass Windows .cmd shims: argv must never pass through cmd's prompt parser.
export function agentCommand(engine, env = process.env) {
  const npm = join(env.APPDATA || '', 'npm', 'node_modules')
  const native = join(npm, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  const codex = join(npm, '@openai', 'codex', 'bin', 'codex.js')
  if (process.platform === 'win32') {
    if (engine === 'claude' && existsSync(native)) return [native]
    if (engine === 'codex' && existsSync(codex)) return [process.execPath, codex]
    for (const dir of (env.PATH || '').split(delimiter)) {
      const exe = join(dir, `${engine}.exe`)
      if (existsSync(exe)) return [exe]
    }
    throw new Error(`Cannot find ${engine} executable (native executable or npm installation required)`)
  }
  return [engine]
}

const alive = pid => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }
function tail(file, bytes = 128 * 1024) {
  if (!existsSync(file)) return ''
  const size = statSync(file).size, fd = openSync(file, 'r')
  try { const buffer = Buffer.alloc(Math.min(size, bytes)); readSync(fd, buffer, 0, buffer.length, Math.max(0, size - bytes)); return buffer.toString('utf8') } finally { closeSync(fd) }
}
const supervisor = fileURLToPath(new URL('../scripts/agent-process.mjs', import.meta.url))
export const viewer = fileURLToPath(new URL('../scripts/agent-view.mjs', import.meta.url))

// The registry lives beside the board config, so a test server with its own KANBAN_CONFIG never
// sees the live board's agents (test.mjs found every slot full, 2026-10-03).
const defaultRoot = () => process.env.KANBAN_CONFIG ? join(dirname(process.env.KANBAN_CONFIG), '.agents')
  : process.env.KANBAN_TEST ? join(tmpdir(), `kanban-test-agents-${process.pid}`) : fileURLToPath(new URL('../.agents', import.meta.url))
export function createHeadless({ root = defaultRoot(), command = agentCommand, trees = new PaneProcessTrees(), openTerminal = spawn } = {}) {
  const registry = join(root, 'registry.json')
  const load = () => {
    try { const rows = JSON.parse(readFileSync(registry, 'utf8')); if (!Array.isArray(rows)) throw new Error('Invalid headless registry'); return rows } catch (err) { if (err.code === 'ENOENT') return []; throw err }
  }
  const save = rows => { mkdirSync(root, { recursive: true }); writeFileSync(registry + '.tmp', JSON.stringify(rows, null, 2)); renameSync(registry + '.tmp', registry) }
  const get = id => { const row = load().find(a => a.id === id); if (!row) throw new Error(`Unknown headless agent ${id}`); return row }
  const patch = (id, value) => bindings.withBoardLock(root, () => { const rows = load(); const row = rows.find(a => a.id === id); if (!row) throw new Error(`Unknown headless agent ${id}`); Object.assign(row, value); save(rows); return row })
  function refresh(row) {
    if (row.exitFile) { try { Object.assign(row, JSON.parse(readFileSync(row.exitFile, 'utf8'))) } catch (err) { if (err.code !== 'ENOENT') throw err } }
    // Session identifiers are emitted at startup, before tool output grows the log.
    if (!row.sessionId && existsSync(row.log)) {
      const fd = openSync(row.log, 'r'), buffer = Buffer.alloc(65536)
      let text
      try { text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8') } finally { closeSync(fd) }
      for (const line of text.split('\n')) { try { const e = JSON.parse(line); row.sessionId = e.thread_id || e.session_id || row.sessionId } catch {} }
    }
    return row
  }
  return {
    async tabCreate({ cwd, label, session }) {
      const id = `headless-${randomUUID()}`
      bindings.withBoardLock(root, () => {
        const rows = load()
        rows.push({ id, name: label, pid: null, cwd, log: join(root, `${id}.log`), startedAt: null, exitCode: null, engine: null, sessionId: null, session })
        save(rows)
      })
      return { root_pane: { pane_id: id, tab_id: id }, tab: { tab_id: id } }
    },
    async agentStart(options) {
      const row = get(options.paneId)
      assertPromptAllowed(options.session ?? row.session, { paneId: options.paneId, action: 'start' })
      const engine = options.kind || (typeof options.engine === 'string' ? options.engine : options.engine?.kind) || 'claude'
      if (engine === 'codex') {
        try { herdr.writeCodexBoardProfile() } catch {}
        // Match herdr: reviewers/checkers do not install hooks into their unchanged snapshot.
        if (options.workspacePath) herdr.writeCodexWorkspaceHooks(options.workspacePath)
      }
      launchArgs({ ...options, workspacePath: options.workspacePath || row.cwd }, '') // validate before reserving the launch
      const taken = new Set(load().filter(a => a.id !== row.id && !a.closedAt && a.name).map(a => a.name))
      let name = options.name
      for (let n = 2; taken.has(name); n++) name = `${options.name}-${n}`
      patch(row.id, { name, engine, options: { ...options, name, workspacePath: options.workspacePath || row.cwd } })
      return { name }
    },
    async agentPrompt(id, prompt, { session } = {}) {
      const row = refresh(get(id))
      assertPromptAllowed(session ?? row.session, { paneId: id, action: 'prompt' })
      if (!row.options) throw new Error('Headless agent must be started before prompting')
      if (row.pid && row.exitCode == null && alive(row.pid)) throw new Error('Headless agent is already working')
      if (row.startedAt && !row.sessionId) throw new Error('Exited agent has no session id to resume')
      const argv = launchArgs(row.options, prompt, row.sessionId)
      const [exe, ...prefix] = command(row.engine)
      const spec = join(root, `${id}.${randomUUID()}.launch.json`)
      // Each turn gets its own exit file, so a previous exit cannot mark a resumed turn done.
      const turnExit = spec + '.exit.json'
      writeFileSync(spec, JSON.stringify({ exe, args: [...prefix, ...argv], cwd: row.options.workspacePath, exitFile: turnExit, log: row.log }))
      const fd = openSync(row.log, 'a')
      let child
      try {
        child = spawn(process.execPath, [supervisor, spec], { cwd: row.cwd, detached: true, stdio: ['ignore', fd, fd, 'ipc'], windowsHide: true, env: { ...herdr.cleanEnv(), PATH: herdr.boardAgentPath(), BOARD_AGENT_ID: id, HERDR_PANE_ID: id } })
        // Record the detached supervisor before waiting for its launch acknowledgement.
        patch(id, { pid: child.pid || null, childPid: null, error: null, startedAt: new Date().toISOString(), exitCode: null, exitFile: turnExit, sessionId: row.sessionId, closedAt: null })
        const launched = await new Promise((resolve, reject) => { child.once('error', reject); child.once('message', msg => msg.error ? reject(new Error(msg.error)) : resolve(msg)); child.once('exit', code => reject(new Error(`Agent launch exited ${code}`))) })
        patch(id, { pid: child.pid, childPid: launched.pid, startedAt: new Date().toISOString(), exitCode: null, exitFile: turnExit, sessionId: row.sessionId })
        child.disconnect(); child.unref()
        // The supervisor acknowledged spawn with the full prompt; a fast exit is
        // a completed turn, not an uncertain delivery.
        return { delivered: true, pid: child.pid }
      } finally { if (child?.connected) child.disconnect(); child?.unref(); closeSync(fd) }
    },
    async agentList(session) {
      if (!existsSync(registry)) return []
      const rows = bindings.withBoardLock(root, () => {
        const rows = load()
        for (const row of rows) refresh(row)
        save(rows)
        return rows
      })
      return rows.filter(a => !a.closedAt && (!session || a.session === session)).map(a => ({ ...a, pane_id: a.id, tab_id: a.id, agent_session: a.sessionId, agent_status: !a.startedAt ? 'idle' : a.exitCode == null && alive(a.pid) ? 'working' : 'done', backend: 'headless' }))
    },
    async paneRead(id) { return tail(get(id).log).split('\n').slice(-200).join('\n') },
    async paneClose(id) {
      const row = get(id)
      for (const pid of [row.pid, row.childPid].filter(Boolean)) {
        if (!alive(pid) || bindings.lockOwnerReplaced(pid, Date.parse(row.startedAt))) continue
        const key = `${id}/${pid}`
        await trees.observe([{ key, shellPid: pid }]); await trees.close(key)
        if (process.platform !== 'win32' && alive(pid)) process.kill(pid === row.pid ? -pid : pid, 'SIGTERM')
      }
      patch(id, { closedAt: new Date().toISOString() })
    },
    async focusAgent(id) {
      const row = get(id)
      const child = openTerminal('wt', ['-w', 'kanban', 'new-tab', '--title', row.name, process.execPath, viewer, row.log], { detached: true, stdio: 'ignore', windowsHide: true })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }); child.unref()
      return row
    },
  }
}
export const headless = createHeadless()
export const { tabCreate, agentStart, agentPrompt, agentList, paneRead, paneClose, focusAgent } = headless
export const waitForPrompt = async () => true
export const agentWorkspaceOr = async () => null
