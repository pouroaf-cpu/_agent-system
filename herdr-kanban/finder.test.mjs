// HK29: a read-only Haiku Finder lists the code a card touches before its Planner starts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCard, findCard, readBoard } from './lib/cards.mjs'
import { runCardPlanner, readCardPlanners, busyPlanners, parseFinderList, finderText, writeFinderList, FINDER_TIMEOUT_MS } from './lib/card-planner.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'
import { stageIndicators } from './lib/stage-indicators.mjs'
import { agentStartArgs } from './lib/herdr.mjs'
import { plannerPrompt, finderPrompt } from './lib/prompt.mjs'
import { agentName, agentRole } from './lib/ids.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const LIST = [
  '`herdr-kanban/lib/card-planner.mjs` lines 107-109, `busyPlanners` \u2014 counts the slot',
  '`herdr-kanban/lib/ids.mjs` lines 15-20, `ROLES` \u2014 role letters',
]
const T0 = Date.parse('2026-10-13T00:00:00Z')

// An injected io whose agents the test moves between working and done by hand.
function harness(dir, { failFinderStart = false, outputs = {} } = {}) {
  const agents = [], names = [], closed = []
  let panes = 0
  const io = {
    agentList: async () => agents.map(a => ({ ...a })), agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
    tabCreate: async () => ({ root_pane: { pane_id: `p${++panes}` } }),
    agentStart: async ({ name, paneId }) => {
      names.push(name)
      if (failFinderStart && name.startsWith('f-')) throw new Error('claude would not start')
      agents.push({ name, pane_id: paneId, agent_status: 'working' })
    },
    deliver: async () => {}, paneClose: async paneId => { closed.push(paneId) },
    paneRead: async paneId => outputs[paneId] ?? '', recordUsageStart: () => {}, recordUsageFinish: async () => {},
  }
  const run = (now, extra = {}) => runCardPlanner({ project: 'P', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'claude-sonnet-5-5', finder: true, io, now, ...extra })
  const setStatus = (name, agent_status) => { agents.find(a => a.name === name).agent_status = agent_status }
  return { run, agents, names, closed, outputs, setStatus }
}

