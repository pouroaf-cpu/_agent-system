import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {recordUsageStart,recordUsageFinish,reconcileUsage,readUsage,usageSummary,mergeUsageSummaries} from './lib/request-usage.mjs'
import {agentStartArgs} from './lib/herdr.mjs'
import {parseManagerTasks} from './lib/manager-tasks.mjs'
test('late HERDR identity recovers initial zero, final totals and deduplicates double starts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'usage-identity-'))
 try {
  const at=new Date('2026-09-11T00:00:00Z')
  for(let i=0;i<2;i++) recordUsageStart({tasksDir:dir,requestId:'REQ-20260911-025',role:'builder',name:'builder',now:new Date(+at+i),root:dir})
  const rows=[{type:'session_meta',timestamp:'2026-09-11T00:00:01Z',payload:{}},{type:'response_item',timestamp:'2026-09-11T00:00:02Z',payload:{role:'user'}},{type:'turn_context',timestamp:'2026-09-11T00:00:03Z',payload:{model:'gpt-5.5'}},{type:'event_msg',timestamp:'2026-09-11T00:00:04Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20,total_tokens:120}}}},{type:'event_msg',timestamp:'2026-09-11T00:00:05Z',payload:{type:'task_complete'}}]
  writeFileSync(join(dir,'rollout-real-id.jsonl'),rows.map(JSON.stringify).join('\n'))
  const agents=[{name:'builder',pane_id:'w1:p1',agent_session:{agent:'codex',value:'real-id'}}]
  reconcileUsage(dir,agents,{root:dir});reconcileUsage(dir,agents,{root:dir})
  const summary=usageSummary(dir,{root:dir})[0];assert.equal(summary.runs,1);assert.equal(summary.tokens.total,120);assert.equal(summary.tokens.uncachedInput,40)
  assert.equal(mergeUsageSummaries([summary,summary])[summary.requestId].tokens.total,120)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('Claude runs learn their session from the agent list and read usage from the Claude transcript',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'usage-claude-'))
 try {
  const id='c1a0de00-0000-4000-8000-000000000001'
  const run=recordUsageStart({tasksDir:dir,requestId:'I191',cardIds:['I191'],role:'builder',paneId:'wG:pKK@default',name:'b-i191',now:new Date('2026-09-26T00:00:00Z'),root:dir})
  assert.equal(run.sessionId,null)
  const u=(input,created,read,output,extra={})=>({input_tokens:input,cache_creation_input_tokens:created,cache_read_input_tokens:read,output_tokens:output,...extra})
  const rows=[{type:'mode'},
   {type:'assistant',timestamp:'2026-09-25T23:59:00Z',message:{id:'before',usage:u(1000,0,0,1000)}},
   {type:'user',timestamp:'2026-09-26T00:00:05Z',message:{role:'user',content:'build'}},
   {type:'assistant',timestamp:'2026-09-26T00:00:06Z',message:{id:'m1',usage:u(10,100,0,5)}},
   {type:'assistant',timestamp:'2026-09-26T00:00:07Z',message:{id:'m1',usage:u(10,100,0,20,{output_tokens_details:{thinking_tokens:8}})}},
   {type:'user',timestamp:'2026-09-26T00:00:08Z',toolUseResult:{},message:{role:'user',content:[{type:'tool_result'}]}},
   {type:'assistant',timestamp:'2026-09-26T00:00:09Z',message:{id:'m2',usage:u(3,0,110,7)}}]
  mkdirSync(join(dir,'x'));writeFileSync(join(dir,'x',`${id}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n')+'\n')
  const agent={name:'b-i191',pane_id:'wG:pKK',agent_session:{agent:'claude',kind:'id',source:'herdr:claude',value:id}}
  reconcileUsage(dir,[agent],{root:dir})
  assert.equal(Object.values(readUsage(dir).runs)[0].sessionId,id)
  const done=await recordUsageFinish({tasksDir:dir,paneId:'wG:pKK@default',agent,status:'complete',now:new Date('2026-09-26T00:01:00Z'),root:dir})
  assert.equal(done.status,'complete')
  // m1 counts once (its last chunk), cache reads are cached input, usage before the run is excluded.
  assert.deepEqual(done.delta,{input:223,cachedInput:110,uncachedInput:113,output:27,reasoningOutput:8,total:250})
  assert.equal(usageSummary(dir,{root:dir})[0].tokens.total,250)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('a finished Claude run never takes a later agent session that reuses its name',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'usage-claude-old-'))
 try {
  const id='c1a0de00-0000-4000-8000-000000000002'
  const old=recordUsageStart({tasksDir:dir,requestId:'I191',cardIds:['I191'],role:'builder',paneId:'wG:pAA@default',name:'b-i191',now:new Date('2026-09-26T00:00:00Z'),root:dir})
  await recordUsageFinish({tasksDir:dir,runId:old.runId,status:'complete',root:dir})
  mkdirSync(join(dir,'x'));writeFileSync(join(dir,'x',`${id}.jsonl`),JSON.stringify({type:'assistant',timestamp:'2026-09-26T01:00:00Z',message:{id:'m1',usage:{input_tokens:5,output_tokens:5}}})+'\n')
  reconcileUsage(dir,[{name:'b-i191',pane_id:'wG:pKK',agent_session:{agent:'claude',source:'herdr:claude',value:id}}],{root:dir})
  assert.equal(readUsage(dir).runs[old.runId].sessionId,null)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('Claude agents save their transcript even when launched from inside another Claude session',()=>{
 const args=agentStartArgs({name:'kb-t-999-test',paneId:'p',model:'claude-sonnet-5',engine:'claude'})
 const file=args[args.indexOf('--settings')+1]
 assert.equal(JSON.parse(readFileSync(file,'utf8')).env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE,'1')
 assert.ok(!/\s/.test(file),'the path reaches the pane shell unquoted')
})
test('task project and category use explicit choices and group Kanban consistently',()=>{
 const tasks=parseManagerTasks('### REQ-20260911-025 - Fix token usage\nProject: Kanban\nCategory: Usage & Costs\nStatus: working\n')
 assert.equal(tasks[0].project,'Orchestration and Tools');assert.equal(tasks[0].category,'Usage & Costs')
})
