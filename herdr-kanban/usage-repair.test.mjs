import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {recordUsageStart,reconcileUsage,usageSummary,mergeUsageSummaries} from './lib/request-usage.mjs'
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
test('task project and category use explicit choices and group Kanban consistently',()=>{
 const tasks=parseManagerTasks('### REQ-20260911-025 - Fix token usage\nProject: Kanban\nCategory: Usage & Costs\nStatus: working\n')
 assert.equal(tasks[0].project,'Orchestration and Tools');assert.equal(tasks[0].category,'Usage & Costs')
})
