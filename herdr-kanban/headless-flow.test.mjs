import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)

test('real Reviewer and plan-check dispatch use headless transport with no herdr and preserve the unchanged check snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'headless-flow-')), repo = join(root, 'repo'), tasks = join(root, 'TASKS')
  mkdirSync(repo); mkdirSync(join(tasks, 'review'), { recursive: true }); mkdirSync(join(tasks, 'backlog'), { recursive: true })
  const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr) }
  git(['init']); writeFileSync(join(repo, 'app.mjs'), 'export const result = false\n'); git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'])
  const card = id => `# ${id} — check result\n**Workflow:** card-owned\n## Approved brief\nMake result true\n## Files\n- \`app.mjs\` result\n## Implementation plan\nCheck: node app.mjs\n**Base check:** result is false\n## Acceptance criteria\nResult true\n`
  writeFileSync(join(tasks, 'review', 'T-1.md'), card('T-1')); writeFileSync(join(tasks, 'backlog', 'T-2.md'), card('T-2'))
  const config = join(root, 'board.config.json')
  writeFileSync(config, JSON.stringify({ projects: ['Proof'], projectsRoot: root, maxConcurrentAgents: 1, agentBackend: { reviewer: 'headless', plancheck: 'headless' } }))
  const fake = join(root, 'fake.mjs')
  writeFileSync(fake, `console.log(JSON.stringify({type:'thread.started',thread_id:'fake-session'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})}})); setTimeout(()=>{},600)`)
  const driver = join(root, 'driver.mjs')
  const source = name => new URL(name, import.meta.url).href
  writeFileSync(driver, `
    import assert from 'node:assert/strict'
    import {headless,createHeadless} from ${JSON.stringify(source('./lib/headless.mjs'))}
    import {spawnReviewer,finishPlanCheck} from ${JSON.stringify(source('./lib/autospawn.mjs'))}
    import {agentList,paneRead,paneClose} from ${JSON.stringify(source('./lib/herdr.mjs'))}
    import {readReviewClaims} from ${JSON.stringify(source('./lib/review-claims.mjs'))}
    import {semanticDirtyFiles} from ${JSON.stringify(source('./lib/worktrees.mjs'))}
    import {findCard} from ${JSON.stringify(source('./lib/cards.mjs'))}
    const root=${JSON.stringify(root)},repo=${JSON.stringify(repo)},tasksDir=${JSON.stringify(tasks)}
    Object.assign(headless,createHeadless({root:root+'/.agents',command:()=>[process.execPath,${JSON.stringify(fake)}]}))
    const inventory=async()=>[{project:'Proof',tasksDir,known:true,agents:await agentList('proof')}]
    const common={project:'Proof',projectPath:repo,tasksDir,boardRoot:${JSON.stringify(import.meta.dirname)},reviewRoot:root,inventory,model:'gpt-6-luna',engine:'codex',assignmentForCard:()=>({engine:'codex',model:'gpt-6-luna',reasoning:'low'})}
    const review=await spawnReviewer({...common,cardIds:['T-1']})
    const check=await spawnReviewer({...common,cardIds:['T-2'],planCheck:true})
    assert.match(review.pane_id,/^headless-/); assert.match(check.pane_id,/^headless-/)
    for(let n=0;n<100;n++){if((await agentList('proof')).every(a=>a.agent_status==='done'))break; await new Promise(r=>setTimeout(r,50))}
    const claims=readReviewClaims(root)
    assert.equal(claims.length,2); assert(claims.every(c=>c.phase==='running'))
    const claim=claims.find(c=>c.role==='plancheck')
    assert.deepEqual(semanticDirtyFiles(claim.snapshot.path),[])
    const output=await paneRead(check.pane_id)
    const event=output.split('\\n').map(line=>{try{return JSON.parse(line)}catch{return null}}).find(e=>e?.item?.type==='agent_message')
    const data=JSON.parse(event.item.text)
    assert.equal(data.cwd,claim.snapshot.path)
    assert(data.argv.at(-1).includes(claim.id),'full claim-owned prompt is passed at launch')
    assert(!data.argv.at(-1).startsWith('Read '),'no typed delivery pointer')
    assert.equal(finishPlanCheck({tasksDir,cardId:'T-2',reviewRoot:root,claimId:claim.id,verdict:'PASS',evidence:'assertion failed; app.mjs fixture verified'}).to,'queue')
    assert.equal(findCard(tasksDir,'T-2').column,'queue')
    await paneClose(review.pane_id); await paneClose(check.pane_id)
    console.log('headless flow passed')
  `)
  try {
    const result = await run(process.execPath, [driver], { env: { ...process.env, KANBAN_CONFIG: config, HERDR_BIN_PATH: 'missing-herdr-headless-flow' }, timeout: 30000, windowsHide: true })
    assert.match(result.stdout, /headless flow passed/)
    assert.equal(JSON.parse(readFileSync(join(root, '.agents', 'registry.json'), 'utf8')).length, 2)
  } finally { await new Promise(resolve => setTimeout(resolve, 1200)); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
})
