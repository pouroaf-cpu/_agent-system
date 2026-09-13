// What a spawned agent is actually told.
//
// Prompts reach the agent as keystrokes, not as an API payload, so they stay
// short. The card file is the brief — the prompt only points at it and states
// the one thing the agent must do at the end.

import { resolve } from 'node:path'

const hkb = (projectPath, boardRoot) => `node "${boardRoot}/hkb.mjs"`

// The kanban manager always holds this herdr agent name, in this session — that
// pair IS its address (see _roles/KANBAN_MANAGER.md). herdr looks names up per
// session, so the --session is not optional for an agent working in another
// project's window.
const BUILDER = 'C:/Users/PFrew/Projects/_roles/BUILDER.md'
const REVIEWER = 'C:/Users/PFrew/Projects/_roles/REVIEWER.md'
const AUDITOR = 'C:/Users/PFrew/Projects/_roles/AUDITOR.md'
const PLANNER = 'C:/Users/PFrew/Projects/_roles/PLANNER.md'
const PLANNER_OVERLAYS = {
  ui: 'C:/Users/PFrew/Projects/_roles/PLANNER-UI.md',
  code: 'C:/Users/PFrew/Projects/_roles/PLANNER-CODE.md',
  'auth-security': 'C:/Users/PFrew/Projects/_roles/PLANNER-AUTH-SECURITY.md',
  data: 'C:/Users/PFrew/Projects/_roles/PLANNER-DATA.md',
}

// Collapse to one line and strip any stray newline: a newline in a prompt is a
// submit keypress, not whitespace.
const oneLine = (...parts) => parts.join(' ').replace(/\s+/g, ' ').trim()

// SINGLE LINE, always. Prompts are delivered as keystrokes into a TUI, where a
// newline is the submit key — a multi-line prompt submits on its first blank line
// and leaves the rest sitting unsent in the input box.
export function workerPrompt({ card, projectPath, boardRoot }) {
  // Absolute paths, not relative: a relative path sends the agent hunting for the
  // file with a glob/search before it can read it, which costs a turn every spawn.
  const cardPath = card.path.replace(/\\/g, '/')
  const workspacePath = resolve(projectPath, card.workspace || '.').replace(/\\/g, '/')
  const cmd = hkb(projectPath, boardRoot)
  return oneLine(
    `Read only ${cardPath}, ${BUILDER}, and the exact files listed in the card. Workspace root: ${workspacePath}; file paths are relative to it. Do not read other instructions or broad design documents.`,
    `Do not run repository-wide searches when the card supplies exact files or selectors.`,
    `do not deploy, write production data, purchase anything or send external messages unless this card explicitly authorizes it.`,
    `if you find other problems, note them in the card rather than fixing them.`,
    `Make the change and run exactly one ${card.trivial ? 'deterministic' : 'proportional'} check; the check is consumed only once the intended command's target process starts. If PowerShell profile noise, shell transport, or quoting prevents that target process from starting, you may make exactly one corrected retry of the same intended command. Do not substitute a different check, and once the target process starts any failed test, assertion, or process result consumes the check and must be reported without retrying another check. Do not run browser tests or create screenshots. If invoking PowerShell, use pwsh -NoProfile.`,
    `Only if the check passes and that workspace is Git-backed, use git -C ${workspacePath} to stage only the exact implementation files listed in the card, verify the staged file names, and create one local commit named "${card.id} concise title". Never push. Non-Git work needs no commit. If the check fails, the staged set is ambiguous, or the commit fails, leave the work uncommitted and use issue or owner.`,
    `Record the change and check result briefly in the card's existing Implementation and Evidence sections. Do not update journals or ACTIVE registers.`,
    `When you are finished, run exactly one of these from the project root:`,
    `${cmd} done ${card.id} if it is done;`,
    `${cmd} issue ${card.id} "what blocked you or which acceptance criterion fails" if you hit a technical problem another agent could pick up;`,
    `${cmd} owner ${card.id} "what you need from me" if it needs a decision, credential, asset or judgement call only the human can supply — say plainly what you need and why, in one or two sentences, because that text is all the operator will see.`,
    `Run one of them even if you failed: that command is how the board learns you are done. Commit before done. After the handoff succeeds, stop immediately; do not inspect the board or do more work.`
  )
}

