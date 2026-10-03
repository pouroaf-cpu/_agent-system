import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assignmentFor, engineForAssignment, validateSettingsPatch } from './lib/agent-settings.mjs'
import { builderDifficulty, difficultyFromText } from './lib/difficulty.mjs'
import { findCard, moveCard, validatePlan } from './lib/cards.mjs'
import { recordBuilderAttempt, recordBuilderReturn, readWorkflow } from './lib/workflow-state.mjs'
import { routeBuilderNoHandoff, autoSpawn } from './lib/autospawn.mjs'
import { launchArgs } from './lib/headless.mjs'
import { recordUsageStart, readUsage, usageSummary } from './lib/request-usage.mjs'
import { dailyMetrics } from './lib/metrics.mjs'
import { plannerPrompt } from './lib/prompt.mjs'

function fixture(t, level = 'tiny', lane = 'queue') {
  const root = mkdtempSync(join(tmpdir(), 'difficulty-')), tasks = join(root, 'TASKS')
  mkdirSync(join(tasks, lane), { recursive: true })
  writeFileSync(join(tasks, lane, 'T-1.md'), `# T-1 — difficulty\n**Difficulty:** ${level}\n## Files\n- \`app.mjs\`\n`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, tasks, card: () => findCard(tasks, 'T-1') }
}

test('difficulty defaults, legacy cards, model settings, fallbacks and local opt-in', () => {
  assert.equal(difficultyFromText('**Trivial:** yes'), 'easy')
  assert.equal(difficultyFromText('**Difficulty:** HARD\r\n'), 'hard')
  assert.equal(difficultyFromText('**Trivial:** yes\r\n'), 'easy')
  assert.equal(difficultyFromText('**Difficulty:** hard\n**Trivial:** yes'), 'hard')
  assert.equal(builderDifficulty({}), 'easy') // unrated (pre-difficulty) cards stay on Luna, as planned
  for (const [difficulty, model, reasoning] of [['tiny', 'qwen3-coder', 'none'], ['easy', 'gpt-6-luna', 'low'], ['medium', 'claude-sonnet-5-5', 'medium'], ['hard', 'claude-opus-5-5', 'high']]) {
    const config = { agentSettings: { tinyEnabled: true } }
    const setting = assignmentFor(config, { difficulty }, 'working')
    assert.equal(setting.model, model)
    assert.equal(setting.reasoning, reasoning)
    assert(setting.fallback)
    validateSettingsPatch(config, { [`builder-${difficulty}`]: setting })
  }
  assert.equal(assignmentFor({}, { difficulty: 'tiny' }, 'working').model, 'gpt-6-luna')
  assert.equal(assignmentFor({}, { trivial: true }, 'working').reasoning, 'low')
  const disabledFallback = assignmentFor({ agentSettings: { global: { 'builder-medium': { fallback: { engine: 'codex', model: 'qwen3-coder', reasoning: 'none' } } } } }, { difficulty: 'medium' }, 'working')
  assert.equal(disabledFallback.fallback.model, 'gpt-6-luna', 'local fallbacks also respect opt-in')
  const setting = assignmentFor({ agentSettings: { tinyEnabled: true } }, { difficulty: 'tiny' }, 'working')
  const args = launchArgs({ name: 'b-t-1', model: setting.model, engine: engineForAssignment(setting), browser: false }, 'task')
  assert(args.includes('exec')); assert(args.includes('--oss'))
  assert.equal(args[args.indexOf('--local-provider') + 1], 'ollama')
  assert.equal(args[args.indexOf('--model') + 1], 'qwen3-coder')
  assert(!args.some(a => a.includes('model_reasoning_effort')))
  assert(launchArgs({ name: 'b-t-1', model: setting.model, engine: engineForAssignment(setting) }, 'correction', 'saved').includes('resume'))
})

test('dispatch records effective difficulty and usage before a headless Builder launch', async t => {
  const f = fixture(t)
  let launched
  const started = await autoSpawn({ project: 'Difficulty', projectPath: f.root, tasksDir: f.tasks, boardRoot: f.root, max: 1, agents: [],
    assignmentForCard: (card, stage) => assignmentFor({}, card, stage),
    spawn: async options => {
      launched = options
      const binding = { pane_id: 'headless-test', tab_id: 'headless-test', name: 'b-t-1', agent_session: 'session' }
      options.onPane(binding)
      return binding
    } })
  assert.deepEqual(started, ['T-1'])
  assert.equal(launched.model, 'gpt-6-luna')
  assert.equal(readWorkflow(f.tasks)['T-1'].builderAttempt.difficulty, 'easy')
  assert.equal(Object.values(readUsage(f.tasks).runs)[0].difficulty, 'easy')
  routeBuilderNoHandoff({ tasksDir: f.tasks, cardId: 'T-1', reason: 'Builder exited unsuccessfully' })
  assert.equal(readWorkflow(f.tasks)['T-1'].builderDifficulty, 'medium')
})

