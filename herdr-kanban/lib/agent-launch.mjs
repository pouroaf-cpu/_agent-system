// What a board agent is launched with: the models each role may use, the argv each engine
// starts with, the Codex profile and Stop hook it reads, and the env it inherits. Shared by the
// headless transport (lib/headless.mjs) and the CLI helpers, so none of them needs the herdr module.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentRole } from './ids.mjs'

const CLAUDE_AGENT_SETTINGS = fileURLToPath(new URL('../claude-agent-settings.json', import.meta.url))
// Same file with the ponytail plugin off (operator, 2026-10-13): a Planner writes no code and
// the hook cost about 1.8k tokens on every Planner call. A test keeps the two files in step.
const CLAUDE_PLANNER_SETTINGS = fileURLToPath(new URL('../claude-planner-settings.json', import.meta.url))
const CLAUDE_BROWSER_MCP =fileURLToPath(new URL('../claude-browser-mcp.json', import.meta.url))
// The built-ins board agents called in 135 audited runs; the rest (Artifact alone ~12.9k
// tokens) rode along on every call. MCP tools are not affected by --tools.
const CLAUDE_BOARD_TOOLS = 'Bash,PowerShell,Read,Edit,Write,Grep,Glob,ToolSearch,TaskStop'
// The Finder only reads: no Bash, PowerShell, Edit or Write, so it cannot edit files or run git.
const CLAUDE_FINDER_TOOLS = 'Read,Grep,Glob'

// Codex board profile: `codex -p board` layers ~/.codex/board.config.toml on the user config.
// It turns off the curated Vercel and Google Drive skills (~3.3k tokens a call, never used by
// board agents). Those plugins are enabled account-side, so only per-SKILL.md entries work, and
// passing them with -c made a 7.8 KB start command. Rewritten at each Codex start so a plugin
// update's new version folder is covered; its entries add to the user's own skills.config list.
// bin/ first on board agents' PATH: its npm refuses installs through a card checkout's shared
// node_modules link (Tradeflow TF103/TF105, 2026-09-27). Codex takes PATH literally (no
// expansion), so it is the board's own PATH with bin/ in front. Claude's shells ignore a
// settings PATH: claude-agent-settings.json prepends bin/ for Bash (CLAUDE_ENV_FILE) and a
// PreToolUse hook runs the same check on PowerShell commands.
export const NPM_SHIM_DIR = fileURLToPath(new URL('../bin', import.meta.url))
export const boardAgentPath = (path = process.env.PATH || '') => [NPM_SHIM_DIR, ...path.split(';').filter(p => p && p !== NPM_SHIM_DIR)].join(';')
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')
export const CODEX_BOARD_PROFILE = join(CODEX_HOME, 'board.config.toml')
export function writeCodexBoardProfile() {
  const cache = join(CODEX_HOME, 'plugins', 'cache', 'openai-curated-remote')
  const list = dir => { try { return readdirSync(dir) } catch { return [] } }
  const skills = ['vercel', 'google-drive'].flatMap(plugin => list(join(cache, plugin)).flatMap(version =>
    list(join(cache, plugin, version, 'skills')).map(skill => join(cache, plugin, version, 'skills', skill, 'SKILL.md'))))
    .filter(path => existsSync(path))
  const toml = '# Written by herdr-kanban for board agents (codex -p board). Do not edit.\n' +
    skills.map(path => `\n[[skills.config]]\npath = '${path}'\nenabled = false\n`).join('') +
    // JSON string escapes are valid TOML basic-string escapes.
    `\n[shell_environment_policy.set]\nPATH = ${JSON.stringify(boardAgentPath())}\n`
  try { if (readFileSync(CODEX_BOARD_PROFILE, 'utf8') === toml) return } catch {}
  writeFileSync(CODEX_BOARD_PROFILE, toml)
}

