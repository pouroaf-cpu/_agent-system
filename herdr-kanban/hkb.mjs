#!/usr/bin/env node
// hkb — the one command a working agent runs to report back.
//
//   node hkb.mjs done  T-02
//   node hkb.mjs issue T-02 "acceptance criterion 3 fails at 390px"
//   node hkb.mjs owner T-02 "needs the Supabase service key, which I must not read"
//   node hkb.mjs park  T-02 "needs your bank details — no agent can supply them"
//   node hkb.mjs pass  T-02
//   node hkb.mjs move  T-02 review
//
// Run it from the project root. Moving the card IS the report; there is no
// separate status to update and nothing to keep in sync.
//
// issue vs owner: `issue` is a technical problem another agent could pick up.
// `owner` is a decision, credential, asset or judgement call only the human can
// supply — no amount of agent effort will resolve it.

import { existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { moveCard, columnByKey, findCard, canArchive, dirtySnapshotForCard, appendDirtySnapshot } from './lib/cards.mjs'
import { unbind, readBindings } from './lib/bindings.mjs'

const [verb, cardId, ...rest] = process.argv.slice(2)
const note = rest.join(' ').trim()

const VERBS = { done: 'completed', issue: 'issues', owner: 'owner', park: 'owner', review: 'review', rework: 'issues', pass: 'archive', move: null }

// What gets stamped above the note, and what the board reads back out.
const HEADING = { issue: 'Kicked back', owner: 'Needs you', park: 'Parked', rework: 'Review feedback' }

// Builder -> review -> rework -> builder is a loop. After this many rounds the
// card stops going round and goes to the operator, because a third failed review
// means the card is wrong, not the work.
const MAX_REVIEW_ROUNDS = 3

function fail(msg) {
  console.error(`hkb: ${msg}`)
  process.exit(1)
}

if (!verb || !(verb in VERBS)) {
  fail(`usage: hkb <done|issue|owner|park|review|rework|pass|move> <card-id> [note|column]\n       got: ${verb ?? '(nothing)'}`)
}
if (!cardId) fail('missing card id, e.g. T-02')

const tasksDir = join(process.cwd(), 'TASKS')
if (!existsSync(tasksDir)) fail(`no TASKS folder in ${process.cwd()} — run this from the project root`)

let target = verb === 'move' ? note.toLowerCase() : VERBS[verb]
if (!target) fail('move needs a target column, e.g. hkb move T-02 review')
if (!columnByKey(target)) fail(`unknown column: ${target}`)

// The cap is enforced here rather than in the reviewer's prompt, because a
// prompt is advice and this has to hold even when the reviewer ignores it.
let capped = false
if (verb === 'rework') {
  const rounds = findCard(join(process.cwd(), 'TASKS'), cardId).reviewRounds
  if (rounds + 1 >= MAX_REVIEW_ROUNDS) {
    target = 'owner'
    capped = true
  }
}

// A handover with no explanation is not a report. Whoever picks the card up next
// — another agent, or the operator staring at it cold — needs to know why.
if (verb === 'issue' && !note) fail('issue needs a reason: hkb issue T-02 "what went wrong"')
if (verb === 'owner' && !note) fail('owner needs to say what you need: hkb owner T-02 "what only the operator can supply"')
// park = owner, but the auto-manager sweep skips it from now on. For cards no
// amount of agent effort can resolve, so re-reading them every 15 minutes is waste.
if (verb === 'park' && !note) fail('park needs to say why no agent can resolve it: hkb park T-02 "needs your bank details"')
if (verb === 'rework' && !note) fail('rework needs feedback the builder can act on: hkb rework T-02 "criterion 2 fails: ..."')
let card
try {
  let dirtySnapshot = null
  if (verb === 'issue') {
    const current = findCard(tasksDir, cardId)
    if (current.cardOwned) dirtySnapshot = dirtySnapshotForCard(current, process.cwd(), { listedOnly: true })
  }
  if (verb === 'pass') {
    const current = findCard(tasksDir, cardId)
    if (current.column !== 'review') fail('pass only closes a card from Review')
    if (!canArchive(current)) fail('pass needs current nonempty Reviewer evidence and latest Review verdict: PASS already recorded')
  }
  card = moveCard(tasksDir, cardId, target)
  appendDirtySnapshot(card, dirtySnapshot)
} catch (err) {
  fail(err.message)
}

if (HEADING[verb]) {
  const tail = capped
    ? `\n\nThis is review round ${MAX_REVIEW_ROUNDS}. Sent to the operator rather than back to a builder — ` +
      `three failed reviews means the card is wrong, not the work.\n`
    : '\n'
  appendFileSync(card.path, `\n\n---\n\n**${HEADING[verb]}** ${new Date().toISOString()}\n\n${note}\n${tail}`)
}

const binding = readBindings(tasksDir)[card.id]
unbind(tasksDir, card.id)

console.log(`${card.id} -> ${target}${capped ? ' (review cap reached)' : ''}` +
  `${binding?.pane_id ? ` (freed ${binding.pane_id})` : ''}`)
