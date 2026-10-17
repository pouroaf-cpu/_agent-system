// HK29: a read-only Haiku Finder lists the code a card touches before its Planner starts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCard, findCard, readBoard } from './lib/cards.mjs'
import { runCardPlanner, readCardPlanners, busyPlanners, parseFinderList, finderText, writeFinderList, parseFinderSize, declaredFileCount, sizeWithDeclaredFiles, operatorRetry, FINDER_TIMEOUT_MS } from './lib/card-planner.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'
import { stageIndicators } from './lib/stage-indicators.mjs'
import { agentStartArgs } from './lib/agent-launch.mjs'
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

// HK40: a project with a manager inbox, so a held card's ASK can be read back.
function projectBoard() {
  const root = mkdtempSync(join(tmpdir(), 'finder-hk40-'))
  const dir = join(root, 'Proj', 'TASKS'), inbox = join(root, 'inbox.md')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'board.config.json'), JSON.stringify({ projectsRoot: root, projects: ['Proj'], projectSettings: { Proj: { manager: { chat: 'Proj chat', inbox } } } }))
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  const asks = () => existsSync(inbox) ? readFileSync(inbox, 'utf8').split('\n').filter(l => / ASK Proj /.test(l)) : []
  return { root, dir, asks, done: () => { delete process.env.KANBAN_CONFIG; rmSync(root, { recursive: true, force: true }) } }
}
const finderExits = async h => { await h.run(T0); h.setStatus(h.names[0], 'done'); await h.run(T0 + 20000) }

for (const [name, size] of [['over the limit', 'Size: 14 files, 5 areas'], ['unbounded', 'Size: unbounded'], ['no list and no size', 'I looked through the repository but I am not sure what to list.']]) {
  test(`HK40 AC1: a Finder reporting "${name}" holds the card, starts no Planner and sends one ASK`, async () => {
    const b = projectBoard()
    try {
      const card = createCard(b.dir, { title: 'Big card', brief: 'x' })
      const h = harness(b.dir, { outputs: { p1: name === 'no list and no size' ? size : [...LIST, size].join('\n') } })
      await finderExits(h)
      await h.run(T0 + 40000)
      await h.run(T0 + FINDER_TIMEOUT_MS * 3)
      assert.deepEqual(h.names.filter(n => n.startsWith('p-')), [], 'no Planner')
      assert.equal(findCard(b.dir, card.id).column, 'planning')
      const wf = readWorkflow(b.dir)[card.id]
      assert.equal(wf.finder.status, 'held')
      assert.equal(wf.waitFor.decision, true)
      const asks = b.asks()
      assert.equal(asks.length, 1)
      assert.match(asks[0], new RegExp(`ASK Proj ${card.id} \\(planning\\):`))
      if (name !== 'no list and no size') assert.match(asks[0], /lib\/card-planner\.mjs/)
      else assert.match(asks[0], /none printed/)
    } finally { b.done() }
  })
}

