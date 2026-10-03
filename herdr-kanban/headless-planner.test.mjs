import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)

test('Planner launches headlessly, resumes corrections, and recovers exits without handoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'headless-planner-'))
  const config = join(root, 'config.json'), fake = join(root, 'fake.mjs'), driver = join(root, 'driver.mjs')
  const source = name => new URL(name, import.meta.url).href
  writeFileSync(config, JSON.stringify({ projects: ['Proof'], projectsRoot: root, agentBackend: { planner: 'headless' } }))
  writeFileSync(fake, `console.log(JSON.stringify({type:'thread.started',thread_id:'planner-session'})); console.log(JSON.stringify({argv:process.argv.slice(2)})); console.log('› [Pasted Content 900 chars]'); setTimeout(()=>{},600)`)
  writeFileSync(driver, `
    import assert from 'node:assert/strict'
    import {readFileSync,existsSync} from 'node:fs'
    import {headless,createHeadless} from ${JSON.stringify(source('./lib/headless.mjs'))}
    import {runCardPlanner,requestPlannerCorrection,readCardPlanners,busyPlanners} from ${JSON.stringify(source('./lib/card-planner.mjs'))}
    import {createCard,moveCard,findCard} from ${JSON.stringify(source('./lib/cards.mjs'))}
    import {promptPath} from ${JSON.stringify(source('./lib/delivery-state.mjs'))}
    import {agentList,paneRead} from ${JSON.stringify(source('./lib/herdr.mjs'))}
    const root=${JSON.stringify(root)}, tasksDir=root+'/TASKS'
    Object.assign(headless,createHeadless({root:root+'/.agents',command:()=>[process.execPath,${JSON.stringify(fake)}]}))
    const card=createCard(tasksDir,{title:'Proof',brief:'A specific approved outcome'})
    const args={project:'Proof',projectPath:root,tasksDir,boardRoot:${JSON.stringify(import.meta.dirname)},model:'claude-sonnet-5-5',engine:'claude',handoffGraceMs:10}
    const untilDone=async()=>{for(let n=0;n<150;n++){const rows=await agentList('proof');if(rows.length&&rows.every(a=>a.agent_status==='done'&&a.agent_session))return rows;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out')}
    const first=await runCardPlanner(args)
    assert.match(first.pane_id,/^headless-/)
    const initial=readCardPlanners(tasksDir)[card.id]
    const done=await untilDone()
    assert.equal(busyPlanners(done),0,'exited Planner does not occupy a live slot')
    const turns=async id=>(await paneRead(id)).split('\\n').flatMap(line=>{try{const e=JSON.parse(line);return e.argv?[e.argv]:[]}catch{return []}})
    const launch=(await turns(first.pane_id))[0]
    assert(launch[1].includes(initial.assignmentId),'full assignment prompt passed at launch')
    assert(!launch[1].startsWith('Read '),'no typed prompt pointer')
    assert(!existsSync(promptPath('proof',first.pane_id)),'no typed-prompt file')
    moveCard(tasksDir,card.id,'owner'); await runCardPlanner(args)
    assert(!(readCardPlanners(tasksDir)[card.id].revokedPaneIds||[]).includes(first.pane_id))
    moveCard(tasksDir,card.id,'planning'); requestPlannerCorrection(tasksDir,card.id)
    const correction=await runCardPlanner(args)
    assert.equal(correction.pane_id,first.pane_id)
    assert.equal(correction.spawnedNewAgent,false)
    assert.equal(readCardPlanners(tasksDir)[card.id].assignmentId,initial.assignmentId)
    await untilDone()
    const resumed=(await turns(first.pane_id))[1]
    assert.deepEqual(resumed.slice(-2),['--resume','planner-session'])
    // Repeat unchanged feedback: delivery dedup must not swallow the resumed turn.
    requestPlannerCorrection(tasksDir,card.id)
    await runCardPlanner(args); await untilDone()
    assert.equal((await turns(first.pane_id)).length,3)
    const base=Date.now()
    await runCardPlanner({...args,now:base})
    const fallback=await runCardPlanner({...args,now:base+11})
    assert(fallback.spawnedNewAgent); assert.notEqual(fallback.pane_id,first.pane_id)
    assert.equal(readCardPlanners(tasksDir)[card.id].noHandoffCount,1)
    assert.equal(readCardPlanners(tasksDir)[card.id].replacementAttempts,0)
    await untilDone()
    await runCardPlanner({...args,now:base+20}); await runCardPlanner({...args,now:base+31})
    assert.equal(findCard(tasksDir,card.id).column,'owner')
    assert.equal(readCardPlanners(tasksDir)[card.id].noHandoffCount,2)
    await runCardPlanner({...args,now:base+40})
    assert.equal(JSON.parse(readFileSync(root+'/.agents/registry.json','utf8')).length,2)
    assert.match(readFileSync(tasksDir+'/.history/'+card.id+'.jsonl','utf8'),/planner-no-handoff/)
    console.log('headless Planner flow passed')
  `)
  try {
    const result = await run(process.execPath, [driver], { env: { ...process.env, KANBAN_CONFIG: config, HERDR_BIN_PATH: 'missing-herdr-headless-planner' }, timeout: 30000, windowsHide: true })
    assert.match(result.stdout, /headless Planner flow passed/)
  } finally {
    await new Promise(r => setTimeout(r, 1200))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

