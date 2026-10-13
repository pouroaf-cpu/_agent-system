import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { COLUMNS } from './lib/cards.mjs'

test('card token breakdown shows each agent session\'s Steps beside its tokens (mocked transport)', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    const tokens = { uncachedInput: 100, cachedInput: 900, output: 50, total: 1050 }
    const agent = (runId, name, role, steps) => ({ runId, name, role, model: 'claude-sonnet-5-5', startedAt: '2026-10-13T00:14:00Z', finishedAt: '2026-10-13T00:20:00Z', status: 'complete', tokens, steps, shared: false })
    const board = { project: 'Proof', columns: COLUMNS, archive: { key: 'archive', label: 'Archive' }, board: Object.fromEntries([...COLUMNS.map(c => c.key), 'archive'].map(k => [k, []])), control: { paused: true }, config: { maxConcurrentAgents: 0, stallSeconds: 300 }, slotsFree: 0, bindings: {}, planners: {}, workflow: {}, holds: {}, retries: {}, herdrUp: true, agents: [], cardRuns: [], cardRunEligibility: {},
      cardUsage: { 'T-1': { tokens, unknown: 0, agents: [agent('r1', 'p-t1', 'planner', 26), agent('r2', 'b-t1', 'builder', null)] } } }
    board.board.queue = [{ id: 'T-1', title: 'Usage card', column: 'queue', priority: 5, mtime: 1, createdAt: '2026-10-13T00:00:00Z', text: '# Usage card' }]
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/board') return route.fulfill({ json: board })
      if (path === '/api/projects') return route.fulfill({ json: { projects: ['Proof'] } })
      if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' })
      const file = path === '/' ? 'index.html' : path.slice(1)
      if (['index.html', 'board.js', 'nz-time.js', 'dependency-hover.js', 'board.css'].includes(file)) return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(new URL('./public/' + file, import.meta.url), 'utf8') })
      return route.fulfill({ status: 404, body: '' })
    })
    await page.goto('http://localhost:18786/?project=Proof')
    await page.locator('.card[data-id="T-1"]').click()
    await page.getByRole('button', { name: 'Show breakdown' }).click()
    const table = page.locator('table.usage-table')
    await table.waitFor()
    const heads = await table.locator('thead th').allInnerTexts()
    assert.deepEqual(heads.slice(4), ['Total', 'Steps', 'Attribution / status'])
    const rows = await table.locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.cells].map(c => c.innerText)))
    assert.equal(rows[0][5], '26')
    assert.equal(rows[1][5], '—')
    const cellCounts = await table.locator('tr').evaluateAll(trs => trs.map(tr => tr.cells.length))
    assert.deepEqual(cellCounts, [7, 7, 7, 7])
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