test('HK40 AC2: a Finder reporting 10 files and 2 areas starts the Planner, size line first, no ASK', async () => {
  const b = projectBoard()
  try {
    const card = createCard(b.dir, { title: 'Card', brief: 'x' })
    const h = harness(b.dir, { outputs: { p1: [...LIST, 'Size: 10 files, 2 areas'].join('\n') } })
    await finderExits(h)
    assert.ok(h.names.includes(agentName('planner', card.id)))
    assert.equal(readWorkflow(b.dir)[card.id].finder.status, 'listed')
    assert.match(readFileSync(findCard(b.dir, card.id).path, 'utf8'), /^## Finder list\r?\nSize: 10 files, 2 areas\r?\n- `herdr-kanban/m)
    assert.deepEqual(b.asks(), [])
  } finally { b.done() }
})

test('HK40 AC3: a timed out Finder that printed an oversize line still reaches the Planner, with no size and no ASK', async () => {
  const b = projectBoard()
  try {
    const card = createCard(b.dir, { title: 'Card', brief: 'x' })
    const h = harness(b.dir, { outputs: { p1: 'Size: 30 files, 4 areas' } })
    await h.run(T0)
    await h.run(T0 + FINDER_TIMEOUT_MS)
    assert.ok(h.names.includes(agentName('planner', card.id)))
    const finder = readWorkflow(b.dir)[card.id].finder
    assert.equal(finder.status, 'timeout')
    assert.equal(finder.size, undefined)
    assert.doesNotMatch(readFileSync(findCard(b.dir, card.id).path, 'utf8'), /## Finder list/)
    assert.deepEqual(b.asks(), [])
  } finally { b.done() }
})

test('HK40 AC4: only a line in the Size format is read, the last one wins, and it is written once', () => {
  const sample = ['I found some code.', 'Size: 3 files', 'Size: many files, 2 areas', 'Size: 4 files, 2 areas', 'Sizes: 9 files, 1 areas', 'size: UNBOUNDED', 'Size: 7 files, 1 flow'].join('\n')
  assert.deepEqual(parseFinderSize(sample), { files: 7, areas: 1 })
  assert.deepEqual(parseFinderSize('Size: 4 files, 2 areas\nsize: UNBOUNDED'), { unbounded: true })
  assert.deepEqual(parseFinderSize('Size: 4 files, 2 areas'), { files: 4, areas: 2 })
  assert.equal(parseFinderSize('Size: 3 files\nSize: many files, 2 areas\nno size here'), null)
  const dir = mkdtempSync(join(tmpdir(), 'finder-hk40-size-'))
  try {
    const card = createCard(dir, { title: 'Card', brief: 'x' })
    writeFinderList(findCard(dir, card.id), LIST, { files: 4, areas: 2 })
    writeFinderList(findCard(dir, card.id), LIST, { files: 5, areas: 2 })
    const text = readFileSync(findCard(dir, card.id).path, 'utf8')
    assert.equal((text.match(/^Size: /gm) || []).length, 1)
    assert.match(text, /^## Finder list\r?\nSize: 5 files, 2 areas\r?\n- /m)
    writeFinderList(findCard(dir, card.id), LIST)
    assert.doesNotMatch(readFileSync(findCard(dir, card.id).path, 'utf8'), /^Size: /m)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('HK40 AC6: when the hold is lifted the Finder runs again on the new brief', async () => {
  const b = projectBoard()
  try {
    const card = createCard(b.dir, { title: 'Big card', brief: 'x' })
    const h = harness(b.dir, { outputs: { p1: 'Size: 14 files, 5 areas' } })
    await finderExits(h)
    assert.equal(readWorkflow(b.dir)[card.id].finder.status, 'held')
    h.outputs.p2 = [...LIST, 'Size: 3 files, 1 areas'].join('\n')
    operatorRetry(b.dir, card.id, 'planning')
    assert.equal(readWorkflow(b.dir)[card.id].finder ?? null, null)
    await h.run(T0 + 60000)
    assert.equal(h.names.filter(n => n.startsWith('f-')).length, 2, 'a second Finder')
    h.agents.find(a => a.pane_id === 'p2').agent_status = 'done' // both Finders share one name
    await h.run(T0 + 90000)
    assert.ok(h.names.includes(agentName('planner', card.id)))
    assert.equal(b.asks().length, 1, 'only the first Finder asked')
  } finally { b.done() }
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

// F10: a Finder that hits its engine's usage limit is not a bad brief. Claude is blocked until the
// reset, no ASK is sent, no Finder starts while blocked, and the Finder runs again after the reset.
test('F10: a Finder that hits a usage limit waits for the reset, sends no ASK, and runs again after it', async () => {
  const b = projectBoard()
  try {
    const card = createCard(b.dir, { title: 'Card', brief: 'x' })
    const reset = T0 + 3600000
    const h = harness(b.dir, { outputs: { p1: `Claude AI usage limit reached|${Math.floor(reset / 1000)}` } })
    await finderExits(h)
    assert.equal(h.names.filter(n => n.startsWith('f-')).length, 1)
    assert.deepEqual(h.names.filter(n => n.startsWith('p-')), [], 'no Planner')
    assert.deepEqual(b.asks(), [], 'no ASK')
    assert.equal(readWorkflow(b.dir)[card.id].waitFor, undefined)
    assert.equal(readWorkflow(b.dir)[card.id].finder?.done, undefined, 'the Finder is not done')
    const quota = JSON.parse(readFileSync(join(b.root, '.engine-quota.json'), 'utf8'))
    assert.equal(quota.claude.until, reset)

    await h.run(T0 + 600000) // still blocked: no second Finder
    assert.equal(h.names.filter(n => n.startsWith('f-')).length, 1)

    await h.run(reset + 1000) // after the reset the Finder starts again
    assert.equal(h.names.filter(n => n.startsWith('f-')).length, 2)
    assert.equal(h.names[1], agentName('finder', card.id))
    h.outputs.p2 = [...LIST, 'Size: 10 files, 2 areas'].join('\n')
    h.agents.find(a => a.pane_id === 'p2').agent_status = 'done' // setStatus finds the first agent of the name
    await h.run(reset + 21000)
    assert.ok(h.names.includes(agentName('planner', card.id)), 'the Planner starts once the Finder lists')
    assert.equal(readWorkflow(b.dir)[card.id].finder.status, 'listed')
    assert.deepEqual(b.asks(), [])
  } finally { b.done() }
})

// I1492 (2026-10-17): the Finder's size is the card's own Files list. A generated-file glob listed beside
// its generator is one entry (CARD-GUIDE), and the newest note that narrows Files wins (I1454 was held
// twice on a Finder count of 13 that ignored its narrowing note).
const GEN_FILES = [
  '- `scripts/gen-steroid-pages.mjs` - merge the draw tables',
  '- `public/legacy/steroid-dosage-calculator/*/index.html` - generated by `scripts/gen-steroid-pages.mjs`; regenerate only',
]
const GEN_BRIEF = ['Why: a design finding', 'Files:', ...GEN_FILES, 'AC1: one draw table'].join('\n')

test('I1492: declaredFileCount counts a generated glob with its generator as two, and the newest narrowing note wins', () => {
  assert.equal(declaredFileCount('## Approved brief\nFiles: unknown - planner to locate\nAC1: x\n'), null)
  assert.equal(declaredFileCount(`## Approved brief\n${GEN_BRIEF}\n`), 2)
  assert.equal(declaredFileCount(`## Approved brief\n${GEN_BRIEF}\n## Files\n- \`a.mjs\` - one\n- \`b.mjs\` — unchanged, read only\n`), 1)
  assert.equal(declaredFileCount(`## Approved brief\n${GEN_BRIEF}\n\n**Narrowed files** 2026-10-17T02:17:30.969Z\n\nOrchestrator: narrowed.\n- \`scripts/x.mjs\` - x\n\n**Replaced** 2026-10-17T02:27:04.049Z\n\nReplaced.\n`), 1)
  assert.deepEqual(sizeWithDeclaredFiles({ files: 11, areas: 2 }, 2), { files: 2, areas: 2 })
  assert.deepEqual(sizeWithDeclaredFiles({ unbounded: true }, 2), { unbounded: true })
  assert.deepEqual(sizeWithDeclaredFiles({ files: 11, areas: 2 }, null), { files: 11, areas: 2 })
})

test('I1492: a Finder that counts the generated glob per match does not hold a card whose Files are generator + glob', async () => {
  const b = projectBoard()
  try {
    const card = createCard(b.dir, { title: 'Steroid pages', brief: GEN_BRIEF })
    const h = harness(b.dir, { outputs: { p1: [...LIST, 'Size: 11 files, 2 areas'].join('\n') } })
    await finderExits(h)
    assert.ok(h.names.includes(agentName('planner', card.id)), 'the Planner starts')
    assert.equal(readWorkflow(b.dir)[card.id].finder.status, 'listed')
    assert.deepEqual(readWorkflow(b.dir)[card.id].finder.size, { files: 2, areas: 2 })
    assert.match(readFileSync(findCard(b.dir, card.id).path, 'utf8'), /^Size: 2 files, 2 areas$/m)
    assert.deepEqual(b.asks(), [])
  } finally { b.done() }
})

test('I1492: a Finder list that ignores a later narrowing Files note is sized by the note', async () => {
  const b = projectBoard()
  try {
    const card = createCard(b.dir, { title: 'Steroid pages', brief: 'Why: x\nFiles: unknown - planner to locate\nAC1: x' })
    const path = findCard(b.dir, card.id).path
    writeFileSync(path, readFileSync(path, 'utf8') + `\n**Narrowed files** 2026-10-17T02:17:30.969Z\n\nOrchestrator: narrowed.\n${GEN_FILES.join('\n')}\n`)
    const h = harness(b.dir, { outputs: { p1: [...LIST, 'Size: 13 files, 2 areas'].join('\n') } })
    await finderExits(h)
    assert.ok(h.names.includes(agentName('planner', card.id)), 'the Planner starts')
    assert.deepEqual(readWorkflow(b.dir)[card.id].finder.size, { files: 2, areas: 2 })
  } finally { b.done() }
})

test('I1492: a declared Files list over the limit still holds the card, whatever the Finder counted', async () => {
  const b = projectBoard()
  try {
    const files = Array.from({ length: 11 }, (_, i) => `- \`lib/f${i}.mjs\` - change ${i}`)
    const card = createCard(b.dir, { title: 'Wide card', brief: ['Why: x', 'Files:', ...files, 'AC1: x'].join('\n') })
    const h = harness(b.dir, { outputs: { p1: [...LIST, 'Size: 3 files, 1 areas'].join('\n') } })
    await finderExits(h)
    assert.deepEqual(h.names.filter(n => n.startsWith('p-')), [], 'no Planner')
    assert.equal(readWorkflow(b.dir)[card.id].finder.status, 'held')
    assert.match(b.asks()[0] ?? '', /11 files, over the limit of 10/)
  } finally { b.done() }
})
