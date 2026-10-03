import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { COLUMNS } from './lib/cards.mjs'

test('project controls, session identity and responsive layout in a browser with mocked board transport', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    let paused = true, opened = null
    const board = { project: 'Proof', columns: COLUMNS, archive: { key: 'archive', label: 'Archive' }, board: Object.fromEntries([...COLUMNS.map(c => c.key), 'archive'].map(key => [key, []])), control: { paused }, config: { maxConcurrentAgents: 2, stallSeconds: 300 }, slotsFree: 1, bindings: { 'T-1': { pane_id: 'correct-pane', started: new Date().toISOString() }, 'T-2': { pane_id: 'missing-pane' } }, planners: {}, cardUsage: {}, workflow: {}, holds: {}, retries: {}, herdrUp: true, agents: [{ pane_id: 'correct-pane', tab_id: 'correct-tab', name: 'kb-t-1-proof', agent_status: 'idle' }, { pane_id: 'finished-pane', name: 'kb-t-3-proof', agent_status: 'done' }] }
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/board') return route.fulfill({ json: { ...board, control: { paused } } })
      if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: ['Proof'] } })
      if (url.pathname === '/api/project-control') { paused = route.request().postDataJSON().paused; return route.fulfill({ json: { ok: true, control: { paused } } }) }
      if (url.pathname === '/api/agent-open') { opened = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } }) }
      if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (['index.html', 'board.js', 'nz-time.js', 'dependency-hover.js', 'board.css'].includes(file)) return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8') })
      return route.fulfill({ status: 404, body: '' })
    })
    await page.goto('http://workflow.test/?project=Proof')
    await page.getByRole('button', { name: 'Start', exact: true }).waitFor()
    assert.equal(await page.locator('#project-status').textContent(), 'Paused')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).waitFor()
    assert.equal(paused, true)
    // Agent chips left the header; the Agents page opens the same session.
    await page.locator('#burger').click()
    await page.getByRole('button', { name: /^Agents/ }).click()
    await page.locator('.agent-row').filter({ hasText: 'T-1' }).getByRole('button', { name: 'Open session' }).click()
    assert.deepEqual(opened, { project: 'Proof', paneId: 'correct-pane' })
    assert.equal(await page.locator('.agent-row').filter({ hasText: 'T-3' }).count(), 0)
    await page.getByRole('button', { name: 'Back to Kanban' }).click()
    assert.equal(await page.locator('#slots').textContent(), 'Builders 1 / 2')
    mkdirSync(new URL('./artifacts/workflow-controls/', import.meta.url), { recursive: true })
    await page.screenshot({ path: new URL('./artifacts/workflow-controls/desktop.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).isVisible(), true)
    await page.screenshot({ path: new URL('./artifacts/workflow-controls/mobile.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
