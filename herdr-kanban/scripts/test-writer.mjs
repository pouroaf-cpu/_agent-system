#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_INTEGRATION, TEST_TYPES, staticAppRoutes } from '../lib/test-runs.mjs'

try {
  const args = process.argv.slice(2)
  const option = name => args[args.indexOf(name) + 1]
  const type = option('--type'), pages = option('--pages')?.split(','), out = option('--out')
  if (!args.includes('--type') || !Object.hasOwn(TEST_TYPES, type) || !args.includes('--pages') || !pages?.length || !args.includes('--out') || !out?.endsWith('.spec.ts')) throw new Error('Usage: node scripts/test-writer.mjs --type <type> --pages /a,/b --out <file.spec.ts>')
  if (type === 'axe' && !existsSync(join(TEST_INTEGRATION, 'node_modules', '@axe-core', 'playwright', 'package.json'))) throw new Error('@axe-core/playwright is not installed in the Injectbuddy integration node_modules')
  const routes = staticAppRoutes(join(TEST_INTEGRATION, 'app'))
  if (pages.some(p => !routes.includes(p))) throw new Error('Unknown page')
  const prompt = `Scope: ${TEST_TYPES[type]}.
Write ONE Playwright test file (TypeScript).
Routes to test: ${JSON.stringify(pages)}
Write one test per page, titled exactly by its page path, e.g. test('/calendar', ...). Wait with page.waitForLoadState('load'), NEVER 'networkidle'.
Match the conventions of this example spec and config. Use relative paths; base URL comes from the config.
--- playwright.config.ts ---
${readFileSync(join(TEST_INTEGRATION, 'playwright.config.ts'), 'utf8')}
--- e2e/home-trust.spec.ts ---
${readFileSync(join(TEST_INTEGRATION, 'e2e', 'home-trust.spec.ts'), 'utf8')}
---
Reply with ONLY the file contents. No prose, no code fences.`
  const messages = [{ role: 'user', content: prompt }]
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('http://localhost:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'qwen3-coder-32k:latest', stream: false, messages }) })
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`)
    const response = await res.json()
    const spec = (response.message?.content || '').trim().replace(/^```\w*\s*\n|\n?```\s*$/g, '').trim()
    const problems = []
    if (!spec.includes('@playwright/test')) problems.push('missing @playwright/test import')
    if (!spec.includes('test(')) problems.push('missing test(')
    if (spec.includes('networkidle')) problems.push('networkidle is forbidden; use page.waitForLoadState(\'load\')')
    if (!problems.length) { writeFileSync(out, spec + '\n'); break }
    if (attempt) throw new Error('Invalid generated spec: ' + problems.join('; '))
    messages.push({ role: 'assistant', content: spec }, { role: 'user', content: 'Fix these problems: ' + problems.join('; ') + '. Reply with only the complete file contents.' })
  }
} catch (err) { console.error(err.message); process.exitCode = 1 }
