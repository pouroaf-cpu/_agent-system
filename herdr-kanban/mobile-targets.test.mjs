import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { COLUMNS } from './lib/cards.mjs'

// Audit 2026-10-15 F10: at 375 px the Settings agent-count steps 8 to 10 ran past the right
// edge, the drawer priority buttons were 39 px wide, and metrics.html at 1280 held a 1,928 px
// table. These checks are the audit's ui-check: no element past the viewport edge, and every
// step button at least 44x44.

const STATIC = ['index.html', 'board.js', 'nz-time.js', 'dependency-hover.js', 'board.css', 'metrics.html', 'metrics.js']
const serve = (page, api, posted) => page.route('**/*', route => {
  const path = new URL(route.request().url()).pathname
  if (route.request().method() === 'POST') { posted.push({ path, body: route.request().postDataJSON() }); return route.fulfill({ json: { ok: true } }) }
  if (path in api) return route.fulfill({ json: api[path] })
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' })
  const name = path === '/' ? 'index.html' : path.slice(1)
  if (STATIC.includes(name)) return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(new URL('./public/' + name, import.meta.url), 'utf8') })
  return route.fulfill({ status: 404, body: '' })
})
// A paused project with one card in the first lane (the first board column).
const phoneBoard = first => {
  const board = { project: 'Proof', columns: COLUMNS, archive: { key: 'archive', label: 'Archive' }, board: Object.fromEntries([...COLUMNS.map(c => c.key), 'archive'].map(k => [k, []])), control: { paused: true }, config: { mode: 'auto', maxConcurrentAgents: 8, stallSeconds: 300, agentSettings: {}, supportedAgentSettings: {} }, slotsFree: 0, bindings: {}, planners: {}, workflow: {}, holds: {}, retries: {}, herdrUp: true, agents: [], cardRuns: [], cardRunEligibility: {}, cardUsage: {} }
  board.board[first] = [{ id: 'T-1', title: 'Phone card', column: first, priority: 5, mtime: 1, createdAt: '2026-10-13T00:00:00Z', text: '# T-1 Phone card' }]
  return board
}
// Elements whose box runs past the right edge of the viewport.
const overflowing = page => page.evaluate(() => [...document.querySelectorAll('body *')]
  .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 })
  .map(e => `${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).replace(/ /g, '.') : ''} right=${Math.round(e.getBoundingClientRect().right)}`))
const boxes = (page, selector) => page.locator(selector).evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { text: e.textContent, w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) } }))

test('at 375 px the Settings steps wrap inside the viewport and every drawer and settings step button is at least 44x44 (audit 2026-10-15 F10 AC1, AC2)', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    const first = COLUMNS[0].key
    const board = phoneBoard(first)
    const posted = []
    await serve(page, { '/api/board': board, '/api/projects': { projects: ['Proof'] } }, posted)
    await page.goto('http://mobile.test/?project=Proof')
    await page.locator('.card[data-id="T-1"]').waitFor()

    // Settings: the mode row and the 0 to 10 agent-count row.
    await page.locator('#burger').click()
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.locator('.settings-steps .pri-step').first().waitFor()
    const settings = await boxes(page, '.settings-steps .pri-step')
    assert.equal(settings.length, 13)
    for (const s of settings) assert.ok(s.w >= 44 && s.h >= 44 && s.right <= 375, `settings step ${JSON.stringify(s)}`)
    assert.deepEqual(await overflowing(page), [])
    // The live board's value, 8, can be set from a phone.
    await page.locator('.settings-steps .pri-step', { hasText: /^8$/ }).click()
    assert.deepEqual(posted.filter(p => p.path === '/api/config').map(p => p.body), [{ maxConcurrentAgents: 8 }])

    // Drawer: the priority 0 to 10 row.
    await page.getByRole('button', { name: 'Back to Kanban' }).click()
    await page.locator('.card[data-id="T-1"]').click()
    await page.locator('.drawer-body .pri-step').first().waitFor()
    const drawer = await boxes(page, '.drawer-body .pri-step')
    assert.equal(drawer.length, 11)
    for (const s of drawer) assert.ok(s.w >= 44 && s.h >= 44 && s.right <= 375, `drawer step ${JSON.stringify(s)}`)
    assert.deepEqual(await overflowing(page), [])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

test('at 375 px the header row 2 holds Pause, Builders, Open herdr and Metrics with no sideways scroll, and the first lane header starts within 160 px (audit 2026-10-16 F2 AC1, AC2)', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    const first = COLUMNS[0].key
    await serve(page, { '/api/board': phoneBoard(first), '/api/projects': { projects: ['Proof'] } }, [])
    await page.goto('http://mobile.test/?project=Proof')
    await page.locator('.card[data-id="T-1"]').waitFor()

    const header = await page.evaluate(() => {
      const right = document.querySelector('.bar-right')
      const at = e => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) } }
      const lane = [...document.querySelectorAll('.lane-head')].find(e => e.offsetParent)
      return {
        stripScrolls: right.scrollWidth > right.clientWidth,
        controls: Object.fromEntries(['.project-control', '#slots', '#herdr-open', '.metrics-link'].map(s => [s, at(document.querySelector(s))])),
        laneHeadTop: Math.round(lane.getBoundingClientRect().top),
        statusText: document.getElementById('project-status').textContent,
      }
    })
    assert.equal(header.stripScrolls, false, 'row 2 does not scroll sideways')
    const middle = box => box.top + box.h / 2
    const row = middle(header.controls['.project-control'])
    for (const [selector, box] of Object.entries(header.controls)) {
      assert.ok(box.left >= 0 && box.right <= 375, `${selector} inside the 375 px viewport: ${JSON.stringify(box)}`)
      assert.ok(Math.abs(middle(box) - row) <= 2, `${selector} is on the same row as Pause: ${JSON.stringify(box)}`)
    }
    assert.ok(header.controls['.project-control'].h >= 44 && header.controls['.metrics-link'].w >= 44 && header.controls['.metrics-link'].h >= 44, 'Pause and Metrics are 44 px targets')
    assert.ok(header.laneHeadTop <= 160, `first lane header top ${header.laneHeadTop} px`)
    // The state word is hidden on a phone but still in the page for screen readers.
    assert.equal(header.statusText, 'Paused')
    assert.equal(await page.getByRole('link', { name: 'Metrics' }).count(), 1)
    assert.deepEqual(await overflowing(page), [])
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

