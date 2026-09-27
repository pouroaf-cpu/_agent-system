import assert from 'node:assert/strict'
import { plannerPrompt } from './lib/prompt.mjs'
const prompt = plannerPrompt({cards:[{id:'T-99',column:'planning',path:'C:/project/TASKS/planning/T-99.md'}],projectPath:'C:/project',boardRoot:'C:/board'})
assert.ok(prompt.includes('Projects/_roles/PLANNER.md'))
assert.ok(!prompt.includes('ORCHESTRATION.md'))
assert.ok(!prompt.includes('Grill Me'))
assert.ok(prompt.includes('After each successful handoff'))
console.log('PASS: Planner gets its role guide, no repeat intake, and stops after handoff')
