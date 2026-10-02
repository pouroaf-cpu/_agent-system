import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('I569/I572: PowerShell npm forwards script flags like npm.cmd', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(import.meta.dirname, '.npm-shim-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:calc-smoke': 'node args.cjs' } }))
  writeFileSync(join(root, 'args.cjs'), 'console.log("FORWARDED:" + JSON.stringify(process.argv.slice(2))); process.exitCode = 7')
  const bin = join(import.meta.dirname, 'bin'), shim = join(bin, 'npm.ps1')
  const quote = s => `'${s.replaceAll("'", "''")}'`
  const args = ['run', '--silent', 'test:calc-smoke', '--', '--grep', '/blend-calculator/', '--list', 'two words', '--', '--last']
  const invoke = invocation => {
    const r = spawnSync('pwsh', ['-NoProfile', ...invocation], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${bin};${process.env.PATH}`, npm_config_cache: join(root, '.npm-cache'), npm_config_update_notifier: 'false' },
    })
    assert.equal(r.status, 7, `${invocation.join(' ')}\n${r.error || ''}\n${r.stdout}\n${r.stderr}`)
    assert.doesNotMatch(r.stderr, /Unknown cli config/)
    return JSON.parse(r.stdout.match(/^FORWARDED:(.*)$/m)?.[1] || 'null')
  }
  const baseline = invoke(['-Command', `& ${quote(join(dirname(process.execPath), 'npm.cmd'))} ${args.map(quote).join(' ')}; exit $LASTEXITCODE`])
  assert.deepEqual(baseline, args.slice(4))
  for (const invocation of [
    ['-File', shim, ...args],
    ['-Command', `npm run --silent test:calc-smoke -- ${args.slice(4).map(quote).join(' ')}; exit $LASTEXITCODE`],
    ['-Command', `npm ${args.map(quote).join(' ')}; exit $LASTEXITCODE`],
    ['-Command', `$head = @('run', '--silent', 'test:calc-smoke'); npm @head -- ${args.slice(4).map(quote).join(' ')}; exit $LASTEXITCODE`],
    ['-Command', `$forward = @(${args.map(quote).join(', ')}); npm @forward; exit $LASTEXITCODE`],
  ]) assert.deepEqual(invoke(invocation), baseline, invocation.join(' '))
  assert.deepEqual(invoke(['-Command', 'npm run --silent test:calc-smoke; exit $LASTEXITCODE']), [])
})