test('metrics.html at 1280 px has no element wider than the viewport and keeps every column reachable (audit 2026-10-15 F10 AC3)', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    const day = i => `2026-10-${String(14 - i).padStart(2, '0')}`
    const difficulty = Object.fromEntries(['tiny', 'easy', 'medium', 'hard'].map(d => [d, { attempts: 3, kickBacks: 1 }]))
    const metrics = Array.from({ length: 7 }, (_, i) => ({ day: day(i), integrated: 12, archived: 11, finished: 12, kickBacks: { planning: 1, implementation: 2, evidence: 3, operational: 4, untagged: 5, total: 15 }, builderDeliveryFailed: 1, builderNoHandoff: 2, plannerFailures: 3, stalls: 4, ownerEscalations: 5, kickBacksPerFinishedCard: 1.25, builderDifficulty: difficulty }))
    const stats = { sessions: 9, unknown: 1, medianSteps: 40, p90Steps: 95, medianTokens: 1234567 }
    const rollup = Array.from({ length: 7 }, (_, i) => ({ day: day(i), planner: { all: stats, child: stats, notSplit: stats, parent: stats }, builder: { all: stats, child: stats, notSplit: stats, parent: stats } }))
    await serve(page, { '/api/projects': { ok: true, projects: ['Injectbuddy', 'herdr-kanban'] }, '/api/metrics': { ok: true, metrics }, '/api/session-steps': { ok: true, rollup } }, [])
    await page.goto('http://mobile.test/metrics.html')
    await page.locator('table[aria-label="herdr-kanban steps per session"]').waitFor()
    // Summary table, then a daily and a steps table for each of the two projects.
    assert.equal(await page.locator('table').count(), 5)
    assert.deepEqual(await overflowing(page), [])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    // Every daily column is still on the page with its heading beside the value.
    const labels = await page.locator('table[aria-label="Injectbuddy daily board health"] tbody tr').first().locator('td').evaluateAll(cells => cells.map(c => [c.dataset.label, c.textContent]))
    assert.equal(labels.length, 24)
    assert.deepEqual(labels.find(([label]) => label === 'hard kick-backs'), ['hard kick-backs', '1'])
    assert.deepEqual(labels.find(([label]) => label === 'Kick-backs / finished'), ['Kick-backs / finished', '1.25'])
    assert.equal(await page.locator('table[aria-label="Injectbuddy daily board health"] tbody td').first().evaluate(c => getComputedStyle(c, '::before').content), '"NZ reporting period"')
    // Wide screens keep the plain table.
    await page.setViewportSize({ width: 1600, height: 900 })
    assert.equal(await page.locator('table[aria-label="Injectbuddy daily board health"] thead th').first().evaluate(th => th.getBoundingClientRect().height > 10), true)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
