// Native-hook guardrails, not an OS sandbox. Only this small operation vocabulary
// is parsed; arbitrary shell syntax is never interpreted as an approved command.
import { readFileSync, writeFileSync, appendFileSync, existsSync, lstatSync, realpathSync, openSync, closeSync } from 'node:fs'
import { resolve, dirname, isAbsolute, basename, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const guardScript = fileURLToPath(new URL('../scripts/builder-guard.mjs', import.meta.url))
export const digest = value => createHash('sha256').update(value).digest('hex')
const fail = message => { throw new Error(`Builder guard: ${message}`) }
const key = path => process.platform === 'win32' ? path.toLowerCase() : path

// Reject links on every ancestor, including junctions and a missing file's parent.
export function exactPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path) || path.split(/[\\/]/).includes('..')) fail('an exact absolute path without traversal is required')
  const absolute = resolve(path)
  for (let p = absolute;; p = dirname(p)) {
    if (existsSync(p)) {
      const stat = lstatSync(p)
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) fail('links are not allowed')
      if (key(realpathSync(p)) !== key(p)) fail('redirected path is not allowed')
    }
    if (dirname(p) === p) break
  }
  return absolute
}

export function loadPolicy(path, expectedHash) {
  exactPath(path)
  const bytes = readFileSync(path)
  if (!expectedHash || digest(bytes) !== expectedHash) fail('policy changed or is unverified')
  const policy = JSON.parse(bytes)
  policy.policyPath = resolve(path)
  if (policy.version !== 1 || !policy.approvedBy || !policy.project || !/^T-\d+$/.test(policy.cardId) || !policy.authorizationId) fail('operator-approved policy identity is missing')
  for (const field of ['read', 'write']) {
    if (!Array.isArray(policy[field])) fail(`${field} paths are missing`)
    policy[field] = policy[field].map(exactPath)
  }
  exactPath(policy.workspace)
  if (!policy.pins || !Object.keys(policy.pins).length) fail('trusted executable/script pins are missing')
  for (const [path, hash] of Object.entries(policy.pins)) {
    if (digest(readFileSync(exactPath(path))) !== hash) fail(`approved executable/script changed: ${basename(path)}`)
  }
  for (const command of Object.values(policy.commands || {})) {
    if (!Array.isArray(command.args) || command.args.some(a => typeof a !== 'string') || !policy.pins[command.executable] || !['build', 'test', 'setup', 'handoff', 'git'].includes(command.purpose)) fail('invalid approved command')
    if (/\.(cmd|bat|ps1)$/i.test(command.executable)) fail('use an explicitly pinned native executable, not a shell wrapper')
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 900000) fail('approved command needs a bounded timeout')
  }
  return policy
}

export function validateOperation(policy, operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) fail('invalid operation')
  const fields = { read: ['op', 'path', 'offset'], search: ['op', 'paths', 'text', 'offset'], patch: ['op', 'path', 'before', 'after', 'sha256'], command: ['op', 'id'], gap: ['op', 'reason'] }[operation.op]
  if (!fields || Object.keys(operation).some(k => !fields.includes(k))) fail('unknown operation or arguments; request a scoped deviation')
  const permitted = (path, paths) => { const actual = exactPath(path); if (!paths.some(p => key(p) === key(actual))) fail(`path is outside approved ${operation.op} scope`); return actual }
  if (operation.op === 'read') {
    const log = typeof operation.path === 'string' && operation.path.startsWith(`${policy.policyPath}.`) && /^[a-f0-9-]{36}\.log$/.test(operation.path.slice(policy.policyPath.length + 1))
    permitted(operation.path, [...policy.read, ...policy.write, policy.policyPath, ...(log ? [operation.path] : [])])
  }
  if (operation.op === 'search') {
    if (!Array.isArray(operation.paths) || !operation.paths.length || operation.paths.length > 20 || typeof operation.text !== 'string' || !operation.text.length || operation.text.length > 200) fail('search requires 1–20 exact files and a short literal')
    operation.paths.forEach(p => permitted(p, [...policy.read, ...policy.write]))
  }
  if (['read', 'search'].includes(operation.op) && (!Number.isSafeInteger(operation.offset ?? 0) || (operation.offset ?? 0) < 0)) fail('invalid offset')
  if (operation.op === 'patch') {
    permitted(operation.path, policy.write)
    if (typeof operation.before !== 'string' || typeof operation.after !== 'string' || !/^[a-f0-9]{64}$/.test(operation.sha256 || '') || Buffer.byteLength(operation.after) > 65536) fail('patch needs the current SHA-256 and replacement text under 64 KiB')
    if (Object.keys(policy.pins).some(p => key(resolve(p)) === key(resolve(operation.path)))) fail('pinned tooling cannot be patched; request operator approval')
  }
  if (operation.op === 'command' && !Object.hasOwn(policy.commands || {}, operation.id)) fail('command is not explicitly approved')
  if (operation.op === 'gap' && (typeof operation.reason !== 'string' || !operation.reason.trim() || operation.reason.length > 1000)) fail('give a specific scope gap in at most 1000 characters')
  return operation
}

