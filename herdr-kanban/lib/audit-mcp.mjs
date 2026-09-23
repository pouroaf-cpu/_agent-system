import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export function gscReviewerConfig(tasksDir) {
  if (!/[\\/]Injectbuddy[\\/]TASKS[\\/]?$/i.test(tasksDir)) throw new Error('GSC reviewer connection is approved only for Injectbuddy')
  const entry = 'C:/Users/PFrew/AppData/Local/npm-cache/_npx/a32eaa7134daf82a/node_modules/suganthan-gsc-mcp/dist/index.js'
  const secrets = 'C:/Users/PFrew/.config/claude-seo/oauth_client_gsc.json'
  if (!existsSync(entry) || !existsSync(secrets)) throw new Error('Existing GSC runtime/OAuth setup missing; repair preflight before retry')
  return {
    command: process.execPath, args: [entry],
    env: { GSC_AUTH_MODE: 'oauth', GSC_OAUTH_SECRETS_FILE: secrets, GSC_SITE_URL: 'sc-domain:injectbuddy.com' },
    enabled_tools: ['advanced_search_analytics', 'inspect_url', 'site_snapshot', 'list_sitemaps'],
    disabled_tools: ['submit_url', 'submit_batch', 'submit_sitemap', 'delete_sitemap'],
    required: true, startup_timeout_sec: 60, tool_timeout_sec: 120,
  }
}

function requiresTool(cards, pattern) {
  return cards.some(card => {
    const section = readFileSync(card.path, 'utf8').match(/^## Required tools\/MCPs[^\S\r\n]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] || ''
    return pattern.test(section)
  })
}

export function auditPreflightBlocked(card) {
  return /^\*\*Audit preflight:\*\*\s*(BLOCKED|READY)\b/im.exec(readFileSync(card.path, 'utf8'))?.[1]?.toUpperCase() === 'BLOCKED'
}

export function blockAuditPreflight(card) {
  const text = readFileSync(card.path, 'utf8')
  const marker = /^\*\*Audit preflight:\*\*[^\r\n]*/m
  writeFileSync(card.path, marker.test(text) ? text.replace(marker, '**Audit preflight:** BLOCKED') : `${text}\n\n**Audit preflight:** BLOCKED\n`)
}

// Explicit opt-in in the current tools section; historical logs never enable tools.
export function needsAuditMcp(cards) {
  return requiresTool(cards, /\b(?:chrome-devtools|gsc)\b/i)
}

export function auditMcpEngine(engine, cards, tasksDir) {
  if (!needsAuditMcp(cards)) return engine
  const cfg = typeof engine === 'string' ? { kind: engine } : { ...engine }
  if (cfg.kind !== 'codex') throw new Error('Scoped audit MCP launch currently requires the configured Codex runtime')
  const overrides = []
  if (requiresTool(cards, /\bgsc\b/i)) {
    const gsc = gscReviewerConfig(tasksDir)
    const env = Object.entries(gsc.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')
    overrides.push('-c', `mcp_servers.gsc={ command = ${JSON.stringify(gsc.command)}, args = ${JSON.stringify(gsc.args)}, env = { ${env} }, enabled_tools = ${JSON.stringify(gsc.enabled_tools)}, disabled_tools = ${JSON.stringify(gsc.disabled_tools)}, required = true, startup_timeout_sec = 60, tool_timeout_sec = 120 }`)
  }
  if (requiresTool(cards, /\bchrome-devtools\b/i)) {
    const args = ['/d', '/c', 'npx', '-y', 'chrome-devtools-mcp@1.9.0', '--isolated', '--headless', '--no-usage-statistics', '--no-performance-crux', '--redactNetworkHeaders', '--workspace', tasksDir]
    const mcp = `{ command = "cmd.exe", args = ${JSON.stringify(args)}, required = true, startup_timeout_sec = 60, tool_timeout_sec = 120 }`
    overrides.push('-c', `mcp_servers.chrome-devtools=${mcp}`)
  }
  return { ...cfg, reasoningArgs: [...(cfg.reasoningArgs || []), ...overrides, '-c', 'mcp_optional_startup_grace_ms=0'] }
}