// Board-only Codex Stop hook: nobody reads a board agent's chat, so a question or
// blocker left there as plain text stalls the card (scripts/codex-stop-hook.mjs has
// the policy). ~/.codex/hooks.json is off limits, and a board.config.toml profile's
// hooks.state can only toggle a hook already discovered elsewhere, not define a new
// one (confirmed empirically, 2026-09-27) — so this is registered the one place Codex
// discovers a hook scoped to a single directory: <workspacePath>/.codex/hooks.json.
// Every card's workspace is its own disposable git worktree (lib/worktrees.mjs), so
// this never reaches the operator's own Codex chats, which never cd into one.
// Idempotent merge: a project's own committed .codex/hooks.json, if any, keeps its
// other hooks; only our Stop entry is added or replaced.
const CODEX_STOP_HOOK = fileURLToPath(new URL('../scripts/codex-stop-hook.mjs', import.meta.url))
export function writeCodexWorkspaceHooks(workspacePath) {
  if (!workspacePath) return
  const file = join(workspacePath, '.codex', 'hooks.json')
  const command = `node ${JSON.stringify(CODEX_STOP_HOOK)}`
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { doc = {} }
  const kept = (doc.hooks?.Stop || []).filter(entry => !(entry.hooks?.length === 1 && entry.hooks[0].command === command))
  const next = { ...doc, hooks: { ...doc.hooks, Stop: [...kept, { hooks: [{ type: 'command', command, timeout: 30 }] }] } }
  const text = JSON.stringify(next, null, 2)
  try { if (readFileSync(file, 'utf8') === text) return } catch {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
// herdr's panes inherit its env: a server started from a Claude chat gave every agent pane
// that chat's CLAUDE_CODE_HOST_SESSION_ID, so its state hooks treated agents as that chat (2026-10-02).
export const cleanEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^CLAUDE/i.test(k)))
// By role letter (see ids.mjs), so old kb-* and new b-/p-/r-/i-/a- names match alike.
// Operator's Claude fallback while Codex is out of usage (2026-09-26): Opus 5.5 plans, Sonnet 5 builds, Haiku 4.5 anywhere.
// Operator 2026-09-28: Builders on Codex gpt-6-sol for speed; 2026-09-30: gpt-6.1-sol (Codex 0.159.2+).
// Operator 2026-10-09: Planners and the plan check on claude-haiku-5-5, every Builder on gpt-6-luna.
// Operator 2026-09-27: Planners on Codex gpt-6-luna to balance usage; claude-opus-5-5 (was 4-6: its cache reads cost ~2.5x) plans cards a Codex Planner could not.
const BOARD_MODELS = {
  r: ['gpt-5.6-luna', 'gpt-6-luna', 'claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-5'],
  a: ['gpt-5.6-luna', 'gpt-6-luna', 'claude-haiku-4-5'],
  i: ['gpt-5.6-luna', 'gpt-6-luna', 'claude-opus-5-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
  f: ['claude-haiku-5-5'],
  p: ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-6', 'claude-haiku-5-5', 'claude-haiku-4-5'],
  b: ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'qwen3-coder', 'claude-opus-5-5'],
}

export function approvedManagedModel(name) {
  return BOARD_MODELS[agentRole(name)] ?? null
}

export function assertManagedModel({ name, model }) {
  const expected = approvedManagedModel(name)
  if (!expected) {
    if (/astra/i.test(model || '')) throw new Error(`model ${model} is not allowed for managed HERDR launches`)
    return
  }
  const allowed = Array.isArray(expected) ? expected : [expected]
  if (!allowed.includes(model)) throw new Error(`${name} must use model ${allowed.join(' or ')}, got ${model || '(default)'}`)
}

