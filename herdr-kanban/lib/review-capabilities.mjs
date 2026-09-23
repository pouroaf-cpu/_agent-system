import { existsSync, readFileSync } from 'node:fs'
import { section } from './audit-routing.mjs'

const browserSkill = 'C:/Users/PFrew/.codex/plugins/cache/openai-curated-remote/vercel/0.21.4/skills/agent-browser/SKILL.md'
const posthogSkill = 'C:/Users/PFrew/.codex/plugins/cache/openai-curated-remote/posthog/1.0.0/skills/posthog/SKILL.md'
export function reviewCapabilities(cards) {
  const skills = new Set()
  for (const card of cards) {
    if (!existsSync(card.path)) continue
    const text = readFileSync(card.path, 'utf8')
    const tools = section(text, 'Required tools/MCPs')
    if (/chrome-devtools|browser|playwright/i.test(tools)) skills.add(browserSkill)
    if (/posthog/i.test(tools)) skills.add(posthogSkill)
    for (const match of section(text, 'Required skills').matchAll(/`([A-Za-z]:[\\/][^`]+SKILL\.md)`/g)) skills.add(match[1])
  }
  return [...skills].map(path => ({ path, available: existsSync(path) }))
}
export function capabilityBrief(cards) {
  const skills = reviewCapabilities(cards)
  const gsc = cards.some(card => existsSync(card.path) && /\bgsc\b/i.test(section(readFileSync(card.path, 'utf8'), 'Required tools/MCPs')))
  return `Read only relevant skills: ${skills.filter(s => s.available).map(s => s.path).join(', ') || 'none additionally named'}. ` +
    (skills.some(s => !s.available) ? `Unavailable skill paths: ${skills.filter(s => !s.available).map(s => s.path).join(', ')}; record the gap, do not pretend loaded. ` : '') +
    (gsc ? 'GSC: use only scoped MCP read tools for sc-domain:injectbuddy.com; never submit/delete sitemaps, request indexing, alter OAuth or bypass the allowlist via CLI/API. Record dates, filters, property and evidence. Existing OAuth grant is broader than the reviewer tool allowlist; never expose credentials. ' : '') +
    'Preflight actual MCP/CLI availability (discover deferred tools), correct project, exact rendered route and approved isolated auth/identity. Prefer MCP/CLI; approved Chrome/browser navigation and visual inspection are permitted when useful, but do not assume CUA exists. Record actual command/tool, target/state/viewport and artifacts; visual clipping/overflow/keyboard acceptance needs those checks, not just an automated score. Missing required capability is evidenced bounded technical recovery, never skipped PASS/CLEAR.'
}
