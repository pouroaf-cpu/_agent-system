// CPU-busy hold (audit 2026-10-16 F7). While the 60 s average CPU use is above 90% no new agents
// start, the same as the low-memory hold; it resumes once the average is back to 75% or less. The gap
// between the two stops the hold flapping on a load that hovers near 90%. Samples come from os.cpus()
// tick counters, so no PowerShell process is spawned to read CPU.
import os from 'node:os'

export const CPU_HOLD_PCT = 90
export const CPU_RESUME_PCT = 75
export const CPU_WINDOW_MS = 60000

// Cumulative busy and idle ticks summed over all cores (busy = user + nice + sys + irq).
export function cpuTicks(cpus = os.cpus()) {
  let busy = 0, idle = 0
  for (const cpu of cpus) {
    const t = cpu.times
    busy += t.user + t.nice + t.sys + t.irq
    idle += t.idle
  }
  return { busy, idle }
}

// Adds a sample { ticks, now } to samples (oldest first). The first sample at least CPU_WINDOW_MS old
// is kept as the anchor the average runs from; older ones are dropped.
export function addCpuSample(samples, ticks, now) {
  samples.push({ ticks, now })
  while (samples.length > 2 && now - samples[1].now >= CPU_WINDOW_MS) samples.shift()
  return samples
}

// Average busy percentage over the last CPU_WINDOW_MS; null until the samples span a full window.
export function cpuBusyPercent(samples, now) {
  if (samples.length < 2) return null
  const anchor = samples[0], last = samples.at(-1)
  if (now - anchor.now < CPU_WINDOW_MS) return null
  const busy = last.ticks.busy - anchor.ticks.busy
  const total = busy + (last.ticks.idle - anchor.ticks.idle)
  return total > 0 ? (100 * busy) / total : null
}

// state: { hold }. event is 'hold', 'resume' or 'none'. A null average (no full window yet) changes nothing.
export function applyCpuReading({ hold = false }, pct) {
  if (pct === null || pct === undefined) return { hold, event: 'none' }
  if (!hold && pct > CPU_HOLD_PCT) return { hold: true, event: 'hold' }
  if (hold && pct <= CPU_RESUME_PCT) return { hold: false, event: 'resume' }
  return { hold, event: 'none' }
}
