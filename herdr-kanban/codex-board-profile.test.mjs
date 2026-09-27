import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Board Codex agents start with -p board, whose file turns off the curated Vercel skills
// (builder token audit F2). Passing them with -c made a 7.8 KB start command (2026-09-27).
test('Codex workers get the board profile listing the curated plugin skills', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  try {
    const skill = join(home, 'plugins', 'cache', 'openai-curated-remote', 'vercel', '1.0.0', 'skills', 'nextjs')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '# nextjs')
    process.env.CODEX_HOME = home
    const { writeCodexBoardProfile, agentStartArgs, CODEX_BOARD_PROFILE } = await import('./lib/herdr.mjs')
    writeCodexBoardProfile()
    const toml = readFileSync(CODEX_BOARD_PROFILE, 'utf8')
    assert.match(toml, /\[\[skills\.config\]\]\npath = '.+nextjs[\\/]SKILL\.md'\nenabled = false/)
    // The npm guard (bin/) goes first on the shell PATH, keeping the rest of PATH.
    const { NPM_SHIM_DIR, boardAgentPath } = await import('./lib/herdr.mjs')
    assert.equal(toml.match(/\[shell_environment_policy\.set\]\nPATH = (".*")\n/)?.[1], JSON.stringify(boardAgentPath()))
    assert.deepEqual(boardAgentPath(`C:\\a;${NPM_SHIM_DIR};C:\\b`).split(';'), [NPM_SHIM_DIR, 'C:\\a', 'C:\\b'])
    const args = agentStartArgs({ name: 'b-t-1', paneId: 'w:p1', model: 'gpt-6-luna', engine: { kind: 'codex' }, workspacePath: 'C:/x', browser: false })
    assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2), ['-p', 'board'])
    assert.ok(args.includes('--dangerously-bypass-hook-trust'), 'unattended board agents cannot answer a hook-trust prompt')
    assert.ok(args.join(' ').length < 1500, 'start command stays short')
    // The orchestrator keeps its own full Codex environment: no board profile, no
    // bypassed hook trust, no board Stop hook (agentStartArgs, agentStart both gate on it).
    const orchestratorArgs = agentStartArgs({ name: 'orchestrator', paneId: 'w:p2', engine: { kind: 'codex' }, workspacePath: 'C:/x', browser: false })
    assert.equal(orchestratorArgs.includes('--dangerously-bypass-hook-trust'), false)
    assert.equal(orchestratorArgs.includes('-p'), false)
  } finally { delete process.env.CODEX_HOME; rmSync(home, { recursive: true, force: true }) }
})

// Nobody reads a board agent's chat, so a stopped agent's question or blocker needs the
// same Stop hook Claude board agents get (scripts/agent-stop-hook.mjs) — but Codex only
// discovers a NEW hook from a hooks.json it finds by cwd; a board.config.toml profile's
// hooks.state can only toggle one already discovered elsewhere (confirmed empirically
// against codex-cli 0.156.1, 2026-09-27). Each card's own worktree is that cwd.
test('writeCodexWorkspaceHooks registers the board Stop hook in the workspace, keeping any hooks already there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-workspace-'))
  try {
    const { writeCodexWorkspaceHooks } = await import('./lib/herdr.mjs')
    const hooksFile = join(root, '.codex', 'hooks.json')
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(hooksFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }))
    writeCodexWorkspaceHooks(root)
    const doc = JSON.parse(readFileSync(hooksFile, 'utf8'))
    assert.deepEqual(doc.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo hi' }] }], 'a project\'s own hook is preserved')
    assert.equal(doc.hooks.Stop.length, 1)
    assert.match(doc.hooks.Stop[0].hooks[0].command, /codex-stop-hook\.mjs/)
    const before = readFileSync(hooksFile, 'utf8')
    writeCodexWorkspaceHooks(root) // idempotent: no duplicate Stop entries, no rewrite
    assert.equal(readFileSync(hooksFile, 'utf8'), before)
    assert.equal(JSON.parse(before).hooks.Stop.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
