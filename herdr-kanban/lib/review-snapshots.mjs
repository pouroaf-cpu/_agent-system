// Closed review claims leave a detached worktree in review-workspaces/<claimId>.
// Keep what the reviewer wrote (untracked files + a patch of tracked edits) in
// review-evidence/<claimId>/, then remove the worktree. Never throws.

import { existsSync, readdirSync, lstatSync, unlinkSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readReviewClaims } from './review-claims.mjs'
import { activityLog } from './activity.mjs'

const exec = promisify(execFile)
const git = async (cwd, args) => (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000, windowsHide: true })).stdout
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
// Build and dependency output, never evidence.
const SKIP = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', 'ms-playwright'])

// Remove links (the node_modules junction into the live project) and real
// dependency folders first, so neither Git nor rm can reach outside the snapshot.
async function detach(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue
    const path = join(dir, name), stat = lstatSync(path)
    if (stat.isSymbolicLink()) unlinkSync(path)
    else if (stat.isDirectory()) name === 'node_modules' ? await rm(path, { recursive: true, force: true }) : await detach(path)
  }
}
const hasFiles = dir => readdirSync(dir, { withFileTypes: true }).some(e => !e.isDirectory() || e.isSymbolicLink() || hasFiles(join(dir, e.name)))

export async function cleanReviewSnapshot(root, claimId) {
  const path = join(root, 'review-workspaces', claimId)
  if (!existsSync(path)) return null
  // A half-removed snapshot resolves to the enclosing repo; only an empty leftover may go.
  const top = await git(path, ['rev-parse', '--show-toplevel']).catch(() => '')
  if (!top || !same(top.trim(), path)) {
    if (hasFiles(path)) throw new Error(`${path} is not an intact Git worktree; left for inspection`)
    await rm(path, { recursive: true, force: true })
    return { claimId, files: 0, bytes: 0 }
  }
  const common = (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  await detach(path)
  const out = join(root, 'review-evidence', claimId)
  const kept = (await git(path, ['ls-files', '--others', '-z'])).split('\0').filter(f => f && !f.split('/').some(s => SKIP.has(s)))
  let bytes = 0
  for (const file of kept) {
    mkdirSync(dirname(join(out, file)), { recursive: true })
    copyFileSync(join(path, file), join(out, file))
    bytes += statSync(join(out, file)).size
  }
  const patch = await git(path, ['diff', 'HEAD', '--binary'])
  if (patch) {
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'diff.patch'), `# review snapshot base ${(await git(path, ['rev-parse', 'HEAD'])).trim()}\n${patch}`)
    bytes += Buffer.byteLength(patch)
  }
  const repo = dirname(common)
  await git(repo, ['worktree', 'remove', '--force', path]).catch(() => {}) // Windows may leave files behind; rm below.
  await rm(path, { recursive: true, force: true })
  await git(repo, ['worktree', 'prune'])
  return { claimId, files: kept.length + (patch ? 1 : 0), bytes }
}

const note = (claim, message, level = 'info') =>
  activityLog({ tasksDir: claim.tasksDir, project: claim.project, cardId: claim.cards.join(',') || '-', event: 'cleanup', message, level })

let running = null
// Snapshots of closed claims only; an open claim's snapshot is the code under review.
export function cleanClosedReviewSnapshots(root, log = note) {
  running ??= (async () => {
    const results = []
    try {
      if (!existsSync(join(root, 'review-workspaces'))) return results
      const folders = new Set(readdirSync(join(root, 'review-workspaces')))
      for (const claim of readReviewClaims(root).filter(c => c.closedAt && folders.has(c.id))) {
        try {
          const result = await cleanReviewSnapshot(root, claim.id)
          if (result) { results.push(result); log(claim, `review snapshot ${claim.id} removed; ${result.files} evidence file(s) kept in review-evidence/${claim.id}`) }
        } catch (err) { log(claim, `review snapshot ${claim.id} cleanup failed: ${err.message}`, 'error') }
      }
    } catch (err) { console.error(`review snapshot cleanup failed: ${err.message}`) }
    return results
  })().finally(() => { running = null })
  return running
}
