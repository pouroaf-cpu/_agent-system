import { createServer as httpServer } from 'node:http'
import { networkInterfaces } from 'node:os'

// The phone board listens on this PC's 192.168.1.x address. DHCP moves that address, so the listener
// follows it instead of staying on the address it launched with (2026-10-16 audit F5). The watchdog then
// has no reason to relaunch the board for an address change.
export const LAN_PREFIX = '192.168.1.'
export const LAN_CHECK_MS = 30000

export function lanAddress(interfaces = networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address.startsWith(LAN_PREFIX)) return entry.address
    }
  }
  return null
}

// host(): the address the phone listener is bound to now, or null while it is not bound.
// check(): re-binds when this PC's LAN address differs from the bound one. Without an address it keeps the current bind.
export function createLanListener({ port, handler, host: initial, current = () => lanAddress(), createServer = httpServer, log = console.log, logError = console.error }) {
  let host = null, server = null
  function bind(next) {
    const listener = createServer(handler)
    listener.on('error', err => {
      logError(`kanban lan ${next}:${port}: ${err.message}`)
      // Not bound: the next check tries again, so a DHCP lease that is not ready yet heals itself.
      if (server === listener) { server = null; host = null }
    })
    server = listener
    host = next
    listener.listen(port, next, () => log(`kanban lan: http://${next}:${port}`))
  }
  function release() {
    const old = server
    server = null
    host = null
    if (old) old.close()
  }
  return {
    host: () => host,
    check() {
      const next = current()
      if (!next || next === host) return host
      if (host) log(`kanban lan: address moved from ${host} to ${next}; re-binding`)
      release()
      bind(next)
      return host
    },
    start(intervalMs = LAN_CHECK_MS) {
      if (initial) bind(initial)
      const timer = setInterval(() => this.check(), intervalMs)
      timer.unref()
      return this
    },
  }
}