export function agentStartArgs({ name, paneId, model, engine, kind, workspacePath, guardArgs = [], timeoutMs = 90000, browser = true }) {
  const cfg = typeof engine === 'string' ? { kind: engine } : (engine || {})
  const agentKind = kind || cfg.kind || 'claude'
  const args = ['agent', 'start', name, '--kind', agentKind, '--pane', paneId, '--timeout', String(timeoutMs)]
  // Board agents run unattended, so a permission prompt is a pane that hangs
  // until its timeout with nobody there to answer it. Every spawn path (builder,
  // planner, reviewer) calls agentStart, so the flag belongs here rather
  // than at three call sites.
  assertManagedModel({ name, model })
  args.push('--')
  if (agentKind === 'codex') {
    if (workspacePath) args.push('--cd', workspacePath)
    if (cfg.sandbox) {
      if (!['read-only', 'workspace-write'].includes(cfg.sandbox)) throw new Error('unsupported managed sandbox')
      if (!['on-request', 'never'].includes(cfg.approvalPolicy || 'on-request')) throw new Error('unsupported managed approval policy')
      args.push('--sandbox', cfg.sandbox, '--ask-for-approval', cfg.approvalPolicy || 'on-request')
    } else args.push('--dangerously-bypass-approvals-and-sandbox')
    args.push('-c', 'check_for_update_on_startup=false')
    // Workers skip the orchestrator's Grill Me intake hook and the impeccable design lint
    // (PostToolUse and the Stop "Design deep pass"). -c splits a dotted path on every '.',
    // so hook ids (which contain '.codex\hooks.json') only work inside an inline table,
    // which Codex merges into the user's hooks.state rather than replacing it.
    if (!/orchestrator/i.test(name || '')) {
      const hooks = ['user_prompt_submit:0:0', 'post_tool_use:0:0', 'stop:1:0'].map(id => String.raw`'C:\Users\PFrew\.codex\hooks.json:` + id + `'={enabled=false}`)
      args.push('-c', `hooks.state={${hooks.join(',')}}`)
      if (existsSync(CODEX_BOARD_PROFILE)) args.push('-p', 'board')
      // The workspace's own .codex/hooks.json (writeCodexWorkspaceHooks) carries the board
      // Stop hook; unattended board agents can't answer its one-time hook-trust prompt.
      args.push('--dangerously-bypass-hook-trust')
    }
    // Browser MCPs start ~4 node processes per Codex agent; 27 idle agents' worth
    // overloaded herdr (2026-09-24). Agents whose cards don't browse start without them.
    if (!browser) for (const server of ['chrome-devtools', 'playwright', 'node_repl']) args.push('-c', `mcp_servers.${server}.enabled=false`)
    if (model === 'qwen3-coder') {
      if (cfg.localProvider !== 'ollama') throw new Error('qwen3-coder requires the enabled local Ollama assignment')
      args.push('--oss', '--local-provider', 'ollama')
    }
    if (model) args.push('--model', model)
    if (Array.isArray(cfg.reasoningArgs)) args.push(...cfg.reasoningArgs.map(String))
    args.push(...guardArgs)
  } else {
    args.push('--dangerously-skip-permissions')
    // --disable-slash-commands drops the skill listing; cards name skills by SKILL.md path.
    args.push('--tools', agentRole(name) === 'f' ? CLAUDE_FINDER_TOOLS : CLAUDE_BOARD_TOOLS, '--disable-slash-commands')
    // Same rule as the Codex branch: no user MCPs or claude.ai connectors, and the browser MCP
    // only when the card browses.
    args.push('--strict-mcp-config')
    if (browser) args.push('--mcp-config', CLAUDE_BROWSER_MCP)
    // HERDR started from a Claude session passes on its CLAUDE_CODE_CHILD_SESSION
    // marker, which turns off transcript saving, and the transcript is where the
    // board reads a Claude agent's token usage.
    args.push('--settings', ['p', 'f'].includes(agentRole(name)) ? CLAUDE_PLANNER_SETTINGS : CLAUDE_AGENT_SETTINGS)
    // "user" and "project" settings both walk up to the operator's home directory and
    // load ~/.claude/CLAUDE.md on every call (audit 2026-10-12-herdr-kanban-planner-token-
    // efficiency, Finding 1): that file is written for the operator's interactive chats and
    // its own first line tells board agents to skip it, but Claude Code loads it anyway.
    // "local" keeps only the project's own .claude/settings.local.json; anything board agents
    // still need from the user/project sources (the ponytail hook, for one) is restated in
    // the --settings file above instead, which always applies.
    args.push('--setting-sources', 'local')
    // Session title in the Claude app matches the herdr agent name.
    if (name) args.push('--name', name)
    if (model) args.push('--model', model)
    if (cfg.effort) args.push('--effort', cfg.effort)
  }
  return args
}
