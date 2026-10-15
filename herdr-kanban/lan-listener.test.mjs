import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createLanListener, lanAddress } from './lib/lan-listener.mjs'

// A listener that records its binds. Addresses in `refuse` fail to bind, as an address that is not on this PC yet does.
function fakeFactory(refuse = new Set()) {
  const made = []
  const createServer = () => {
    const s = new EventEmitter()
    s.binds = []
    s.closed = false
    s.listen = (port, host, cb) => {
      s.binds.push([port, host])
      if (refuse.has(host)) { queueMicrotask(() => s.emit('error', Object.assign(new Error('address not available'), { code: 'EADDRNOTAVAIL' }))); return }
      cb?.()
    }
    s.close = () => { s.closed = true }
    made.push(s)
    return s
  }
  return { createServer, made }
}

test('lanAddress picks this PC\'s 192.168.1.x IPv4 and ignores loopback, IPv6 and other subnets', () => {
  assert.equal(lanAddress({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    vEthernet: [{ address: '172.20.0.5', family: 'IPv4', internal: false }],
    wifi: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.4', family: 'IPv4', internal: false }],
  }), '192.168.1.4')
  assert.equal(lanAddress({ eth: [{ address: '192.168.1.9', family: 'IPv4', internal: true }] }), null)
  assert.equal(lanAddress({}), null)
})

test('the listener starts on the launch address and re-binds when DHCP moves this PC to another 192.168.1.x', () => {
  const { createServer, made } = fakeFactory()
  const logs = []
  let address = '192.168.1.4'
  const lan = createLanListener({ port: 7777, handler: () => {}, host: '192.168.1.4', current: () => address, createServer, log: m => logs.push(m), logError: m => logs.push(m) })
  lan.start(60 * 60000)
  assert.equal(lan.host(), '192.168.1.4')
  assert.equal(lan.check(), '192.168.1.4')
  assert.equal(made.length, 1, 'an unchanged address is not re-bound')

  address = '192.168.1.11'
  assert.equal(lan.check(), '192.168.1.11')
  assert.equal(made.length, 2)
  assert.equal(made[0].closed, true, 'the old socket is closed')
  assert.deepEqual(made[1].binds, [[7777, '192.168.1.11']])
  assert.ok(logs.some(l => l === 'kanban lan: address moved from 192.168.1.4 to 192.168.1.11; re-binding'))
  assert.ok(logs.some(l => l === 'kanban lan: http://192.168.1.11:7777'))
})

test('no LAN address keeps the current bind; a bind that fails leaves the listener unbound until the next check', async () => {
  const refuse = new Set(['192.168.1.20'])
  const { createServer, made } = fakeFactory(refuse)
  let address = null
  const lan = createLanListener({ port: 7777, handler: () => {}, host: '192.168.1.4', current: () => address, createServer, log: () => {}, logError: () => {} })
  lan.start(60 * 60000)
  assert.equal(lan.check(), '192.168.1.4', 'no address: nothing is released')
  assert.equal(made[0].closed, false)

  address = '192.168.1.20'
  assert.equal(lan.check(), '192.168.1.20')
  await new Promise(done => setImmediate(done)) // the refusal arrives as an error event
  assert.equal(lan.host(), null, 'the failed bind is not reported as bound')

  refuse.clear()
  address = '192.168.1.20'
  assert.equal(lan.check(), '192.168.1.20', 'the next check binds the same address once it is available')
  assert.equal(lan.host(), '192.168.1.20')
})
