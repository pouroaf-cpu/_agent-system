import test from 'node:test'
import assert from 'node:assert/strict'
import { paneClose } from './lib/herdr.mjs'
import { PaneProcessTrees } from './lib/process-tree.mjs'

test('pane retirement kills only its tree, including orphans, and tolerates exited/reused PIDs', async () => {
  const p = (pid, parent, name = 'node.exe', started = String(pid)) => ({ pid, parent, name, started })
  let rows = [p(1, 0, 'herdr.exe'), p(2, 1, 'pwsh.exe'), p(3, 2), p(4, 3, 'python3.exe'), p(5, 1, 'pwsh.exe'), p(6, 5), p(7, 0), p(8, 7), p(9, 0, 'desktop.exe')]
  const killed = []
  const trees = new PaneProcessTrees({ boardPid: 7, list: async () => rows, kill: async targets => {
    for (const row of targets) {
      killed.push(row.pid)
      // This child exited after enumeration; cleanup must still reach the others.
      if (row.pid === 4) rows = rows.filter(p => p.pid !== 4)
      if (row.pid === 2) rows.push(p(13, 2, 'python3.exe')) // spawned during cleanup
      rows = rows.filter(p => p.pid !== row.pid)
    }
  } })
  await trees.observe([{ key: 'default/p1', shellPid: 2 }, { key: 'default/p2', shellPid: 5 }, { key: 'default/server', shellPid: 1 }, { key: 'default/board', shellPid: 7 }])
  assert.equal(trees.panes.size, 2)
  let closed = false
  await paneClose('p1@default', 'legacy', { trees, cli: async (args, options) => {
    assert.deepEqual(killed, [4, 3, 2, 13])
    assert.deepEqual(args, ['pane', 'close', 'p1@default'])
    assert.equal(options.session, 'legacy')
    closed = true
  } })
  assert.equal(closed, true)
  assert.deepEqual(killed.sort((a, b) => a - b), [2, 3, 4, 13])
  killed.length = 0
  // Pane 2 vanished externally; its shell PID was reused outside the pane tree.
  rows = rows.filter(p => p.pid !== 5)
  rows.push(p(5, 9, 'desktop.exe', '100'), p(10, 6, 'WebKitNetworkProcess.exe'))
  await trees.sweep('other-session', new Set())
  assert.deepEqual(killed, [])
  await trees.sweep('default', new Set())
  assert.deepEqual(killed.sort((a, b) => a - b), [6, 10])
  await trees.close('default/p2')
  assert.equal(trees.panes.size, 0)
  // A pane retired before its first poll still resolves and cleans its shell.
  rows.push(p(11, 1, 'pwsh.exe'), p(12, 11, 'python3.exe'))
  killed.length = 0
  await paneClose('p3@default', 'legacy', { trees, cli: async (args, options) => {
    if (args[1] === 'process-info') {
      assert.deepEqual(args, ['pane', 'process-info', '--pane', 'p3'])
      assert.equal(options.session, 'default')
      return { process_info: { shell_pid: 11 } }
    }
    assert.deepEqual(killed, [12, 11])
  } })
  // An ineffective kill keeps the tree tracked for the next sweep but never keeps the pane open.
  const stuck = new PaneProcessTrees({ boardPid: 7, list: async () => [p(14, 1, 'pwsh.exe')], kill: async () => {} })
  await stuck.observe([{ key: 'default/stuck', shellPid: 14 }])
  let stuckClosed = false
  await paneClose('stuck@default', 'legacy', { trees: stuck, cli: async () => { stuckClosed = true } })
  assert.equal(stuckClosed, true, "cleanup failure must not block pane close")
  assert.equal(stuck.panes.size, 1)
})
