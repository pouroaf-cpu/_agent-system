import { mkdirSync, writeFileSync } from 'node:fs'
import { createCard } from './lib/cards.mjs'
import { agentWorkspaceOr } from './lib/herdr.mjs'
const path = 'C:/Users/PFrew/Projects/CardUsageProof'
mkdirSync(path + '/ROLES', { recursive: true })
writeFileSync(path + '/ROLES/PLANNER.md', 'Plan only the approved disposable proof. No delegation or broad audits. Include Files, acceptance criteria and a single check. Move the card to Planned with hkb. Do not build. Stop once planned.\n')
const card = createCard(path + '/TASKS', { title: 'Disposable card lifecycle proof', mission: 'CARD-USAGE-PROOF', brief: 'This is an authorized disposable workflow test, not product work. Builder: create proof.txt containing exactly card workflow verified followed by a newline. Files: proof.txt only, plus evidence in this card. Verify the exact file content with one assertion. Reviewer independently reads the file and runs the assertion; append Reviewer evidence and PASS if correct, then hkb pass. No web browser checks are relevant to this text-only fixture. No other projects, credentials, deployments, delegation or Manager prompts. Planner write a minimal plan, then hkb move to planned. Keep replies under 100 words.' })
writeFileSync('card-proof.config.json', JSON.stringify({port:7791,mode:'manager',projectsRoot:'C:/Users/PFrew/Projects',projects:['CardUsageProof'],maxConcurrentAgents:1,agentPollMs:3000,leadPlanner:{autoIssues:true},models:{planning:'gpt-5.5',working:'gpt-5.5',review:'gpt-5.5'},engine:{kind:'codex',reasoningArgs:['-c','model_reasoning_effort="low"']},mission:{id:'CARD-USAGE-PROOF',project:'CardUsageProof',maxBuilds:2,maxBuildsPerCard:2}},null,2))
await agentWorkspaceOr(path, 'cardusageproof')
console.log(card.id)
