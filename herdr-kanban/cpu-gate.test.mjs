import test from 'node:test'
import assert from 'node:assert/strict'
import { cpuTicks, addCpuSample, cpuBusyPercent, applyCpuReading, CPU_HOLD_PCT, CPU_RESUME_PCT, CPU_WINDOW_MS } from './lib/cpu-gate.mjs'

const S = 1000
const cpu = (user, nice, sys, irq, idle) => ({ times: { user, nice, sys, irq, idle } })

test('cpuTicks sums busy (user, nice, sys, irq) and idle over every core', () => {
  assert.deepEqual(cpuTicks([cpu(1, 2, 3, 4, 10), cpu(1, 0, 0, 0, 5)]), { busy: 11, idle: 15 })
  assert.deepEqual(cpuTicks([]), { busy: 0, idle: 0 })
  const live = cpuTicks()
  assert.ok(live.busy >= 0 && live.idle >= 0)
})

test('the thresholds: hold above 90%, resume at 75% or less, with the 60 s window', () => {
  assert.deepEqual([CPU_HOLD_PCT, CPU_RESUME_PCT, CPU_WINDOW_MS], [90, 75, 60000])
})

test('cpuBusyPercent is null until the samples span a full 60 s, then the average over that window', () => {
  const samples = []
  addCpuSample(samples, { busy: 0, idle: 0 }, 0)
  addCpuSample(samples, { busy: 45 * S, idle: 5 * S }, 50 * S)
  assert.equal(cpuBusyPercent(samples, 50 * S), null)
  addCpuSample(samples, { busy: 90 * S, idle: 10 * S }, 60 * S)
  assert.equal(cpuBusyPercent(samples, 60 * S), 90)
})

test('the average covers the last 60 s only: a busy spell that has passed no longer counts', () => {
  const samples = []
  for (let t = 0; t <= 120 * S; t += 10 * S) {
    // busy for the first 60 s, idle after
    const busy = Math.min(t, 60 * S), idle = Math.max(0, t - 60 * S)
    addCpuSample(samples, { busy, idle }, t)
  }
  assert.equal(samples[0].now, 60 * S)
  assert.equal(cpuBusyPercent(samples, 120 * S), 0)
})

test('the samples keep one anchor at least 60 s old and drop the rest', () => {
  const samples = []
  for (let t = 0; t <= 120 * S; t += 10 * S) addCpuSample(samples, { busy: t, idle: 0 }, t)
  assert.equal(samples.length, 7)
  assert.equal(samples[0].now, 60 * S)
  assert.equal(samples.at(-1).now, 120 * S)
})

test('applyCpuReading: a null average changes nothing; hold is strictly above 90; resume at 75 or less', () => {
  assert.deepEqual(applyCpuReading({ hold: false }, null), { hold: false, event: 'none' })
  assert.deepEqual(applyCpuReading({ hold: false }, 90), { hold: false, event: 'none' })
  assert.deepEqual(applyCpuReading({ hold: false }, 90.5), { hold: true, event: 'hold' })
  assert.deepEqual(applyCpuReading({ hold: true }, 85), { hold: true, event: 'none' })
  assert.deepEqual(applyCpuReading({ hold: true }, 76), { hold: true, event: 'none' })
  assert.deepEqual(applyCpuReading({ hold: true }, 75), { hold: false, event: 'resume' })
  assert.deepEqual(applyCpuReading({ hold: false }, 60), { hold: false, event: 'none' })
})

test('no flapping: a load that hovers between 76% and 90% holds once and never resumes', () => {
  let state = { hold: false }
  const events = []
  for (const pct of [91, 88, 84, 80, 76, 89, 90, 82]) {
    state = applyCpuReading(state, pct)
    events.push(state.event)
  }
  assert.deepEqual(events, ['hold', 'none', 'none', 'none', 'none', 'none', 'none', 'none'])
  assert.equal(state.hold, true)
})
