import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { COLUMNS } from './lib/cards.mjs'

test('Audits uses burger and existing navbar, filters with project dropdown, opens exact report and fits mobile', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = [], writes = []; page.on('pageerror', err => errors.push(err.message))
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), project = url.searchParams.get('project') || 'Proof'
      if (request.method() === 'POST') writes.push({ path: url.pathname, body: request.postDataJSON() })
      if (url.pathname === '/api/board') return route.fulfill({ json: { project, columns: COLUMNS, board: Object.fromEntries([...COLUMNS.map(c => c.key), 'archive'].map(key => [key, []])), config: { maxConcurrentAgents: 0 }, control: { paused: true }, agents: [], bindings: {}, herdrUp: false } })
      if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: ['Proof', 'Other'] } })
      if (url.pathname === '/api/audits') return route.fulfill({ json: { ok: true, project, audits: project === 'Other' ? [] : [
        { title: 'Accessibility audit with partial coverage', date: '2026-09-18', dateLabel: 'Report date', status: 'Incomplete', reports: [{ id: 'safe-report-id', name: 'report.md', file: 'TASKS/reports/check/report.md' }] },
        { title: 'Historical report missing', date: '2026-09-17', dateLabel: 'Card updated', status: 'Report missing', reports: [] },
      ] } })
      if (url.pathname === '/api/open') return route.fulfill({ json: { ok: true } })
      if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' })
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (['index.html', 'board.js', 'nz-time.js', 'dependency-hover.js', 'board.css'].includes(file)) return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8') })
      return route.fulfill({ status: 404, body: '' })
    })
    await page.goto('http://audit.test/?project=Proof')
    await page.locator('#burger').click()
    await page.getByRole('button', { name: 'Audits', exact: false }).click()
    await page.getByRole('heading', { name: 'Accessibility audit with partial coverage' }).waitFor()
    assert.equal(await page.locator('#project-pick').isVisible(), true)
    assert.equal(await page.locator('#project-status').textContent(), 'Paused')
    assert.equal(await page.locator('.audit-card').count(), 2)
    assert.equal(await page.locator('.audit-card').filter({ hasText: 'Historical report missing' }).getByRole('button').count(), 0)
    await page.getByRole('button', { name: 'Open report in VS Code' }).click()
    assert.deepEqual(writes, [{ path: '/api/open', body: { project: 'Proof', reportId: 'safe-report-id' } }])
    const dir = new URL('./artifacts/audits-view/', import.meta.url); mkdirSync(dir, { recursive: true })
    await page.screenshot({ path: new URL('desktop.png', dir).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.getByRole('button', { name: 'Open report in VS Code' }).isVisible(), true)
    await page.screenshot({ path: new URL('mobile.png', dir).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
    await page.locator('#project-pick').selectOption('Other')
    await page.getByText('No audit reports found for this project.').waitFor()
    assert.match(page.url(), /project=Other&view=audits/)
    assert.equal(await page.locator('.audit-card').count(), 0)
    assert.equal(writes.length, 1) // no controls, prompts, cards or findings mutations
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