test('returns step up once per attempt, cap at hard and survive replanning and restart', async t => {
  const f = fixture(t)
  for (const [difficulty, next] of [['tiny', 'easy'], ['easy', 'medium'], ['medium', 'hard'], ['hard', 'hard']]) {
    const card = moveCard(f.tasks, 'T-1', 'working')
    recordBuilderAttempt(f.tasks, card, difficulty)
    recordUsageStart({ tasksDir: f.tasks, requestId: 'T-1', cardIds: ['T-1'], role: 'builder', paneId: difficulty, difficulty, model: 'test' })
    assert.equal(recordBuilderReturn(f.tasks, card, 'kick-back'), true)
    assert.equal(recordBuilderReturn(f.tasks, card, 'duplicate exit'), false)
    const moved = moveCard(f.tasks, 'T-1', 'planning')
    assert.equal(readWorkflow(f.tasks)['T-1'].builderDifficulty, next)
    writeFileSync(moved.path, readFileSync(moved.path, 'utf8').replace('**Difficulty:** tiny', '**Difficulty:** easy'))
    assert.equal(assignmentFor({}, f.card(), 'working').difficulty, next)
  }
  const history = readFileSync(join(f.tasks, '.history', 'T-1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(history.filter(e => e.event === 'builder-return').length, 4)
  const metrics = (await dailyMetrics(f.tasks, 1))[0]
  for (const d of ['tiny', 'easy', 'medium', 'hard']) assert.deepEqual(metrics.builderDifficulty[d], { attempts: 1, kickBacks: 1 })
  const summary = usageSummary(f.tasks)[0]
  assert.deepEqual(summary.builderDifficulty, metrics.builderDifficulty)
})

test('hkb issue and later missing handoff count one return; direct failed transitions also step up', t => {
  const f = fixture(t, 'easy', 'working')
  recordBuilderAttempt(f.tasks, f.card(), 'easy')
  const result = spawnSync(process.execPath, ['hkb.mjs', '--tasks', f.tasks, 'issue', 'T-1', '[implementation] focused check failed'], { cwd: import.meta.dirname, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(readWorkflow(f.tasks)['T-1'].builderDifficulty, 'medium')
  moveCard(f.tasks, 'T-1', 'working')
  recordBuilderAttempt(f.tasks, f.card(), 'medium')
  routeBuilderNoHandoff({ tasksDir: f.tasks, cardId: 'T-1', reason: 'process ended' })
  assert.equal(readWorkflow(f.tasks)['T-1'].builderDifficulty, 'hard')
  moveCard(f.tasks, 'T-1', 'working')
  moveCard(f.tasks, 'T-1', 'planning')
  assert.equal(readWorkflow(f.tasks)['T-1'].builderDifficulty, 'hard')
})

test('a reported blocker followed by exit cannot step up the same Builder twice', t => {
  const f = fixture(t, 'easy', 'working')
  recordBuilderAttempt(f.tasks, f.card(), 'easy')
  const result = spawnSync(process.execPath, ['hkb.mjs', '--tasks', f.tasks, 'issue', 'T-1', '[evidence] missing proof'], { cwd: import.meta.dirname, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(f.card().column, 'working')
  routeBuilderNoHandoff({ tasksDir: f.tasks, cardId: 'T-1', reason: 'process ended' })
  assert.equal(readWorkflow(f.tasks)['T-1'].builderDifficulty, 'medium')
})

test('failed integration and review returns step up the next Builder', t => {
  for (const lane of ['completed', 'review']) {
    const f = fixture(t, 'easy', 'working')
    recordBuilderAttempt(f.tasks, f.card(), 'easy')
    moveCard(f.tasks, 'T-1', lane)
    moveCard(f.tasks, 'T-1', 'queue', { correction: true })
    assert.equal(readWorkflow(f.tasks)['T-1'].builderDifficulty, 'medium')
  }
})

test('Planner prompt requires Difficulty and authenticated plans reject missing or invalid levels', () => {
  const prompt = plannerPrompt({ cards: [], projectPath: '.', boardRoot: '.', tasksDir: '.' })
  assert.match(prompt, /PLANNER-DIFFICULTY\.md/)
  assert.match(prompt, /Set \*\*Difficulty:\*\*/)
  assert.throws(() => validatePlan('**Plan readiness:** investigation', { requireReadiness: true }), /Difficulty/)
  assert.throws(() => validatePlan('**Difficulty:** impossible'), /Difficulty/)
})
