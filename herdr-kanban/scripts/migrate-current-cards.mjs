// One-off, conservative legacy-card compaction. Dry-run is the default.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { readBoard, parseCard, currentReviewDecision, latestDirtySnapshot, cardFiles } from '../lib/cards.mjs'
import { recoveryState } from '../lib/recovery.mjs'
import { appendHistory, historyPath } from '../lib/card-history.mjs'
import { withBoardLock } from '../lib/bindings.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = value => createHash('sha256').update(value).digest('hex')
const marker = '<!-- compact-history-migration: 2026-09-18 -->'
const event = /^\*\*(Kicked back|Spawn failed|Review feedback|Needs you|Planner recovery)\*\*[^\r\n]*(?:\r?\n|$)/
const exactSections = ['Approved brief', 'Approved audit scope', 'Goal', 'Project constraints', 'Files', 'Implementation plan', 'Acceptance criteria', 'Outcome checks', 'Prerequisites']
const section = (text, name) => text.match(new RegExp(`^## ${name}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1]?.trim() || ''
const metadata = text => text.split(/\r?\n/).filter(line => /^\*\*/.test(line))

export function compact(text, history, sourceHash) {
  if (text.includes(marker)) return text
  const parts = text.split(/(?=^## |^\*\*)/m)
  const latest = new Map()
  const kind = label => ['Kicked back','Spawn failed','Review feedback'].includes(label) ? 'failure' : label
  parts.forEach((part, i) => { const m = part.match(event); if (m) latest.set(kind(m[1]), i) })
  let next = parts.map((part, i) => {
    const m = part.match(event)
    if (!m || latest.get(kind(m[1])) === i) return part
    const body = part.slice(m[0].length)
    if (body.trim().length < 350 || /^#{1,6} |^```|^\*\*/m.test(body)) return part
    // ponytail: archive only superseded event prose; ambiguous plans stay exact.
    const summary = body.trim().split(/\r?\n/)[0]
    const excerpt = summary.length > 240 ? `${summary.slice(0,240)}…` : summary
    const legacyCount = (body.match(/\*\*Review feedback\*\*/g)||[]).length - (excerpt.match(/\*\*Review feedback\*\*/g)||[]).length
    return `${m[0]}\nHistorical failure excerpt (full record in linked history): ${excerpt}\n${'<!-- Legacy counted marker: **Review feedback** -->\n'.repeat(legacyCount)}\n---\n\n`
  }).join('')
  // T-117 explicitly declares older retry plans superseded in its current handoff.
  if (text.includes('## Verified recovery handoff — 2026-09-17 (supersedes older retry plans)')) {
    next = next.replace(/^## (?:Reviewer corrective evidence follow-up|Returned-card repaired evidence plan|Returned-card evidence plan repair|Diagnostic recovery plan|Review-lane recovery plan|Trace proof-first recovery plan|CDP guest-state recovery plan|Collector guest-flow repair plan)[^\r\n]*\r?\n[\s\S]*?(?=^## |^\*\*|$(?![\s\S]))/gm, matched => `${matched.split(/\r?\n/)[0]}\nSuperseded by the current verified recovery handoff; full plan retained in linked history.\n\n`)
  }
  const provenance = `## History\n${marker}\nOriginal: [complete card history](${history.replaceAll('\\','/')}) (source SHA-256: ${sourceHash}).\nFormatting only; existing approvals, missing requirements, verdicts and holds remain unchanged. No new plan approval or retry authorization.\n\n`
  return next.replace(/^## /m, provenance+'## ')
}

function state(file, column) {
  const { mtime, added, path: cardPath, file: filename, ...card } = parseCard(file, column)
  const text = fs.readFileSync(file, 'utf8')
  return { card, recovery: recoveryState(text), review: currentReviewDecision(text), dirty: latestDirtySnapshot(file), files: cardFiles(file) }
}
function validate(original, candidate, file, column) {
  const before = fs.readFileSync(original, 'utf8'), after = fs.readFileSync(candidate, 'utf8')
  assert.deepEqual(metadata(after), metadata(before), 'metadata/chronology changed')
  for (const name of exactSections) assert.equal(section(after,name), section(before,name), `${name} changed`)
  assert.deepEqual(state(candidate,column),state(original,column),'parsed card state changed')
  assert.equal(compact(after,'ignored','ignored'),after,'not idempotent')
}

function snapshotProtected(config) {
  const result = {}
  const claims = path.join(root,'.review-claims.json')
  if (fs.existsSync(claims)) result[claims] = sha(fs.readFileSync(claims))
  for (const project of config.projects) {
    const tasks = path.join(config.projectsRoot,project,'TASKS')
    if (!fs.existsSync(tasks)) continue
    for (const name of fs.readdirSync(tasks)) {
      if (!name.startsWith('.') || name.endsWith('.tmp') || name.endsWith('.lock')) continue
      const file = path.join(tasks,name)
      if (fs.statSync(file).isFile()) result[file] = sha(fs.readFileSync(file))
    }
    const archive = path.join(tasks,'archive')
    if (fs.existsSync(archive)) for (const name of fs.readdirSync(archive)) {
      const file = path.join(archive,name)
      if (fs.statSync(file).isFile()) result[file] = sha(fs.readFileSync(file))
    }
  }
  return result
}

function main() {
  const apply = process.argv.includes('--apply')
  const config = JSON.parse(fs.readFileSync(path.join(root,'board.config.json'),'utf8'))
  assert.equal(config.maxConcurrentAgents,0,'global dispatch must remain paused')
  const protectedBefore = snapshotProtected(config)
  const output = path.join(root,'artifacts','card-migration',apply ? 'applied' : 'dry-run')
  fs.mkdirSync(output,{recursive:true})
  const rows = []
  for (const project of config.projects) {
    const tasks = path.join(config.projectsRoot,project,'TASKS')
    const cards = Object.values(readBoard(tasks)).flat().filter(c=>c.column!=='archive')
    for (const card of cards) {
      const row = {project,id:card.id,column:card.column,path:card.path}
      rows.push(row)
      let temp
      try {
        assert.equal(cards.filter(c=>c.id===card.id).length,1,'ambiguous duplicate live ID')
        const original = fs.readFileSync(card.path)
        const sourceHash = sha(original)
        row.beforeBytes = original.length
        if (original.toString('utf8').includes(marker)) { row.status='already-migrated'; row.afterBytes=original.length; continue }
        const candidate = compact(original.toString('utf8'),historyPath(tasks,card.id),sourceHash)
        assert.ok(candidate.includes(marker),'missing section boundary; no migration performed')
        const folder = path.join(output,project,card.column)
        fs.mkdirSync(folder,{recursive:true})
        const preview = path.join(folder,card.file)
        const sourceFile = preview + '.original'
        fs.writeFileSync(sourceFile,original)
        fs.writeFileSync(preview,candidate)
        validate(card.path,preview,card.path,card.column)
        row.afterBytes = Buffer.byteLength(candidate)
        row.sourceHash = sourceHash
        row.status = 'dry-run'
        if (apply) withBoardLock(tasks,()=>{
          assert.equal(sha(fs.readFileSync(card.path)),sourceHash,'concurrent card change; skipped')
          const entry = appendHistory(tasks,card.id,{event:'migration-source',agent:'card-migration',sourcePath:card.path,sourceHash,text:original.toString('utf8'),originalBase64:original.toString('base64')})
          const history = historyPath(tasks,card.id)
          const historyFd = fs.openSync(history,'r+')
          try { fs.fsyncSync(historyFd) } finally { fs.closeSync(historyFd) }
          const saved = fs.readFileSync(history,'utf8').trimEnd().split('\n').map(JSON.parse).find(e=>e.id===entry.id)
          assert.equal(sha(Buffer.from(saved.originalBase64,'base64')),sourceHash,'history bytes mismatch')
          temp = `${card.path}.migration-${randomUUID()}.tmp`
          fs.writeFileSync(temp,candidate,{flag:'wx'})
          const fd = fs.openSync(temp,'r+')
          try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
          assert.equal(sha(fs.readFileSync(card.path)),sourceHash,'concurrent card change; skipped')
          fs.renameSync(temp,card.path)
          temp = null
          row.historyId=entry.id
          row.status='migrated'
          assert.equal(fs.readFileSync(card.path,'utf8'),candidate)
          validate(sourceFile,card.path,card.path,card.column)
        })
      } catch(error) { row.status='skipped'; row.reason=error.message }
      finally { if(temp && fs.existsSync(temp)) fs.unlinkSync(temp) }
    }
  }
  const protectedAfter=snapshotProtected(config)
  const protectedUnchanged=JSON.stringify(protectedBefore)===JSON.stringify(protectedAfter)
  const concurrentlyChangedState=Object.keys({...protectedBefore,...protectedAfter}).filter(p=>protectedBefore[p]!==protectedAfter[p])
  const archivesUnchanged=concurrentlyChangedState.every(p=>!p.includes(`${path.sep}archive${path.sep}`))
  const paused=JSON.parse(fs.readFileSync(path.join(root,'board.config.json'),'utf8')).maxConcurrentAgents===0
  const report={at:new Date().toISOString(),apply,protectedFiles:Object.keys(protectedBefore).length,protectedUnchanged,archivesUnchanged,concurrentlyChangedState,paused,protectedBefore,protectedAfter,rows}
  const reportPath=path.join(output,'report.json')
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({report:reportPath,cards:rows.length,statuses:rows.reduce((all,r)=>(all[r.status]=(all[r.status]||0)+1,all),{}),beforeBytes:rows.reduce((n,r)=>n+(r.beforeBytes||0),0),afterBytes:rows.reduce((n,r)=>n+(r.afterBytes||r.beforeBytes||0),0),skipped:rows.filter(r=>r.status==='skipped').map(({project,id,reason})=>({project,id,reason}))},null,2))
  assert.ok(archivesUnchanged,'archive changed; inspect saved report')
  assert.ok(paused,'global pause changed; inspect saved report')
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main()
