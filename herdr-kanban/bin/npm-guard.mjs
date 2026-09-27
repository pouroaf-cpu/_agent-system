// Board agents get this folder first on PATH (lib/herdr.mjs), so `npm` lands here.
// A card checkout's node_modules is a junction to the shared integration install;
// `npm ci` through it emptied that install for every card (Tradeflow TF103/TF105,
// 2026-09-27). Installs under such a link are refused; everything else runs real npm.
// Claude ignores a settings PATH, so claude-agent-settings.json runs `--env` (SessionStart:
// bin/ first on its Bash PATH) and `--hook` (PreToolUse: the same check on PowerShell commands).
import { lstatSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The asked-for commands plus npm's own aliases for them.
const INSTALLS = new Set(['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean',
  'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add',
  'uninstall', 'unlink', 'remove', 'rm', 'r', 'un', 'update', 'up', 'upgrade', 'udpate', 'prune'])

// The refusal line for `npm <args>` run in cwd, or null to run npm. Looks at cwd and its
// parents up to the repo root (the first folder holding .git).
export function refusal(cwd, args) {
  const cmd = args.find(a => !a.startsWith('-'))
  if (!INSTALLS.has(cmd)) return null
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (lstatSync(join(dir, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink()) {
      return `npm ${cmd} refused: node_modules here is the shared install link; installing through it empties it for every card. Missing packages are [operational]; to change dependencies run cmd /c rmdir node_modules first.`
    }
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return null
  }
}

// Every npm call in a shell command line, checked in cwd or the last cd/Set-Location before it.
// ponytail: a cd target built from variables ($env:X, ~) is not expanded; it falls back to that text.
const CD = /(?:^|[\s;&|(])(?:Set-Location|sl|cd|chdir|Push-Location|pushd)\s+(?:-(?:Literal)?Path\s+)?["']?([^"';&|\r\n]+?)["']?\s*(?=$|[;&|\r\n])/gi
const NPM = /(?:^|[\s;&|(\\/"'])npm(?:\.cmd|\.ps1)?["']?[ \t]+([^;&|)\r\n]*)/gi
export function commandRefusal(command, cwd) {
  const text = String(command), cds = [...text.matchAll(CD)]
  for (const m of text.matchAll(NPM)) {
    const cd = cds.findLast(c => c.index < m.index)
    const why = refusal(cd ? resolve(cwd, cd[1]) : cwd, m[1].trim().split(/\s+/).map(a => a.replace(/^["']|["']$/g, '')))
    if (why) return why
  }
  return null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Claude SessionStart hook: its Bash tool sources CLAUDE_ENV_FILE before each command.
  if (process.argv[2] === '--env') {
    const bin = import.meta.dirname.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
    if (process.env.CLAUDE_ENV_FILE) appendFileSync(process.env.CLAUDE_ENV_FILE, `export PATH="${bin}:$PATH"\n`)
    process.exit(0)
  }
  if (process.argv[2] === '--hook') {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    const why = commandRefusal(input.tool_input?.command || '', input.cwd || process.cwd())
    if (why) { console.error(why); process.exit(2) }
    process.exit(0)
  }
  const args = process.argv.slice(2), why = refusal(process.cwd(), args)
  if (why) { console.error(why); process.exit(1) }
  // Real npm by absolute path next to this node, never via PATH, so the shim cannot recurse.
  // ponytail: assumes npm ships beside node.exe (the Windows installer layout); nvm/volta setups need a lookup.
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
