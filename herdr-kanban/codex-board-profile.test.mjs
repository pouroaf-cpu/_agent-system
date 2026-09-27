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
    assert.ok(args.join(' ').length < 1500, 'start command stays short')
  } finally { delete process.env.CODEX_HOME; rmSync(home, { recursive: true, force: true }) }
})
