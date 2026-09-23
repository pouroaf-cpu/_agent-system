// Explicit maintenance action; never an automatic retry.
import { resumeStagedCardRunEnter } from './lib/card-run.mjs'
const [project, sourceRunId, requestId] = process.argv.slice(2)
console.log(await resumeStagedCardRunEnter(project, sourceRunId, 'reviewer', { requestId }))
