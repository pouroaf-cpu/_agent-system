import { guardEvent, runOperation } from '../lib/builder-guard.mjs'
const [mode, path, hash, payload] = process.argv.slice(2)
try {
  if (mode === 'hook') {
    let input = ''
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 200000) throw new Error('hook input exceeds limit') }
    process.stdout.write(JSON.stringify(guardEvent(path, hash, JSON.parse(input))))
  } else if (mode === 'operate') {
    process.stdin.destroy()
    process.stdout.write(JSON.stringify(await runOperation(path, hash, JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))))
  } else throw new Error('unknown guard mode')
} catch (error) {
  // Native PreToolUse exit 2 denies, including malformed input/policy failures.
  process.stderr.write(`Builder guard refused: ${error.message}`)
  process.exitCode = 2
}