// A fixed PowerShell invocation plus base64url JSON: no interpolated path, shell
// operator, nested command, redirection, profile or agent-supplied argv is accepted.
export function operationPrefix(policyPath, hash) {
  const quote = text => { if (/["'`$\r\n]/.test(text)) fail('unsafe launcher path'); return `'${text}'` }
  return `& ${quote(process.execPath)} ${quote(guardScript)} operate ${quote(policyPath)} ${quote(hash)} `
}
export function operationFromTool(policy, path, hash, event) {
  if (event.tool_name !== 'Bash') fail('use only the restricted operation helper; alternate tools are denied')
  const command = event.tool_input?.command
  const prefix = operationPrefix(path, hash)
  if (typeof command !== 'string' || !command.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,100000}$/.test(command.slice(prefix.length))) fail('unknown, nested or dynamic shell command denied')
  const encoded = command.slice(prefix.length)
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.toString('base64url') !== encoded) fail('invalid operation encoding')
  return validateOperation(policy, JSON.parse(bytes.toString('utf8')))
}

export function guardEvent(path, hash, event) {
  try {
    const policy = loadPolicy(path, hash)
    if (event.hook_event_name === 'SessionStart') {
      if (!event.session_id || key(resolve(event.cwd || '.')) !== key(resolve(policy.workspace))) fail('startup identity/workspace mismatch')
      writeFileSync(`${path}.active.json`, JSON.stringify({ hash, sessionId: event.session_id, authorizationId: policy.authorizationId }))
      return {}
    }
    if (event.hook_event_name !== 'PreToolUse') fail('unsupported hook event')
    operationFromTool(policy, path, hash, event)
    return {}
  } catch (err) {
    // No raw tool input/secrets in the minimal per-card denial log.
    try { appendFileSync(`${path}.events.jsonl`, JSON.stringify({ at: new Date().toISOString(), event: 'denied', reason: err.message.slice(0, 250) }) + '\n') } catch {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${err.message}. Correct this operation in the same Builder, or request a scoped deviation; do not restart planning.` } }
  }
}

export function assertRestrictedRuntimeVerified() {
  fail('native PreToolUse can fail open on missing/crashed/disabled hooks and does not recheck interactive stdin; restricted dispatch remains disabled')
}

export function assertGuardActive(guard, sessionId) {
  const policy = loadPolicy(guard.path, guard.hash)
  let active
  try { active = JSON.parse(readFileSync(`${guard.path}.active.json`, 'utf8')) } catch { fail('native hook activation is missing; no task prompt sent') }
  if (!sessionId || active.sessionId !== sessionId || active.hash !== guard.hash || active.authorizationId !== policy.authorizationId) fail('native hook activation does not match this session')
  // A SessionStart receipt does NOT attest that PreToolUse is enabled/trusted.
  // Codex currently exposes no independent registration attestation here. Do not
  // turn this into a policy boolean or silently treat unit tests as runtime proof.
  assertRestrictedRuntimeVerified()
}

export function prepareBuilderGuard({ tasksDir, project, card, workspacePath }) {
  const path = join(tasksDir, '.builder-guard', `${card.id}.json`)
  if (!existsSync(path)) fail(`restricted policy is missing for ${card.id}; operator must approve exact paths and commands before dispatch`)
  const hash = digest(readFileSync(path))
  const policy = loadPolicy(path, hash)
  if (policy.project !== project || policy.cardId !== card.id || key(resolve(policy.workspace)) !== key(resolve(workspacePath)) || policy.cardHash !== digest(readFileSync(card.path))) fail('policy does not match the current card/workspace')
  if (!policy.pins[guardScript] || !policy.pins[fileURLToPath(import.meta.url)] || !policy.pins[process.execPath]) fail('guard and Node runtime must be pinned')
  if ([path, guardScript, fileURLToPath(import.meta.url), process.execPath].some(p => policy.write.some(w => key(w) === key(resolve(p))))) fail('guard control files cannot be writable')
  if (existsSync(`${path}.claimed`)) fail('policy was already assigned; do not replay an old authorization')
  const fd = openSync(`${path}.claimed`, 'wx'); closeSync(fd)
  const command = `& '${process.execPath}' '${guardScript}' hook '${path}' ${hash}`
  const group = `[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=10}]}]`
  return { path, hash, args: ['-c', 'web_search="disabled"', '-c', 'features.multi_agent=false', '-c', 'features.js_repl=false', '-c', `hooks.PreToolUse=${group}`, '-c', `hooks.SessionStart=${group}`], prefix: operationPrefix(path, hash) }
}

export async function runOperation(path, hash, operation) {
  const policy = loadPolicy(path, hash)
  validateOperation(policy, operation)
  const offset = operation.offset || 0
  if (operation.op === 'read' || operation.op === 'search') {
    const content = operation.op === 'read' ? readFileSync(operation.path, 'utf8') : operation.paths.flatMap(p => readFileSync(p, 'utf8').split(/\r?\n/).flatMap((line, i) => line.includes(operation.text) ? [`${p}:${i + 1}: ${line}`] : [])).join('\n')
    const page = content.slice(offset, offset + 8000)
    return { text: page, offset, nextOffset: offset + page.length < content.length ? offset + page.length : null, totalCharacters: content.length, complete: offset === 0 && page.length === content.length }
  }
  if (operation.op === 'patch') {
    const original = existsSync(operation.path) ? readFileSync(operation.path, 'utf8') : ''
    if (digest(original) !== operation.sha256) fail('file changed; reread before patching')
    if (operation.before ? original.split(operation.before).length !== 2 : original !== '') fail('patch must match exactly once; empty before is only for empty/new files')
    const updated = operation.before ? original.replace(operation.before, () => operation.after) : operation.after
    exactPath(operation.path)
    writeFileSync(operation.path, updated)
    return { patched: operation.path, sha256: digest(updated) }
  }
  if (operation.op === 'gap') {
    appendFileSync(`${path}.events.jsonl`, JSON.stringify({ at: new Date().toISOString(), project: policy.project, card: policy.cardId, authorizationId: policy.authorizationId, event: 'scope-gap', reason: operation.reason, status: 'awaiting-operator' }) + '\n')
    return { status: 'awaiting-operator', message: 'No allowance changed. Explain the exact proposed deviation and stop; no automatic stage restart.' }
  }
  const command = policy.commands[operation.id]
  const log = `${path}.${randomUUID()}.log`
  const fd = openSync(log, 'wx')
  // stdin is closed: unhooked write_stdin cannot inject another shell command.
  // These explicitly approved subprocesses are trusted, NOT file-sandboxed.
  const result = await new Promise(resolveResult => {
    const child = spawn(command.executable, command.args, { cwd: policy.workspace, shell: false, windowsHide: true, stdio: ['ignore', fd, fd], timeout: command.timeoutMs })
    child.once('error', error => resolveResult({ error: error.message }))
    child.once('close', (code, signal) => resolveResult({ code, signal }))
  }).finally(() => closeSync(fd))
  return { ...result, log, message: 'Full output retained; no log content is implicitly a passing check.' }
}
