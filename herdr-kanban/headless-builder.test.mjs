import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)

test('headless Builders bind their worktree, resume corrections, and recover exits with and without handoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'headless-builder-')), repo = join(root, 'repo'), tasks = join(root, 'TASKS')
  mkdirSync(join(repo, 'app'), { recursive: true }); mkdirSync(join(tasks, 'queue'), { recursive: true })
  const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr) }
  git(['init']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com'])
  writeFileSync(join(repo, 'app', 'result.mjs'), 'export const result = false\n'); git(['add', '.']); git(['commit', '-qm', 'base'])
  const source = name => new URL(name, import.meta.url).href
  const fake = join(root, 'fake.mjs'), config = join(root, 'config.json'), driver = join(root, 'driver.mjs')
  writeFileSync(config, JSON.stringify({ agentBackend: { builder: 'headless' } }))
  writeFileSync(fake, `
    import {readFileSync,appendFileSync,writeFileSync} from 'node:fs'
    import {spawnSync} from 'node:child_process'
    import {fileURLToPath} from 'node:url'
    import {findCard} from ${JSON.stringify(source('./lib/cards.mjs'))}
    const argv=process.argv.slice(2), session='session-'+process.env.BOARD_AGENT_ID
    console.log(JSON.stringify(argv.includes('exec')?{type:'thread.started',thread_id:session}:{type:'system',subtype:'init',session_id:session}))
    console.log(JSON.stringify({argv,cwd:process.cwd()}))
    console.log('› [Pasted Content 900 chars]')
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'Should I delete the worktree?'}}))
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Turn finished.'}}))
    setTimeout(()=>{
      if(readFileSync(${JSON.stringify(join(root, 'mode'))},'utf8')==='handoff'){
        const tasks=${JSON.stringify(tasks)}, id=argv.join(' ').match(/done (T-\\d+)/)[1], card=findCard(tasks,id)
        writeFileSync('result.mjs','export const result = true\\n')
        for(const args of [['add','result.mjs'],['commit','-qm',id+': result true']]){
          const r=spawnSync('git',args,{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr)
        }
        appendFileSync(card.path,'\\n## Implementation\\nStage: builder\\nOutcome: PASS\\nFiles: result.mjs\\nBlocker: none\\n\\n## Evidence\\nStage: builder\\nOutcome: PASS\\nCheck: node result.mjs\\nResult: passed\\nEvidence: proof\\nBlocker: none\\n')
        const r=spawnSync(process.execPath,[fileURLToPath(${JSON.stringify(source('./hkb.mjs'))}),'--tasks',tasks,'done',id],{encoding:'utf8'})
        if(r.status!==0)throw Error(r.stdout+r.stderr)
      }
    },300)
    setTimeout(()=>{},1000)
  `)
  writeFileSync(driver, `
    import assert from 'node:assert/strict'
    import {readFileSync,writeFileSync,existsSync} from 'node:fs'
    import {headless,createHeadless} from ${JSON.stringify(source('./lib/headless.mjs'))}
    import {autoSpawn,reconcileBuilderExits,closeFinished} from ${JSON.stringify(source('./lib/autospawn.mjs'))}
    import {spawnForCard} from ${JSON.stringify(source('./lib/spawn.mjs'))}
    import {agentList,paneRead} from ${JSON.stringify(source('./lib/herdr.mjs'))}
    import {findCard,moveCard} from ${JSON.stringify(source('./lib/cards.mjs'))}
    import {readBindings,liveBindings,unbind} from ${JSON.stringify(source('./lib/bindings.mjs'))}
    import {readWorktrees} from ${JSON.stringify(source('./lib/worktrees.mjs'))}
    import {readWorkflow,updateWorkflow} from ${JSON.stringify(source('./lib/workflow-state.mjs'))}
    import {readDelivery,saveDelivery,promptPath} from ${JSON.stringify(source('./lib/delivery-state.mjs'))}
    import {readUsage,agentSessionId} from ${JSON.stringify(source('./lib/request-usage.mjs'))}
    import {reconcileCompletedHandoffs} from ${JSON.stringify(source('./lib/completed-handoff.mjs'))}
    import {appendHistory} from ${JSON.stringify(source('./lib/card-history.mjs'))}
    const root=${JSON.stringify(root)},repo=${JSON.stringify(repo)},tasksDir=${JSON.stringify(tasks)}
    Object.assign(headless,createHeadless({root:root+'/.agents',command:()=>[process.execPath,${JSON.stringify(fake)}]}))
    const common={project:'Proof',projectPath:repo,tasksDir,boardRoot:${JSON.stringify(import.meta.dirname)},max:1,engine:{kind:'codex',reasoningArgs:['-c','model_reasoning_effort="low"']},model:'gpt-6.1-sol',gitSettings:{worktreesRoot:root+'/worktrees'}}
    const put=id=>writeFileSync(tasksDir+'/queue/'+id+'.md','# '+id+' — proof\\n**Workspace:** app\\n## Files\\n- \\x60result.mjs\\x60 result\\n## Acceptance criteria\\nResult is true\\n')
    const waitDone=async id=>{for(let n=0;n<200;n++){const rows=await agentList('proof'),a=rows.find(a=>a.pane_id===id);if(a?.agent_status==='done'&&a.exitCode!=null)return rows;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out')}
    const turns=async id=>(await paneRead(id)).split('\\n').flatMap(line=>{try{const e=JSON.parse(line);return e.argv?[e]:[]}catch{return []}})
    const start=async id=>{put(id);const started=await autoSpawn({...common,agents:await agentList('proof'),onlyIds:[id]});assert.deepEqual(started,[id]);return readBindings(tasksDir)[id]}
    writeFileSync(root+'/mode','none')
    const first=await start('T-1')
    assert.match(first.pane_id,/^headless-/)
    assert.equal(first.agent_session,'session-'+first.pane_id)
    assert.equal(readWorkflow(tasksDir)['T-1'].builder.pane_id,first.pane_id)
    assert.equal(agentSessionId({agent_session:first.agent_session}),first.agent_session)
    assert(!existsSync(promptPath('proof',first.pane_id)))
    await waitDone(first.pane_id)
    const launch=(await turns(first.pane_id))[0], entry=readWorktrees(tasksDir)['T-1']
    assert.equal(launch.cwd,entry.workspacePath)
    assert.equal(first.workspace_path,entry.workspacePath)
    assert(launch.argv.at(-1).includes('done T-1'))
    assert(!launch.argv.at(-1).includes('.deliveries'))
    assert(launch.argv.includes('gpt-6.1-sol')); assert(launch.argv.includes('model_reasoning_effort="low"'))
    assert.equal(readDelivery('proof',first.pane_id).status,'confirmed')
    assert.equal(readUsage(tasksDir).runs[Object.keys(readUsage(tasksDir).runs)[0]].paneId,first.pane_id)
    assert.equal(readUsage(tasksDir).runs[Object.keys(readUsage(tasksDir).runs)[0]].sessionId,first.agent_session)
    // Identical corrections must produce a new turn in the same session every time.
    for(let n=0;n<2;n++){
      unbind(tasksDir,'T-1')
      moveCard(tasksDir,'T-1','queue')
      updateWorkflow(tasksDir,'T-1',{correction:{category:'implementation',note:'Correct result in the same checkout'}})
      assert.deepEqual(await autoSpawn({...common,agents:await agentList('proof'),onlyIds:['T-1']}),['T-1'])
      assert.equal(readBindings(tasksDir)['T-1'].pane_id,first.pane_id)
      await waitDone(first.pane_id)
      const turn=(await turns(first.pane_id))[n+1]
      assert(turn.argv.includes('resume'));assert(turn.argv.includes(first.agent_session));assert.equal(turn.cwd,entry.workspacePath)
    }
    const before=findCard(tasksDir,'T-1').buildAttempts
    // Restart after spawn acknowledgement, before delivery confirmation was saved.
    saveDelivery('proof',first.pane_id,{...readDelivery('proof',first.pane_id),status:'launching'})
    assert.deepEqual(await reconcileBuilderExits({...common,agents:await agentList('proof')}),[{id:'T-1',to:'planning'}])
    assert.equal(readDelivery('proof',first.pane_id).status,'confirmed')
    assert.equal(findCard(tasksDir,'T-1').buildAttempts,before)
    assert.equal(readBindings(tasksDir)['T-1'],undefined)
    assert.equal(readWorkflow(tasksDir)['T-1'].waitFor,undefined,'tool-output question is not an agent question')
    assert.match(readFileSync(tasksDir+'/.history/T-1.jsonl','utf8'),/builder-no-handoff/)
    assert.equal(existsSync(entry.workspacePath+'/result.mjs'),true)
    assert.equal(Object.keys(liveBindings(tasksDir,await agentList('proof'))).length,0)
    // A real hkb done followed by process exit takes the ordinary integration path.
    writeFileSync(root+'/mode','handoff')
    const second=await start('T-2');let rows=await waitDone(second.pane_id)
    assert.equal(rows.find(a=>a.pane_id===second.pane_id).exitCode,0)
    assert.equal(findCard(tasksDir,'T-2').column,'completed')
    assert.equal(readBindings(tasksDir)['T-2'],undefined)
    assert.deepEqual(await reconcileBuilderExits({...common,agents:rows}),[])
    const result=await reconcileCompletedHandoffs({tasksDir,project:'Proof'})
    assert(result.some(r=>r.id==='T-2'&&r.status==='integrated'),JSON.stringify(result))
    assert(readWorkflow(tasksDir)['T-2'].builderRetired.sessionId)
    // Claude's session_id uses the same launch path.
    writeFileSync(root+'/mode','none');put('T-3');moveCard(tasksDir,'T-3','working')
    const third=await spawnForCard({...common,card:findCard(tasksDir,'T-3'),engine:'claude',model:'claude-sonnet-5'})
    await waitDone(third.pane_id)
    assert.equal(third.agent_session,'session-'+third.pane_id)
    assert((await turns(third.pane_id))[0].argv.includes('--output-format'))
    await assert.rejects(spawnForCard({...common,card:findCard(tasksDir,'T-3'),restrictedBuilder:true}),/restricted dispatch remains disabled/)
    // An interrupted handoff receipt in Working is completed, never a no-handoff.
    writeFileSync(tasksDir+'/.board.json',JSON.stringify({'T-3':third}))
    updateWorkflow(tasksDir,'T-3',{builder:third})
    appendHistory(tasksDir,'T-3',{event:'handoff',stage:'working',outcome:'done'})
    assert.deepEqual(await reconcileBuilderExits({...common,agents:await agentList('proof')}),[{id:'T-3',to:'completed'}])
    // A failed executable launch is a start failure, never an uncertain typed prompt.
    Object.assign(headless,createHeadless({root:root+'/.agents',command:()=>[root+'/missing-agent.exe']}))
    put('T-4')
    writeFileSync(tasksDir+'/queue/T-4.md',readFileSync(tasksDir+'/queue/T-4.md','utf8').replace('result.mjs','other.mjs'))
    assert.deepEqual(await autoSpawn({...common,agents:await agentList('proof'),onlyIds:['T-4']}),[])
    assert.equal(findCard(tasksDir,'T-4').column,'queue')
    assert.equal(readBindings(tasksDir)['T-4'],undefined)
    assert.equal(readWorkflow(tasksDir)['T-4'].startFailure.count,1)
    const failed=JSON.parse(readFileSync(root+'/.agents/registry.json','utf8')).at(-1)
    assert.equal(readDelivery('proof',failed.id).status,'failed')
    console.log('headless Builder flow passed')
  `)
  try {
    const result = await run(process.execPath, [driver], { env: { ...process.env, KANBAN_CONFIG: config, HERDR_BIN_PATH: 'missing-herdr-headless-builder' }, timeout: 45000, windowsHide: true })
    assert.match(result.stdout, /headless Builder flow passed/)
  } finally {
    await new Promise(resolve => setTimeout(resolve, 1500))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
