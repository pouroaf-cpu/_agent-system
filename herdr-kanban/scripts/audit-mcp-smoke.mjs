// One bounded, read-only browser smoke; no AI agent, account writes, or personal profile.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const output = resolve(process.argv[2] || 'artifacts/audit-mcp-smoke')
mkdirSync(output, { recursive: true })
const proc = spawn('cmd.exe', ['/d', '/c', 'npx', '-y', 'chrome-devtools-mcp@1.9.0', '--isolated', '--headless', '--no-usage-statistics', '--no-performance-crux', '--redactNetworkHeaders', '--workspace', output], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
let sequence = 0, buffer = ''
const pending = new Map()
proc.stderr.resume() // Do not persist browser messages that could contain session details.
proc.stdout.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const end = buffer.indexOf('\n')
    if (end < 0) break
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    const waiter = pending.get(msg.id)
    if (waiter) { pending.delete(msg.id); clearTimeout(waiter.timer); msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result) }
  }
})
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)) }, 120000)
  pending.set(id, { resolve, reject, timer })
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
try {
  const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'kanban-audit-preflight', version: '1' } })
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const listed = await request('tools/list')
  writeFileSync(resolve(output, 'tools.json'), JSON.stringify({ server: initialized.serverInfo, tools: listed.tools }, null, 2))
  const call = async (name, args) => {
    const result = await request('tools/call', { name, arguments: args })
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
    writeFileSync(resolve(output, `${name}.json`), JSON.stringify(result, null, 2))
    return result
  }
  const page = await call('new_page', { url: 'https://example.com', isolatedContext: 'kanban-smoke' })
  const pageId = Number(page.content.find(c => c.type === 'text')?.text.match(/^(\d+):.*\[selected\]/m)?.[1])
  if (!pageId) throw new Error('No selected page ID returned')
  await call('lighthouse_audit', { pageId, mode: 'navigation', device: 'mobile', outputDirPath: output })
  await call('performance_start_trace', { pageId, reload: true, autoStop: true, filePath: resolve(output, 'performance-trace.json.gz') })
  const result = { at: new Date().toISOString(), server: initialized.serverInfo, publicTarget: 'https://example.com', headless: true, isolated: true, lighthouse: true, performanceTrace: true }
  // Optional approved local Injectbuddy check. Values stay inside this process and
  // the isolated browser; never print/save the cookie payload or account identity.
  if (process.argv[3]) {
    const base = new URL(process.argv[3])
    if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Auth smoke permits only a controlled local origin')
    const project = resolve(process.argv[4])
    const envRoot = resolve(process.argv[5] || project)
    const require = createRequire(resolve(project, 'package.json'))
    require('dotenv').config({ path: resolve(envRoot, '.env.devtools.local'), quiet: true })
    require('dotenv').config({ path: resolve(envRoot, '.env.local'), quiet: true })
    const jar = []
    const auth = require('@supabase/ssr').createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { cookies: { getAll: () => [], setAll: cookies => jar.push(...cookies) } })
    const { error } = await auth.auth.signInWithPassword({ email: process.env.DEVTOOLS_TEST_EMAIL, password: process.env.DEVTOOLS_TEST_PASSWORD })
    if (error || !jar.length) throw new Error('Approved dev session creation failed; credentials omitted')
    await call('navigate_page', { pageId, url: base.origin, type: 'url' })
    const cookies = jar.map(c => `${c.name}=${c.value}; Path=/; SameSite=Lax`)
    const injected = await request('tools/call', { name: 'evaluate_script', arguments: { pageId, function: `() => { for (const cookie of ${JSON.stringify(cookies)}) document.cookie = cookie; return true }` } })
    if (injected.isError) throw new Error('Session injection failed; sensitive response omitted')
    await call('navigate_page', { pageId, url: base.origin + '/account/', type: 'url' })
    const verified = await call('evaluate_script', { pageId, waitForStableDom: false, function: 'async () => { for (let i=0; i<30 && !document.querySelector("h1"); i++) await new Promise(r => setTimeout(r, 500)); const response = await fetch("/api/me"); const data = await response.json(); const heading = document.querySelector("h1"); return { accountRoute: location.pathname === "/account/", authenticated: response.ok && !!data.user?.email, rendered: !!heading && heading.getBoundingClientRect().height > 0 && document.body.innerText.length > 100 } }' })
    const proof = verified.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
    if (!/"accountRoute"\s*:\s*true/.test(proof) || !/"authenticated"\s*:\s*true/.test(proof) || !/"rendered"\s*:\s*true/.test(proof)) throw new Error('Controlled account route, identity, or rendering was not proven')
    result.authenticatedAccount = true
    result.localOrigin = base.origin
  }
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  proc.stdin.end()
  proc.kill()
}
