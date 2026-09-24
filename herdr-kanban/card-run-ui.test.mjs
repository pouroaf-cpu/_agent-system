import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { COLUMNS } from './lib/cards.mjs'

test('Run this card is scoped, blocked reasons visible, and Pause cancels instead of Start (desktop/mobile fixture)', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const requests = [], errors = []; page.on('pageerror', e => errors.push(e.message))
    const board = { project: 'Proof', columns: COLUMNS, archive: { key: 'archive', label: 'Archive' }, board: Object.fromEntries([...COLUMNS.map(c => c.key), 'archive'].map(k => [k, []])), control: { paused: true }, config: { maxConcurrentAgents: 0, stallSeconds: 300 }, slotsFree: 0, bindings: {}, planners: {}, cardUsage: {}, workflow: {}, holds: {}, retries: {}, herdrUp: true, agents: [], cardRuns: [], cardRunEligibility: { 'T-1': null, 'T-2': 'Blocked by T-99' } }
    board.board.queue = [{ id: 'T-1', title: 'Allowed card', column: 'queue', priority: 5, mtime: 1, autoReview: false, cardOwned: true, text: '# Allowed card' }, { id: 'T-2', title: 'Blocked card', column: 'queue', priority: 4, mtime: 1, text: '# Blocked card' }]
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/board') return route.fulfill({ json: board })
      if (path === '/api/projects') return route.fulfill({ json: { projects: ['Proof'] } })
      if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' })
      if (path === '/api/card-run') {
        const request = route.request().postDataJSON(); requests.push(request)
        board.cardRuns = [{ project: 'Proof', cardId: request.id, status: 'running', reason: 'Running builder', autoReview: false }]
        return route.fulfill({ json: { ok: true } })
      }
      if (path === '/api/project-control') { requests.push(route.request().postDataJSON()); board.cardRuns[0].status = 'stopped'; return route.fulfill({ json: { ok: true, control: { paused: true } } }) }
      const file = path === '/' ? 'index.html' : path.slice(1)
      if (['index.html', 'board.js', 'dependency-hover.js', 'board.css'].includes(file)) return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(new URL('./public/' + file, import.meta.url), 'utf8') })
      return route.fulfill({ status: 404, body: '' })
    })
    await page.goto('http://localhost:18786/?project=Proof')
    await page.locator('.card[data-id="T-2"]').click()
    await page.getByRole('button', { name: 'More actions' }).click() // Run this card lives in the More menu
    assert.equal(await page.getByRole('button', { name: 'Run this card', exact: true }).isDisabled(), true)
    assert.match(await page.locator('.card-run-control').innerText(), /Blocked by T-99/)
    await page.locator('#drawer-close').click()
    await page.locator('.card[data-id="T-1"]').click()
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Run this card', exact: true }).click()
    assert.equal(requests[0].id, 'T-1'); assert.equal(requests[0].project, 'Proof'); assert.ok(requests[0].requestId)
    await page.reload()
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('combobox', { name: 'Jump to board state' }).selectOption('queue')
    await page.locator('.card[data-id="T-1"]').click()
    await page.getByRole('button', { name: 'More actions' }).click()
    assert.equal(await page.getByRole('button', { name: 'Cancel card run' }).isVisible(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.locator('#drawer-close').click()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    assert.deepEqual(requests[1], { project: 'Proof', paused: true })
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
