import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const starts = [], claims = []
mock.module('./lib/herdr.mjs', { namedExports: {
  approvedManagedModel: () => ['gpt-6.1-sol', 'gpt-6-luna', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  sessionOf: p => p.toLowerCase(), herdrLog: () => {}, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
  tabCreate: async () => ({ root_pane: { pane_id: 'r1' } }), agentStart: async args => { starts.push(args) },
  agentList: async () => [{ pane_id: 'r1', agent_status: 'working' }], agentsForProject: async () => [],
  agentPrompt: async () => {}, paneRead: async () => '', paneSendKeys: async () => {}, paneClose: async () => {},
  isSpawning: () => false, beginSpawn: () => {}, endSpawn: () => {},
} })
mock.module('./lib/review-claims.mjs', { namedExports: {
  syncReviewClaims: () => [], readReviewClaims: () => [], reserveReview: () => ({ id: 'c1' }),
  prepareReviewSnapshot: (root, projectPath) => ({ path: projectPath }),
  updateReviewClaim: (root, id, patch) => { claims.push(patch) }, failReviewClaim: () => {},
  assertReviewInputs: () => {}, snapshotContains: () => true, reviewClaimFor: () => null,
} })

const { assignmentFor, globalSettings, validateSettingsPatch } = await import('./lib/agent-settings.mjs')
const { blockEngine, quotaKey, quotaHolds, selectQuotaAssignment } = await import('./lib/quota.mjs')
const { runCardPlanner, readCardPlanners } = await import('./lib/card-planner.mjs')
const { autoSpawn, holdsFor, spawnReviewer } = await import('./lib/autospawn.mjs')
const { readBindings } = await import('./lib/bindings.mjs')
const { createCard, findCard } = await import('./lib/cards.mjs')
const plan = '**Workflow:** card-owned\n## Approved brief\nDeliver\n## Files\n- `app.mjs` result\n## Implementation plan\nChange app.mjs\n## Acceptance criteria\n- AC1: result\n## Outcome checks\nAC1 | app.mjs | node check.mjs | break it\n## Prerequisites\nNone\n'

test('role fallbacks survive config/API validation, launch on quota, hold if both blocked, and return to primary after reset', async t => {
  const root = mkdtempSync(join(import.meta.dirname, '.quota-fallback-'))
  const configPath = join(root, 'board.config.json'), previous = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = configPath
  t.after(() => { if (previous === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = previous; rmSync(root, { recursive: true, force: true }) })
  const primary = { engine: 'codex', model: 'gpt-6-luna', reasoning: 'high' }
  const fallback = { engine: 'claude', model: 'claude-haiku-4-5', reasoning: 'medium' }
  const patch = Object.fromEntries(['planning', 'working', 'trivial', 'review'].map(role => [role, { ...primary, fallback }]))
  const config = { projectsRoot: root, projects: [], maxConcurrentAgents: 1, agentPollMs: 3600000, engine: 'codex', models: { working: primary.model } }
  config.agentSettings = { global: validateSettingsPatch(config, patch) }
  writeFileSync(configPath, JSON.stringify(config))
  assert.deepEqual(globalSettings(config).planning.fallback, fallback)
  assert.deepEqual(validateSettingsPatch(config, { working: { reasoning: 'low' } }).working.fallback, fallback)
  assert.equal(validateSettingsPatch(config, { working: { fallback: null } }).working.fallback, undefined)
  for (const invalid of [{ ...fallback, engine: 'unknown' }, { ...fallback, model: primary.model }, { ...fallback, reasoning: 'bogus' }, { ...fallback, model: 'claude-sonnet-4-6' }]) {
    assert.throws(() => validateSettingsPatch(config, { working: { fallback: invalid } }))
  }

  const now = Date.now(), until = now + 3600000
  for (const scope of ['engine', 'model']) for (const state of ['primary blocked', 'both blocked', 'expired']) for (const role of ['planning', 'working', 'trivial', 'review']) {
    writeFileSync(join(root, '.engine-quota.json'), '{}')
    blockEngine(root, quotaKey('codex', scope === 'model' ? primary.model : null), until, now)
    if (state === 'both blocked') blockEngine(root, 'claude', until, now)
    const clock = state === 'expired' ? until + 1 : now
    const tasksDir = join(root, `${scope}-${state}-${role}`, 'TASKS')
    mkdirSync(tasksDir, { recursive: true })
    let card
    if (role === 'planning') card = createCard(tasksDir, { title: 'Quota proof', brief: 'A specific approved outcome' })
    else {
      const lane = role === 'review' ? 'review' : 'queue'
      mkdirSync(join(tasksDir, lane))
      writeFileSync(join(tasksDir, lane, 'T-1.md'), '# T-1 — quota proof\n' + (role === 'trivial' ? '**Trivial:** yes\n' : '') + plan)
      card = findCard(tasksDir, 'T-1')
    }
    const assigned = (card, stage) => assignmentFor(config, card, stage)
    const options = { project: `${scope}-${state}-${role}`, projectPath: join(tasksDir, '..'), tasksDir, boardRoot: root, assignmentForCard: assigned, now: clock }
    starts.length = 0; claims.length = 0
    const expected = state === 'expired' ? primary : fallback
    const shouldHold = state === 'both blocked'
    const choice = selectQuotaAssignment(root, assigned(card, role), clock)
    const holds = quotaHolds(root, { [card.column]: [card] }, () => quotaKey(choice.assignment.engine, choice.assignment.model), clock)
    assert.equal(Boolean(holds[card.id]), shouldHold, 'board holds match launch availability')
    if (role === 'planning') {
      let agents = []
      const io = { agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
        tabCreate: async () => ({ root_pane: { pane_id: 'p1' } }),
        agentStart: async args => { starts.push(args); agents = [{ name: args.name, pane_id: 'p1', agent_status: 'working' }] },
        deliver: async () => {}, recordUsageStart: () => {}, recordUsageFinish: async () => {}, paneClose: async () => {}, paneRead: async () => '' }
      const result = await runCardPlanner({ ...options, io })
      assert.equal(result === null, shouldHold)
      if (!shouldHold) { const owner = readCardPlanners(tasksDir)[card.id]; assert.equal(owner.engine, expected.engine); assert.equal(owner.model, expected.model) }
    } else if (role === 'review') {
      if (shouldHold) await assert.rejects(spawnReviewer({ ...options, inventory: async () => [] }), e => e.busy && /usage limit/.test(e.message))
      else {
        const result = await spawnReviewer({ ...options, inventory: async () => [] })
        assert.equal(result.model, expected.model)
        assert.ok(claims.some(c => c.engine === expected.engine && c.model === expected.model))
      }
    } else {
      const result = await autoSpawn({ ...options, max: 1, agents: [], spawn: async args => { starts.push(args); args.onPane({ pane_id: 'b1' }); return { pane_id: 'b1' } } })
      assert.equal(result.length, shouldHold ? 0 : 1)
      if (shouldHold) assert.match(holdsFor(options.project)[card.id], /usage limit/)
      else { const binding = readBindings(tasksDir)[card.id]; assert.equal(binding.engine, expected.engine); assert.equal(binding.model, expected.model) }
    }
    assert.equal(starts.length, shouldHold ? 0 : 1, `${scope} ${state} ${role}`)
    if (!shouldHold) {
      assert.equal(starts[0].model, expected.model)
      assert.equal(starts[0].engine.kind, expected.engine)
      if (expected.engine === 'codex') assert.deepEqual(starts[0].engine.reasoningArgs, ['-c', 'model_reasoning_effort="high"'])
      if (state === 'primary blocked') assert.ok(readFileSync(join(tasksDir, 'activity.log'), 'utf8').includes(`started on fallback ${fallback.model}: ${primary.model} usage limit until ${new Date(until).toISOString()}`))
    }
    assert.deepEqual(globalSettings(config).planning, patch.planning, 'launch never rewrites primary')
  }
  // A model cap can use another model on the same engine; an account block cannot.
  writeFileSync(join(root, '.engine-quota.json'), '{}')
  blockEngine(root, quotaKey('codex', primary.model), until, now)
  const sameEngine = { ...primary, fallback: { ...primary, model: 'gpt-6.1-sol' } }
  assert.equal(selectQuotaAssignment(root, sameEngine, now).assignment.model, 'gpt-6.1-sol')
  blockEngine(root, 'codex', until, now)
  assert.ok(selectQuotaAssignment(root, sameEngine, now).hold)

  // Exercise the real config route on a private port and config; no live board access.
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  config.port = socket.address().port
  config.maxConcurrentAgents = 0
  await new Promise(resolve => socket.close(resolve))
  writeFileSync(configPath, JSON.stringify(config))
  const child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, env: { ...process.env, HERDR_BIN_PATH: 'missing-herdr-for-fallback-test' }, stdio: 'ignore' })
  t.after(() => child.kill())
  const base = `http://127.0.0.1:${config.port}`
  for (let i = 0; ; i++) {
    try { if ((await fetch(base)).ok) break } catch {}
    if (i > 80 || child.exitCode !== null) throw new Error('private board did not start')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const response = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSettings: patch }) })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).config.agentSettings.global.planning.fallback, fallback)
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).agentSettings.global.review.fallback, fallback)
  const rejected = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentSettings: { review: { fallback: { ...fallback, model: 'claude-opus-5-5' } } } }) })
  assert.equal(rejected.status, 400)
  child.kill()
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
})
