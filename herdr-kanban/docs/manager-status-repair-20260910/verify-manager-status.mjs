import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const out = 'C:/Users/PFrew/Projects/herdr-kanban/docs/manager-status-repair-20260910';
const url = 'http://localhost:7782';
const checks = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.click('#burger');
    await page.click('[data-view="tasks"]');
    await page.waitForSelector('.manager-tasks-table tbody tr');
    const rows = await page.$$eval('.manager-tasks-table tbody tr', trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim())));
    const byId = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.manager-tasks-table tbody tr')].map(tr => [tr.dataset.requestId, { id: tr.dataset.requestId, status: tr.children[5].textContent.trim(), description: tr.children[3].textContent.trim() }])));
    const metrics = await page.evaluate(() => ({
      bodyW: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      tableRows: document.querySelectorAll('.manager-tasks-table tbody tr').length,
      firstId: document.querySelector('.manager-tasks-table tbody tr')?.dataset.requestId,
    }));
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    checks.push({ name, errors, metrics, rows: {
      REQ_020: byId['REQ-20260910-020'],
      REQ_015: byId['REQ-20260910-015'],
      REQ_011: byId['REQ-20260910-011'],
      REQ_005: byId['REQ-20260909-005'],
      REQ_004: byId['REQ-20260909-004'],
    }});
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${out}/verify-result.json`, JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
