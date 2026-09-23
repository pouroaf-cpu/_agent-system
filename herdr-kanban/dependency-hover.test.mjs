import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { recordedOverlapBlockers } from './lib/worktrees.mjs'

test('recorded locks and delayed dependency presentation cancel/reset, omit hidden endpoints, and retain normal clicks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-hover-'))
  const cardPath = join(dir, 'T-1.md'); writeFileSync(cardPath, '## Files\n- `app.js`\n')
  try {
    const registry = { 'T-2': { state: 'building', files: [join(dir, 'app.js')] }, 'T-3': { state: 'building', files: [join(dir, 'app.js')] }, 'T-4': { state: 'integrated', files: [join(dir, 'app.js')] }, 'T-5': { state: 'building', files: [join(dir, 'else.js')] } }
    const before = JSON.stringify(registry)
    assert.deepEqual(recordedOverlapBlockers({ id: 'T-1', path: cardPath }, dir, registry), ['T-2', 'T-3'])
    assert.equal(JSON.stringify(registry), before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion: 'reduce' })
    const errors = []; page.on('pageerror', err => errors.push(err.message))
    await page.setContent('<style>#board{height:300px;overflow:auto;width:700px}.card{width:200px;height:50px;margin:15px;display:inline-block}.dependency-lines{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}</style><main id="board"><div tabindex="0" class="card" data-id="T-1">source</div><div tabindex="0" class="card" data-id="T-2">blocker A</div><div tabindex="0" class="card" data-id="T-3">blocker B</div><div tabindex="0" class="card" data-id="T-4">unrelated</div><div style="display:none" class="card" data-id="T-5">hidden</div></main>')
    await page.addScriptTag({ content: readFileSync(new URL('./public/dependency-hover.js', import.meta.url), 'utf8') })
    await page.evaluate(() => {
      window.dependencies = ['T-2', 'T-3', 'T-5', 'T-99']; window.enabled = true; window.clicks = 0;
      window.hover = createDependencyHover({ root: document.querySelector('#board'), getBlockers: id => id === 'T-1' ? window.dependencies : [], enabled: () => window.enabled });
      document.querySelector('[data-id="T-1"]').addEventListener('click', () => window.clicks++);
      // Controllable time keeps the check quick while exercising the real 1500ms value.
      const timers = new Map(); let next = 1;
      window.setTimeout = (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; };
      window.clearTimeout = id => timers.delete(id);
      window.advance = ms => { for (const [id, timer] of [...timers]) { timer.ms -= ms; if (timer.ms <= 0) { timers.delete(id); timer.fn(); } } };
    })
    const source = page.locator('[data-id="T-1"]')
    await source.hover(); await page.evaluate(() => advance(1499));
    assert.equal(await page.locator('.dependency-focus').count(), 0)
    await page.mouse.move(850, 650); await page.evaluate(() => advance(1500));
    assert.equal(await page.locator('.dependency-focus').count(), 0)
    await source.hover(); await page.evaluate(() => advance(1500));
    assert.equal(await page.locator('.dependency-lines line').count(), 2)
    assert.equal(await page.locator('[data-id="T-4"].dependency-muted').count(), 1)
    assert.equal(await page.locator('[data-id="T-5"].dependency-muted').count(), 0)
    const beforeLine = await page.locator('.dependency-lines line').first().getAttribute('x1')
    await page.evaluate(() => { document.querySelector('#board').style.marginLeft = '30px'; dispatchEvent(new Event('resize')); })
    await page.waitForFunction(previous => document.querySelector('.dependency-lines line')?.getAttribute('x1') !== previous, beforeLine)
    await source.click(); assert.equal(await page.evaluate(() => clicks), 1)
    await page.evaluate(() => hover.reset()); assert.equal(await page.locator('.dependency-lines line').count(), 0)
    await source.focus(); await page.evaluate(() => advance(1500));
    // click may already focus source: explicitly blur/refocus for continuous keyboard focus.
    await page.locator('[data-id="T-4"]').focus(); await source.focus(); await page.evaluate(() => advance(1500));
    assert.equal(await page.locator('.dependency-lines line').count(), 2)
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.dependency-focus').count(), 0)
    await page.evaluate(() => { dependencies = []; hover.reset(); });
    await page.mouse.move(850, 650); await source.hover(); await page.evaluate(() => advance(2000));
    assert.equal(await page.locator('.dependency-muted').count(), 0)
    await page.evaluate(() => { dependencies = ['T-2']; });
    await page.mouse.move(850, 650); await source.hover();
    await page.evaluate(() => { enabled = false; hover.reset(); advance(2000); });
    assert.equal(await page.locator('.dependency-lines line').count(), 0)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
