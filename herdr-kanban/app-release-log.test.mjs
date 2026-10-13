// HK37: app-release.mjs died with EBUSY renaming .expo/metro.log when a Metro child still held it after the kill.
// Guards rotateLog (retry, then copy fallback) and that app-release.mjs uses it. Windows only (PowerShell file handles).
// Both files live in _roles/cmd, which the Projects repo gitignores, so they are read by absolute path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const CMD = 'C:/Users/PFrew/Projects/_roles/cmd'
const { rotateLog } = await import(pathToFileURL(`${CMD}/rotate-log.mjs`).href)

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'app-release-log-'))
  const log = join(dir, 'metro.log')
  writeFileSync(log, 'old text')
  return { dir, log, prev: join(dir, 'metro.prev.log') }
}

// Holds `path` open without delete-sharing for `seconds`, so a rename of it throws EBUSY.
function hold(path, seconds) {
  const ps = `$f=[IO.File]::Open('${path}','Open','ReadWrite','ReadWrite'); 'ready'; Start-Sleep ${seconds}; $f.Close()`
  const child = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(child) })
    child.on('exit', () => reject(new Error('holder exited before ready')))
  })
}

// Kills the holder and waits for it to exit, so its handle is closed before the temp folder is removed.
async function release(child) {
  if (child.exitCode === null) {
    const exited = new Promise((r) => child.on('exit', r))
    child.kill()
    await exited
  }
}

test('log not held: rotated to metro.prev.log and metro.log is gone', async () => {
  const { dir, log, prev } = setup()
  try {
    assert.equal(await rotateLog(log), 'rotated')
    assert.equal(readFileSync(prev, 'utf8'), 'old text')
    assert.equal(existsSync(log), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('log held past the retries: copied, no EBUSY, log stays for the new Metro to truncate', async () => {
  const { dir, log, prev } = setup()
  const holder = await hold(log, 30)
  try {
    assert.equal(await rotateLog(log, { tries: 3, waitMs: 50 }), 'copied')
    assert.equal(readFileSync(prev, 'utf8'), 'old text')
    assert.equal(existsSync(log), true)
  } finally { await release(holder); rmSync(dir, { recursive: true, force: true }) }
})

test('log released while retrying: rotated', async () => {
  const { dir, log, prev } = setup()
  const holder = await hold(log, 1)
  try {
    assert.equal(await rotateLog(log, { tries: 20, waitMs: 100 }), 'rotated')
    assert.equal(readFileSync(prev, 'utf8'), 'old text')
  } finally { await release(holder); rmSync(dir, { recursive: true, force: true }) }
})

test('no log: none', async () => {
  const { dir, log } = setup()
  rmSync(log)
  try { assert.equal(await rotateLog(log), 'none') } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('app-release.mjs rotates through rotateLog, not a bare renameSync', () => {
  const src = readFileSync(`${CMD}/app-release.mjs`, 'utf8')
  assert.match(src, /rotateLog\(log\)/)
  assert.doesNotMatch(src, /renameSync/)
})
