import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// 2026-10-14 (HK39): open-procs.ps1 called a live helper tree ORPHAN when the shell between it and its chat had exited.
// Fake chat (a copy of node named claude.exe) -> shell that spawns a detached helper and exits -> helper whose parent id is gone.
const tools = 'C:/Users/PFrew/Projects/_tools/open-procs'
const openProcs = `${tools}/open-procs.ps1`
const checkOrphans = `${tools}/check-orphans.ps1`
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
const skip = pwsh.status !== 0 ? 'pwsh not available' : !existsSync(openProcs) || !existsSync(checkOrphans) ? `${tools} scripts not present (gitignored, outside the checkout)` : false

const tmp = mkdtempSync(join(tmpdir(), 'hk39-ow-'))
const rnd = randomBytes(4).toString('hex')
const paneId = `headless-hk39-${rnd}`
const hostId = `local_hk39${rnd}`
const pidsToKill = []
const fx = { pid: {}, host: {} } // per variant: { chat, shell, helper }

const isAlive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(100) }
  assert.fail(`timed out waiting for ${what}`)
}
const run = args => {
  const r = spawnSync('pwsh', ['-NoProfile', '-File', ...args], { encoding: 'utf8', env: { ...process.env, OPEN_PROCS_REGISTRY: join(tmp, 'registry.json') }, timeout: 90000 })
  assert.equal(r.status, 0, `${args[0]}: ${r.error?.message || r.stderr}`)
  return r.stdout
}
const rows = () => JSON.parse(run([openProcs, '-Json', '-NewMinutes', '0']))
const rowFor = (all, pid) => all.find(r => r.PID === pid)
const inboxLines = () => (existsSync(join(tmp, 'inbox.md')) ? readFileSync(join(tmp, 'inbox.md'), 'utf8') : '').split('\n')
const checkRun = () => run([checkOrphans, '-LogDir', tmp, '-Inbox', join(tmp, 'inbox.md'), '-NewMinutes', '0', '-NoStop'])

before(async () => {
  if (skip) return
  writeFileSync(join(tmp, 'registry.json'), JSON.stringify([{ id: paneId, name: 'b-hk39fixture' }]))
  // Nothing named codex/server and no -e scripts here: those change what open-procs calls the tree.
  writeFileSync(join(tmp, 'fixture-helper.cjs'), 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 600000)\n')
  writeFileSync(join(tmp, 'fixture-shell.cjs'), [
    "const { spawn } = require('child_process'), { writeFileSync } = require('fs'), { join } = require('path')",
    "const h = spawn(process.env.HK39_NODE, [join(__dirname, 'fixture-helper.cjs')], { detached: true, stdio: 'ignore', windowsHide: true }); h.unref()",
    "writeFileSync(join(__dirname, process.argv[2] + '.json'), JSON.stringify({ shell: process.pid, helper: h.pid }))",
    ''].join('\n'))
  writeFileSync(join(tmp, 'fixture-chat.cjs'), [
    "const { spawn } = require('child_process'), { join } = require('path')",
    "const env = { ...process.env }; if (process.argv[3] === 'pid') env.CLAUDE_PID = String(process.pid)",
    "spawn(process.env.HK39_NODE, [join(__dirname, 'fixture-shell.cjs'), process.argv[2]], { env, stdio: 'ignore', windowsHide: true })",
    'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 600000)',
    ''].join('\n'))
  copyFileSync(process.execPath, join(tmp, 'claude.exe'))
  // The chat is a copy of node named claude.exe; its children must be the real node.exe, which open-procs watches.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_PID|CLAUDE_CODE_HOST_SESSION_ID|HERDR_PANE_ID)$/i.test(k)))
  for (const [variant, extra] of [['pid', { HERDR_PANE_ID: paneId }], ['host', { CLAUDE_CODE_HOST_SESSION_ID: hostId }]]) {
    const chat = spawn(join(tmp, 'claude.exe'), [join(tmp, 'fixture-chat.cjs'), variant, variant], { env: { ...clean, ...extra, HK39_NODE: process.execPath }, stdio: 'ignore', windowsHide: true })
    chat.unref()
    pidsToKill.push(chat.pid)
    fx[variant].chat = chat.pid
  }
  for (const variant of ['pid', 'host']) {
    const file = join(tmp, `${variant}.json`)
    await until(() => existsSync(file) && readFileSync(file, 'utf8').endsWith('}'), `${variant} fixture pids`)
    Object.assign(fx[variant], JSON.parse(readFileSync(file, 'utf8')))
    pidsToKill.push(fx[variant].helper)
    await until(() => !isAlive(fx[variant].shell), `${variant} shell to exit`)
  }
})

after(() => {
  // Only the pids this file started, never by name or pattern.
  for (const pid of pidsToKill) if (pid) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

test('AC1: a live chat that launched the helper owns it although the shell between them exited', { skip }, () => {
  const all = rows()
  for (const variant of ['pid', 'host']) {
    const f = fx[variant]
    assert.ok(isAlive(f.chat) && isAlive(f.helper) && !isAlive(f.shell), `${variant}: fixture state`)
    const r = rowFor(all, f.helper)
    assert.ok(r, `${variant}: helper ${f.helper} has a row`)
    assert.equal(r.Status, 'ok', `${variant}: ${JSON.stringify(r)}`)
    assert.equal(r.Owner, `claude ${f.chat}`)
  }
  assert.match(rowFor(all, fx.pid.helper).Launcher, /b-hk39fixture/)
  assert.ok(rowFor(all, fx.host.helper).Launcher.includes(hostId.slice(0, 14)))
})

test('AC1/AC3: no alert for trees whose chat is alive', { skip }, () => {
  checkRun()
  const text = inboxLines().join('\n')
  for (const variant of ['pid', 'host']) assert.ok(!text.includes(`PID ${fx[variant].helper},`), `${variant}: alerted while the chat is alive`)
})

test('AC2: once the chat is gone the tree is ORPHAN and the Launcher says so', { skip }, async () => {
  for (const variant of ['pid', 'host']) {
    spawnSync('taskkill', ['/F', '/PID', String(fx[variant].chat)], { stdio: 'ignore' })
    await until(() => !isAlive(fx[variant].chat), `${variant} chat to exit`)
    assert.ok(isAlive(fx[variant].helper), `${variant}: helper must outlive the chat`)
  }
  const all = rows()
  for (const variant of ['pid', 'host']) {
    const r = rowFor(all, fx[variant].helper)
    assert.ok(r, `${variant}: helper has a row`)
    assert.equal(r.Status, 'ORPHAN', `${variant}: ${JSON.stringify(r)}`)
    assert.equal(r.Owner, '(gone)')
    assert.match(r.Launcher, /gone$/)
  }
  assert.match(rowFor(all, fx.pid.helper).Launcher, new RegExp(`claude ${fx.pid.chat}.*gone`))
})

test('AC3: the alert names the launching agent or chat', { skip }, () => {
  checkRun()
  const lines = inboxLines()
  const a = lines.find(l => l.includes(`PID ${fx.pid.helper},`))
  const b = lines.find(l => l.includes(`PID ${fx.host.helper},`))
  assert.ok(a, 'alert line for the agent-launched tree')
  assert.ok(b, 'alert line for the chat-launched tree')
  assert.match(a, /launched by b-hk39fixture/)
  assert.ok(b.includes(`launched by ${hostId.slice(0, 14)}`), b)
})
