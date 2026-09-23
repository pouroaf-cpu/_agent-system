import { spawnReviewer } from './lib/autospawn.mjs'
const result=await spawnReviewer({project:'herdr-kanban',projectPath:'C:/Users/PFrew/Projects/herdr-kanban',tasksDir:'C:/Users/PFrew/Projects/herdr-kanban/TASKS',boardRoot:'C:/Users/PFrew/Projects/herdr-kanban',model:'gpt-5.5',engine:{kind:'codex',reasoningArgs:['-c','model_reasoning_effort="medium"']},cardIds:['T-1']})
console.log(JSON.stringify({name:result.name,pane:result.pane_id}))
