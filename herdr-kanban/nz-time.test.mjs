import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { formatNZTime, formatNZText } from './lib/nz-time.mjs'

test('NZ display respects winter, summer, midnight and daylight saving transitions', () => {
  for (const [iso, expected] of [
    ['2026-10-03T05:17:00Z', '3 Oct, 6:17 pm'],
    ['2026-07-03T05:17:00Z', '3 Jul, 5:17 pm'],
    ['2026-10-03T12:00:00Z', '4 Oct, 1:00 am'],
    ['2026-09-26T13:59:00Z', '27 Sept, 1:59 am'],
    ['2026-09-26T14:00:00Z', '27 Sept, 3:00 am']
  ]) assert.equal(formatNZTime(iso), expected)
})

test('browser display and scheduling use NZ time independently of host timezone', () => {
  const ctx = {}
  runInNewContext(readFileSync(new URL('./public/nz-time.js', import.meta.url), 'utf8'), ctx)
  assert.equal(ctx.formatNZTime('2026-10-03T05:17:00Z'), '3 Oct, 6:17 pm')
  for (const [iso, wall] of [
    ['2026-10-03T05:17:00.000Z', '2026-10-03T18:17'],
    ['2026-07-03T05:17:00.000Z', '2026-07-03T17:17'],
    ['2026-09-26T14:00:00.000Z', '2026-09-27T03:00']
  ]) {
    assert.equal(ctx.nzDateTimeInput(iso), wall)
    assert.equal(ctx.nzInputToISO(wall), iso)
  }
  assert.throws(() => ctx.nzInputToISO('2026-09-27T02:30'), /does not exist/)
})

test('embedded prose times are NZ while surrounding text stays intact', () => {
  assert.equal(formatNZText('Retry at 2026-10-03T05:17:00.000Z.'), 'Retry at 3 Oct, 6:17 pm.')
})
