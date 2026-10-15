import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync as rmSyncOnce } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Node 24's rmSync ignores maxRetries for EPERM, which Windows gives while a just-killed child
// (or a scanner) still holds the directory: retry here instead.
const rmSync = (path, options) => {
  for (let i = 1; ; i++) {
    try { return rmSyncOnce(path, options) } catch (err) {
      if (i >= 100 || err.code !== 'EPERM') throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}
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
    const untilDone=async()=>{for(let n=0;n<600;n++){const rows=await agentList('proof');if(rows.length&&rows.every(a=>a.agent_status==='done'&&a.agent_session))return rows;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out')}
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
    // Audit 2026-10-15 F4: the resumed session is briefed with what is outstanding only, not the full prompt again.
    assert(resumed[1].startsWith('Re-entry for '+card.id),'resumed turn carries the re-entry brief: '+resumed[1].slice(0,80))
    assert(resumed[1].includes(initial.assignmentId),'re-entry brief names the same assignment')
    assert(resumed[1].includes('stop immediately after it succeeds'))
    assert(!resumed[1].includes('Read each card once'),'no full plan instructions on re-entry')
    assert(resumed[1].length*2<launch[1].length,'re-entry brief is under half the launch prompt')
    assert.match(readFileSync(tasksDir+'/.history/'+card.id+'.jsonl','utf8'),/planner-reentry/)
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
    const result = await run(process.execPath, [driver], { env: { ...process.env, KANBAN_CONFIG: config, HERDR_BIN_PATH: 'missing-herdr-headless-planner' }, timeout: 90000, windowsHide: true })
    assert.match(result.stdout, /headless Planner flow passed/)
  } finally {
    await new Promise(r => setTimeout(r, 1200))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('Planner resumes within the prompt-cache hour and starts fresh after it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'headless-planner-cache-'))
  const config = join(root, 'config.json'), fake = join(root, 'fake.mjs'), driver = join(root, 'driver.mjs')
  const source = name => new URL(name, import.meta.url).href
  writeFileSync(config, JSON.stringify({ projects: ['Proof'], projectsRoot: root, agentBackend: { planner: 'headless' } }))
  writeFileSync(fake, `console.log(JSON.stringify({type:'thread.started',thread_id:'planner-session'})); console.log(JSON.stringify({argv:process.argv.slice(2)})); setTimeout(()=>{},600)`)
  writeFileSync(driver, `
    import assert from 'node:assert/strict'
    import {readFileSync,appendFileSync,readdirSync} from 'node:fs'
    import {headless,createHeadless} from ${JSON.stringify(source('./lib/headless.mjs'))}
    import {runCardPlanner,requestPlannerCorrection} from ${JSON.stringify(source('./lib/card-planner.mjs'))}
    import {createCard,moveCard,findCard} from ${JSON.stringify(source('./lib/cards.mjs'))}
    import {agentList,paneRead} from ${JSON.stringify(source('./lib/herdr.mjs'))}
    const root=${JSON.stringify(root)}, tasksDir=root+'/TASKS', MIN=60000
    Object.assign(headless,createHeadless({root:root+'/.agents',command:()=>[process.execPath,${JSON.stringify(fake)}]}))
    const card=createCard(tasksDir,{title:'Proof',brief:'A specific approved outcome'})
    const args={project:'Proof',projectPath:root,tasksDir,boardRoot:${JSON.stringify(import.meta.dirname)},model:'claude-sonnet-5-5',engine:'claude'}
    const untilDone=async()=>{for(let n=0;n<600;n++){const rows=await agentList('proof');if(rows.length&&rows.every(a=>a.agent_status==='done'&&a.agent_session))return rows;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out')}
    const turns=async id=>(await paneRead(id)).split('\\n').flatMap(line=>{try{const e=JSON.parse(line);return e.argv?[e.argv]:[]}catch{return []}})
    const first=await runCardPlanner(args)
    await untilDone()
    const correct=async(text,now)=>{
      moveCard(tasksDir,card.id,'owner'); await runCardPlanner(args)
      moveCard(tasksDir,card.id,'planning')
      appendFileSync(findCard(tasksDir,card.id).path,'\\n\\n**Review feedback**\\n\\n'+text+'\\n')
      requestPlannerCorrection(tasksDir,card.id)
      return runCardPlanner({...args,now})
    }
    const base=Date.now()
    // AC2: 59 minutes idle keeps the recorded session.
    const warm=await correct('Warm correction text',base+59*MIN)
    assert.equal(warm.spawnedNewAgent,false); assert.equal(warm.pane_id,first.pane_id)
    await untilDone()
    assert.deepEqual((await turns(first.pane_id))[1].slice(-2),['--resume','planner-session'])
    // AC1: 61 minutes idle launches a new Planner without --resume.
    const cold=await correct('Cold correction text',base+61*MIN)
    assert.equal(cold.spawnedNewAgent,true); assert.notEqual(cold.pane_id,first.pane_id)
    await untilDone()
    const launch=(await turns(cold.pane_id))[0]
    assert(!launch.includes('--resume'),'fresh Planner is not resumed')
    // AC4: its own history event and a labelled usage row.
    const events=readFileSync(tasksDir+'/.history/'+card.id+'.jsonl','utf8').split('\\n').filter(Boolean).map(l=>JSON.parse(l)).filter(e=>e.event==='planner-fresh-start')
    assert.equal(events.length,1); assert(events[0].idleMinutes>=61); assert.equal(events[0].previousSession,'planner-session')
    // AC3: the fresh brief carries the correction under Current feedback.
    const briefs=tasksDir+'/.briefs', name=readdirSync(briefs).find(n=>n.startsWith(card.id)&&n.includes('planner'))
    assert.match(readFileSync(briefs+'/'+name,'utf8'),/## Current feedback[\\s\\S]*Cold correction text/)
    console.log('planner cache window passed')
  `)
  try {
    const result = await run(process.execPath, [driver], { env: { ...process.env, KANBAN_CONFIG: config, HERDR_BIN_PATH: 'missing-herdr-headless-planner' }, timeout: 90000, windowsHide: true })
    assert.match(result.stdout, /planner cache window passed/)
  } finally {
    await new Promise(r => setTimeout(r, 1200))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