test('AC1: a card goes through the Finder, shows it on the board, and holds one slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finder-ac1-'))
  try {
    const one = createCard(dir, { title: 'First card', brief: 'x' })
    const two = createCard(dir, { title: 'Second card', brief: 'y' })
    const h = harness(dir)
    await h.run(T0, { maxPlanners: 1 })
    assert.deepEqual(h.names, [agentName('finder', one.id)])
    assert.equal(agentRole(h.names[0]), 'f')
    assert.equal(readWorkflow(dir)[one.id].finder.running, true)
    assert.equal(readCardPlanners(dir)[one.id], undefined, 'no Planner yet')
    const indicators = stageIndicators({ tasksDir: dir, board: readBoard(dir), planners: readCardPlanners(dir), claims: [], agents: h.agents, workflow: readWorkflow(dir) })
    assert.equal(indicators[one.id].stage, 'Finder')
    assert.equal(indicators[one.id].status, 'working')
    assert.equal(busyPlanners(h.agents), 1)

    // The second card waits for the one slot while the Finder is working.
    await h.run(T0 + 1000, { maxPlanners: 1 })
    assert.deepEqual(h.names, [agentName('finder', one.id)])
    assert.equal(readWorkflow(dir)[two.id]?.finder, undefined)

    // The Finder prints its list and exits: the section is written and the Planner starts.
    h.outputs.p1 = LIST.join('\n')
    h.setStatus(h.names[0], 'done')
    await h.run(T0 + 20000, { maxPlanners: 1 })
    assert.equal(h.names[1], agentName('planner', one.id))
    const text = readFileSync(findCard(dir, one.id).path, 'utf8')
    assert.match(text, /^## Finder list\r?\n- `herdr-kanban\/lib\/card-planner\.mjs` lines 107-109, `busyPlanners`/m)
    assert.equal(readWorkflow(dir)[one.id].finder.status, 'listed')
    assert.equal(readWorkflow(dir)[one.id].finder.lines, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('AC2: the Finder starts on claude-haiku-5-5 with Read, Grep and Glob only', () => {
  const args = agentStartArgs({ name: 'f-hk29', paneId: 'p1', model: 'claude-haiku-5-5', engine: { kind: 'claude' }, browser: false })
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5')
  const tools = args[args.indexOf('--tools') + 1]
  assert.equal(tools, 'Read,Grep,Glob')
  for (const banned of ['Edit', 'Write', 'Bash', 'PowerShell']) assert.ok(!tools.split(',').includes(banned), banned)
  assert.match(args[args.indexOf('--settings') + 1], /claude-planner-settings\.json$/)
  assert.throws(() => agentStartArgs({ name: 'f-hk29', paneId: 'p1', model: 'claude-sonnet-5-5', engine: { kind: 'claude' }, browser: false }), /claude-haiku-5-5/)
  const planner = agentStartArgs({ name: 'p-hk29', paneId: 'p1', model: 'claude-sonnet-5-5', engine: { kind: 'claude' }, browser: false })
  assert.ok(!planner[planner.indexOf('--tools') + 1].split(',').includes('Agent'), 'the Planner has no sub agent tool')
})

test('AC3: only lines in the list format reach the card', () => {
  const sample = [
    LIST[0],
    '- `public/board.js` lines 378-398, `ROLE_VERB` \u2014 stage verbs',
    'I searched the repository and found the following places:',
    '`/etc/passwd` lines 1-5, `x` \u2014 absolute path',
    '`C:/Windows/win.ini` lines 1-5, `x` \u2014 drive path',
    '`..\\secrets.txt` lines 1-5, `x` \u2014 outside the repo',
    '`lib/a.mjs` lines 9-3, `back` \u2014 end before start',
    '`lib/b.mjs` lines 0-3, `zero` \u2014 starts at zero',
    '`lib/c.mjs` lines 1-3, `noReason`',
    LIST[0],
    LIST[1],
  ].join('\n')
  assert.deepEqual(parseFinderList(sample), [LIST[0], '`public/board.js` lines 378-398, `ROLE_VERB` \u2014 stage verbs', LIST[1]])
  assert.equal(parseFinderList(Array.from({ length: 60 }, (_, i) => `\`a/f${i}.mjs\` lines 1-2, \`n\` \u2014 w`).join('\n')).length, 40)
  // A headless log tail is stream-json; only the agent's text is read.
  const log = [JSON.stringify({ type: 'system' }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }, { type: 'text', text: LIST[1] }] } }), JSON.stringify({ type: 'result', result: `${LIST[0]}\nsome prose` })].join('\n')
  assert.deepEqual(parseFinderList(finderText(log)), [LIST[1], LIST[0]])

  const dir = mkdtempSync(join(tmpdir(), 'finder-ac3-'))
  try {
    const card = createCard(dir, { title: 'Card', brief: 'x' })
    writeFinderList(findCard(dir, card.id), parseFinderList(sample))
    writeFinderList(findCard(dir, card.id), parseFinderList(sample)) // a second write replaces the first
    const text = readFileSync(findCard(dir, card.id).path, 'utf8')
    assert.equal((text.match(/^## Finder list/gm) || []).length, 1)
    const section = text.split(/^## Finder list\r?\n/m)[1].split(/^## /m)[0].trim().split(/\r?\n/)
    assert.deepEqual(section, parseFinderList(sample).map(l => `- ${l}`))
    assert.doesNotMatch(text, /I searched the repository/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The card must reach the Planner with no list, and the Finder must not run again.
async function endsAtPlanner(options, steps) {
  const dir = mkdtempSync(join(tmpdir(), 'finder-ac4-'))
  try {
    const card = createCard(dir, { title: 'Card', brief: 'x' })
    const h = harness(dir, options.harness)
    await steps(h)
    assert.ok(h.names.includes(agentName('planner', card.id)), `a Planner started: ${h.names}`)
    assert.doesNotMatch(readFileSync(findCard(dir, card.id).path, 'utf8'), /## Finder list/)
    const finder = readWorkflow(dir)[card.id].finder
    assert.equal(finder.done, true)
    assert.equal(finder.status, options.status)
    const finderStarts = h.names.filter(n => n.startsWith('f-')).length
    await h.run(T0 + FINDER_TIMEOUT_MS * 3)
    await h.run(T0 + FINDER_TIMEOUT_MS * 4)
    assert.equal(h.names.filter(n => n.startsWith('f-')).length, finderStarts, 'no second Finder')
    assert.equal(finderStarts, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('AC4: a Finder that fails to start does not hold the card', async () => {
  await endsAtPlanner({ harness: { failFinderStart: true }, status: 'failed' }, async h => { await h.run(T0) })
})

test('AC4: a Finder that never exits is cut off at the timeout', async () => {
  await endsAtPlanner({ status: 'timeout' }, async h => {
    await h.run(T0)
    await h.run(T0 + FINDER_TIMEOUT_MS - 1000) // still working, still waiting
    assert.deepEqual(h.names.filter(n => n.startsWith('p-')), [])
    await h.run(T0 + FINDER_TIMEOUT_MS)
    assert.ok(h.closed.includes('p1'), 'the Finder pane is closed')
  })
})

test('AC4: a Finder that prints only prose leaves no list', async () => {
  await endsAtPlanner({ status: 'empty', harness: { outputs: { p1: 'I looked through the repository but I am not sure what to list.' } } }, async h => {
    await h.run(T0)
    h.setStatus(h.names[0], 'done')
    await h.run(T0 + 20000)
  })
})

test('AC5: the Planner prompt and PLANNER.md say to read the Finder list first', () => {
  const local = join(here, '..', '_roles', 'PLANNER.md')
  const role = readFileSync(existsSync(local) ? local : 'C:/Users/PFrew/Projects/_roles/PLANNER.md', 'utf8')
  const prompt = plannerPrompt({ cards: [{ id: 'IA999', category: 'code', column: 'planning', path: 'C:/fake/card.md' }], projectPath: 'C:/fake', boardRoot: here, tasksDir: null, engine: 'claude' })
  for (const [name, text] of [['plannerPrompt', prompt], ['PLANNER.md', role]]) {
    assert.match(text, /Finder list/, name)
    assert.match(text, /open those ranges directly/, name)
    assert.match(text, /only when a pointer is wrong or the list is short/, name)
  }
  const finder = finderPrompt({ card: { id: 'IA999', path: 'C:/fake/card.md' }, projectPath: 'C:/fake' })
  assert.match(finder, /read-only/)
  assert.match(finder, /lines START-END/)
})