export function reviewerPrompt({ cards, projectPath, boardRoot }) {
  const cmd = hkb(projectPath, boardRoot)
  const list = cards
    .map((c) => `${c.id} (${c.path.replace(/\\/g, '/')})`)
    .join(', ')
  if (cards.every((c) => c.audit)) return oneLine(
    `Audit these cards: ${list}.`,
    `Read only ${AUDITOR}, those card files, and the exact targets they list. Use only the required tools/MCPs named on each card.`,
    `Do not edit implementation files, create remediation cards, push, deploy, or claim CLEAR without every evidence gate.`,
    `For each card replace its Evidence, Findings, and Audit conclusion comments. Record CLEAR, FINDINGS, or INCOMPLETE; missing tooling or evidence is INCOMPLETE, never CLEAR.`,
    `Then run ${cmd} owner <ID> "Audit report ready: <status> — <finding count or missing evidence>" for each card.`,
    `After the final handoff succeeds, stop immediately.`
  )
  return oneLine(
    `Review these finished tasks: ${list}.`,
    `Read only ${REVIEWER}, those card files, and the exact files each card lists. Do not read other instructions or broad design documents.`,
    `Do not run repository-wide searches when a card supplies exact files or selectors. Do not edit implementation code, push or deploy.`,
    `Check each card's Evidence and run exactly one proportional check. Do not run browser tests or create or inspect screenshots. If invoking PowerShell, use pwsh -NoProfile.`,
    `Append a non-empty "## Reviewer evidence" section and an explicit latest "**Review verdict:** PASS" before passing a mission card.`,
    `For each card run "${cmd} pass <ID>" if every criterion is met and your current reviewer evidence plus PASS verdict is already recorded.`,
    `If you are not satisfied it is complete, run "${cmd} rework <ID> \\"which criterion fails and what specifically to do about it\\"" —`,
    `that writes your reason into the card file as a "**Review feedback**" section and puts the card in Error for planner correction, in one step;`,
    `do not edit the card by hand or move it yourself.`,
    `Write feedback a fresh agent with no memory of this card can act on: name the criterion, say what is wrong, say what would satisfy it.`,
    `If you cannot decide — the criterion is ambiguous, the evidence is arguable, or passing it would need a call that is not yours to make —`,
    `do not guess in either direction: run "${cmd} owner <ID> \\"what you need confirmed and the two readings you are stuck between\\"".`,
    `That is how you reach the kanban manager, who answers it if the evidence settles it and parks it for the operator if it does not.`,
    `Review every card in the list. After the final hkb command succeeds, stop immediately; do not inspect the board or do more work.`
  )
}

// One sweeper for every card sitting in Issues, same batching reasoning as the
// reviewer. Mirrors the KANBAN_MANAGER.md "Issues sweep" policy — keep the two in sync.
export function issuesSweeperPrompt({ cards, projectPath, boardRoot, manager = false }) {
  const cmd = hkb(projectPath, boardRoot)
  const list = cards
    .map((c) => `${c.id} [${c.category || 'code'}] [${c.column}] (${c.path.replace(/\\/g, '/')})`)
    .join(', ')
  const overlays = [...new Set(cards.map((c) => PLANNER_OVERLAYS[c.category || 'code'] || PLANNER_OVERLAYS.code))]
  return oneLine(
    cards.length ? `Plan these approved cards: ${list}.` : `No cards to plan.`,
    `Read only ${PLANNER}, ${overlays.join(', ')}, the listed card files, and source needed to plan them.`,
    `If the card is genuinely missing a user-only decision, credential, asset or judgement, run "${cmd} owner <ID> \\"what only the operator can supply\\"" and stop that card.`,
    `Otherwise run ${cmd} move <ID> planned. After each successful handoff, stop that card immediately. Plan every listed card, then stop.`
  )
}

// herdr pane labels are short; keep them scannable in the tab strip.
//
// The role leads because herdr's own sidebar prefixes every agent with the
// workspace label, which is the same for all of them — the tab label is the only
// place a builder can be told apart from the reviewer at a glance.
// The card id leads, not the role: herdr truncates the tail, and in a strip of tabs
// that all begin "builder " the id is the only part that tells them apart. The role
// still appears, just after the thing you are actually looking for. A card holding
// others up says so — that is what decides which tab you open first.
export const paneLabel = (card, holdsUp = 0) =>
  `${card.id}${holdsUp ? ` ⛔${holdsUp}` : ''} · ${card.title}`.slice(0, 48)

export const reviewLabel = (count) => `reviewer ${count} card${count === 1 ? '' : 's'}`

export const sweepLabel = (count) => `Lead Planner ${count} card${count === 1 ? '' : 's'}`

// The `kb-` prefix is load-bearing: it is how the board recognises a pane it
// spawned, so it only ever closes its own and never one you opened by hand.
//
// The pane id is part of the name because herdr keeps a name→terminal binding:
// reusing a name whose old pane has closed fails with agent_name_not_found, so a
// card that is retried must not ask for the same name twice.
// herdr enforces: lowercase letters, digits, - or _, starting with a letter,
// 1-32 characters. The pane suffix is the part that must survive truncation, so
// the project name is trimmed rather than the tail.
export function agentName(card, project, paneId = '') {
  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const head = `kb-${clean(card.id)}`
  const tail = paneId ? `-${clean(paneId)}` : ''
  const room = 32 - head.length - tail.length - 1
  const proj = room > 0 ? `-${clean(project).slice(0, room)}` : ''
  return `${head}${proj}${tail}`.replace(/-+$/, '').slice(0, 32)
}

export const isBoardAgent = (agent) => (agent?.name || '').startsWith('kb-')
