// What a spawned agent is actually told.
//
// Prompts reach the agent as keystrokes, not as an API payload, so they stay
// short. The card file is the brief — the prompt only points at it and states
// the one thing the agent must do at the end.

import { resolve } from 'node:path'
import { capabilityBrief } from './review-capabilities.mjs'
import { writeBrief } from './card-history.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { workflowLimits } from './workflow-limits.mjs'
const briefing = (tasksDir, card, role) => {
  if (!tasksDir || !existsSync(card.path)) return card.path.replaceAll('\\', '/')
  const path = writeBrief(tasksDir, card, role, { maxChars: workflowLimits().maxBriefChars })
  return `${path} (revision ${createHash('sha256').update(readFileSync(path)).digest('hex')})`
}

export const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`
const hkb = (boardRoot, tasksDir) => `node ${psLiteral(resolve(boardRoot, 'hkb.mjs'))}${tasksDir ? ` --tasks ${psLiteral(tasksDir)}` : ''}`
const shellRule = `Use the existing PowerShell tool with login:false and the supplied isolated workdir. Put commands directly in cmd: never prefix bare -NoProfile and never wrap them in nested pwsh -Command. Poll a running check's existing session; do not launch a duplicate. Use the check's documented timeout and observed failure; do not invent new timeouts or retry an unchanged failure without diagnosis. Keep full logs in evidence and return a bounded result, not repeated full logs.`

// The kanban manager always holds this herdr agent name, in this session — that
// pair IS its address (see _roles/KANBAN_MANAGER.md). herdr looks names up per
// session, so the --session is not optional for an agent working in another
// project's window.
const BUILDER = 'C:/Users/PFrew/Projects/_roles/BUILDER.md'
const REVIEWER = 'C:/Users/PFrew/Projects/_roles/REVIEWER.md'
const AUDITOR = 'C:/Users/PFrew/Projects/_roles/AUDITOR-CARD-WORKFLOW.md'
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
export function workerPrompt({ card, projectPath, boardRoot, tasksDir, workspacePath: explicitWorkspacePath }) {
  // Absolute paths, not relative: a relative path sends the agent hunting for the
  // file with a glob/search before it can read it, which costs a turn every spawn.
  const cardPath = briefing(tasksDir, card, 'builder')
  const workspacePath = resolve(explicitWorkspacePath || projectPath, explicitWorkspacePath ? '.' : (card.workspace || '.')).replace(/\\/g, '/')
  const cmd = hkb(boardRoot, tasksDir)
  return oneLine(
    `Read ${cardPath}, ${BUILDER}, mandatory project/safety instructions and only applicable required skills. Workspace root: ${workspacePath}; file paths are relative to it. Scope is the exact listed files; missing essential scope requires a specific proposed deviation and operator clarification, not self-approved widening or automatic planning restart.`,
    `Do not run repository-wide searches when the card supplies exact files or selectors.`,
    shellRule,
    `For this assigned workspace use workdir=${psLiteral(workspacePath)}. Read the briefing with Get-Content -LiteralPath ${psLiteral(cardPath.replace(/ \(revision [a-f0-9]{64}\)$/, ''))}. Follow known functions/selectors and bounded source ranges; expand a named range only when required context is missing. Mandatory instructions must still be read completely.`,
    `do not deploy, write production data, purchase anything or send external messages unless this card explicitly authorizes it.`,
    `If you find other problems, compare against the base and record source/evidence/classification. Confirmed unrelated pre-existing findings alone do not require planning or block a completed in-scope change from Review; do not fix them. In-scope, change-caused, unsafe or acceptance-blocking defects still block. Never silently exempt an agreed check.`,
    `Make the change using one ${card.trivial ? 'deterministic' : 'proportional'} check type. Rerun the same check after fixing implementation, setup, or harness errors. Stop after three identical unresolved failures and report the precise evidence via issue; a changed failure after a concrete correction is progress. Browser checks are allowed only when explicitly required by the card. Do not create screenshots unless required.`,
    `Only if the check passes and that workspace is Git-backed, stage only the exact implementation files/paths that changed with git -C ${psLiteral(workspacePath)} add -- <approved-paths>; inspect git -C ${psLiteral(workspacePath)} diff --cached --name-only; then git -C ${psLiteral(workspacePath)} commit -m ${psLiteral(`${card.id} concise title`)}. Replace <approved-paths> with individually quoted actual approved paths, never a wildcard or git add . . Never push. Non-Git work needs no commit. If the check fails, the staged set is ambiguous, or the commit fails, leave the work uncommitted and use issue or owner.`,
    `Before declaring the build complete, verify every named prerequisite file, route, selector, dependency and check from the card and plan in the assigned workspace. A missing or unverified prerequisite is a blocker; record the exact path/route, command and observed result instead of assuming it exists. Record a short structured result in the authoritative card's Implementation and Evidence sections using Stage: builder, Outcome: PASS or BLOCKED, Files: exact paths, Check: command, Result: observed result, Evidence: file/link, Blocker: none or exact blocker. Version-2 done validates these fields. Keep full logs in evidence files; history is appended by the board. Do not rewrite the generated briefing or update journals or ACTIVE registers.`,
    `When you are finished, run exactly one of these:`,
    `${cmd} unchanged ${card.id} "passing check and observed result" if the requested implementation was already present and the passing check confirms it; this validates a clean unchanged worktree against integration, so never fabricate an empty commit;`,
    `${cmd} done ${card.id} if it is done;`,
    `${cmd} issue ${card.id} "[planning|implementation|operational|evidence] specific unmet criterion or prerequisite and evidence" for a failure; select exactly one category. Planning corrects scope; implementation returns to your Builder session; operational/evidence holds the current stage without restarting product work.`,
    `${cmd} owner ${card.id} "Only the operator can grant <access/permission>; verified <failure>; approved methods exhausted; Evidence: <exact check/result>; <specific ask>" for access only the human can supply. Technical failures and missing evidence use issue; the board enforces the fifth failed-return stop.`,
    `For nontrivial code cards, done enters Review and only an independent Reviewer PASS can make the card Completed; explicitly trivial cards may enter Completed after their focused check. Run one of them even if you failed: that command is how the board learns you are done. Commit before done. After the handoff succeeds, stop immediately; do not inspect the board or do more work.`
  )
}

export function reviewerPrompt({ cards, projectPath, boardRoot, tasksDir, reviewClaim, reviewRoot = boardRoot, reportOnly = false, envFile }) {
  const cmd = hkb(boardRoot, tasksDir) + (reviewClaim ? ` --review-root ${psLiteral(reviewRoot)} --review-claim ${psLiteral(reviewClaim)}` : '')
  const workspaceRule = reportOnly ? 'Non-Git workspace: inspection/report only. Do not run builds, install dependencies or mutate this shared directory; return any required isolated-build prerequisite to Planner.' : 'Use only this isolated checkout for builds; preserve its snapshot and evidence after handoff.'
  const list = cards
    .map((c) => `${c.id} (${briefing(tasksDir, c, 'reviewer')})`)
    .join(', ')
  if (cards.every((c) => c.audit)) return oneLine(
    `Audit these cards: ${list}.`,
    `Your assigned snapshot workspace is ${projectPath}. Own only the listed cards. Use a free dedicated local port; never kill shared servers, edit product source, reset account data or run builds in another checkout.`,
    workspaceRule,
    shellRule,
    ...(envFile ? [`Approved project dev environment: ${envFile}. For a local Next check, run node --env-file="${envFile}" node_modules/next/dist/bin/next dev -p <free-card-port> from this isolated snapshot. Do not copy or print environment values; the npm dev wrapper may ignore port arguments. Open localhost (not a different host) for the existing Person 1 authenticated session, /account/ first. Missing injected env is setup recovery, not a request for new credentials.`] : []),
    capabilityBrief(cards),
    `Read only ${AUDITOR}, those card files, and the exact targets they list. Use only the required tools/MCPs named on each card.`,
    `Do not edit implementation files, create remediation cards, push, deploy, or claim CLEAR without every evidence gate.`,
    `For each card replace its Evidence, Findings, and Audit conclusion comments. Record CLEAR, FINDINGS, or INCOMPLETE; missing tooling or evidence is INCOMPLETE, never CLEAR.`,
    `Then run ${cmd} audit <ID> "<status>". FINDINGS goes to the responsible Planner for validation/deduplicated linked fixes; CLEAR with evidence closes; INCOMPLETE goes to technical recovery. Explicit Audit disposition: report-only-await-owner opts completed findings into Owner.`,
    `After the final handoff succeeds, stop immediately.`
  )
  return oneLine(
    `Review these finished tasks: ${list}.`,
    `Your assigned snapshot workspace is ${projectPath}. Own only the listed cards, with a separate verdict for each. Use a free dedicated local port; never kill shared servers, edit product source, reset account data or run builds in another checkout. Do not install through a shared dependency junction.`,
    workspaceRule,
    shellRule,
    ...(envFile ? [`Approved project dev environment: ${envFile}. For a local Next check, run node --env-file="${envFile}" node_modules/next/dist/bin/next dev -p <free-card-port> from this isolated snapshot. Do not copy or print environment values; the npm dev wrapper may ignore port arguments. Use localhost for the existing Person 1 authenticated session, /account/ first. Missing injected env is setup recovery, not a request for new credentials.`] : []),
    capabilityBrief(cards),
    `Read ${REVIEWER}, those focused briefings, mandatory project/safety instructions and only relevant required skills. Independently inspect actual changed files and map every acceptance criterion to evidence, including a check that fails when the required behaviour is absent.`,
    `Do not run repository-wide searches when a card supplies exact files or selectors. Do not edit implementation code, push or deploy.`,
    `Verify incidental findings against the base and agreed scope. Preserve confirmed unrelated pre-existing findings alongside the verdict; do not demand scope expansion solely for them. In-scope, change-caused, unsafe or acceptance-blocking defects still require rework.`,
    `Check each card's Evidence and run its exact current check command in the assigned workdir with login:false, using one proportional check type. Prefer the named callable MCP/CLI tools; Chrome navigation, keyboard and visual/screenshot checks are allowed when relevant to acceptance. Read only relevant skills explicitly referenced by the card. Preflight tool availability, correct project/target and approved isolated auth; never skip required checks or claim PASS from automation alone when visual/keyboard evidence is required.`,
    `Append a fresh Reviewer evidence section after the latest attempt/feedback, with a non-empty per-criterion result and explicit "**Review verdict:** PASS, FAIL or UNKNOWN". Link full logs in history/evidence files. All product cards require evidenced independent review.`,
    `After recording evidenced PASS, use the exact command for that card: ${cards.map(c => `${cmd} pass ${c.id}`).join(' ; ')}. Run only the command matching its verdict.`,
    `For a failed card use its command: ${cards.map(c => `${cmd} rework ${c.id} '[implementation|planning|operational|evidence] exact unmet criterion and evidence'`).join(' ; ')}. Replace feedback and choose one category; quote literal feedback with PowerShell single quotes and double any embedded apostrophe. Do not wrap the whole command in quotes.`,
    `Prefix feedback with [implementation], [planning], [operational] or [evidence]. Only planning errors return to Planner; implementation errors return to the responsible Builder. Operational and missing evidence remain at the pending stage.`,
    `You may append only the current Reviewer evidence and Review verdict to the canonical card path named in its briefing. Do not manually change status, counters or workflow metadata, move cards, or edit implementation; use the exact handoff commands above for transitions. Do not inspect board source to discover commands.`,
    `Write feedback a fresh agent with no memory of this card can act on: name the criterion, say what is wrong, say what would satisfy it.`,
    `Missing evidence, failed setup or UNKNOWN require an exact missing check and responsible stage; never assume PASS or request an unchanged rebuild.`,
    `Immediate owner requires verified missing permission/access: name what only the operator can grant, approved methods exhausted, and Evidence: exact check/result. Transient errors are rework.`,
    `Only for that verified human-only blocker use its command: ${cards.map(c => `${cmd} owner ${c.id} 'Only the operator can grant permission; approved methods exhausted; Evidence: exact failure; specific ask'`).join(' ; ')}. Replace the literal evidence/ask, never invent access failure.`,
    `Review every card in the list. After the final hkb command succeeds, stop immediately; do not inspect the board or do more work.`
  )
}

// One sweeper for every card sitting in Issues, same batching reasoning as the
// reviewer. Mirrors the KANBAN_MANAGER.md "Issues sweep" policy — keep the two in sync.
export function issuesSweeperPrompt({ cards, projectPath, boardRoot, tasksDir, manager = false, plannerAssignment }) {
  const cmd = hkb(boardRoot, tasksDir) + (plannerAssignment ? ` --planner-assignment ${plannerAssignment}` : '')
  const list = cards
    .map((c) => `${c.id} [${c.category || 'code'}] [${c.column}] (${briefing(tasksDir, c, 'planner')})`)
    .join(', ')
  const overlays = [...new Set(cards.map((c) => PLANNER_OVERLAYS[c.category || 'code'] || PLANNER_OVERLAYS.code))]
  return oneLine(
    cards.length ? `Plan these approved cards: ${list}.` : `No cards to plan.`,
    shellRule,
    `Read ${PLANNER}, ${overlays.join(', ')}, the focused briefings, mandatory project/safety instructions and source needed to plan. Load only applicable required skills. Verify every named prerequisite file, route, selector, dependency and check exists in the stated workspace before calling the plan build-ready; record the exact path/route and observed result, or mark the plan investigation/blocked when it cannot be verified. Map each agreed outcome under Outcome checks to its exact change and an acceptance check which would fail if the behaviour were absent. State exact workspace prerequisites and commands. Update only the authoritative card's current sections; full investigation logs belong in linked evidence, not the briefing.`,
    `Planning owns missing/incorrect scope and executable plan details. Builder owns execution, quoting and implementation mistakes; operational recovery owns environment/transport/worktree failures without restarting product planning. Do not accept an unrelated finding as an automatic planning return. Reuse relevant prior evidence and a changed diagnosis, never identical retry. The fifth distinct failed return stops in Owner automatically; do not reset recovery metadata. Immediate Owner requires verified missing permission/access after approved methods are exhausted, with exact evidence and human ask.`,
    `For verified missing permission/access only, run ${cmd} owner <ID> "Only the operator can grant <permission/access>; verified <failure>; approved methods exhausted; Evidence: <exact check/result>; <specific ask>" and stop.`,
    `For FINDINGS audits, validate current findings and deduplicate existing cards; create/update only missing approved remediation cards with scoped independent review. Number findings and map every one under ## Remediation links as - F1: <existing fix card ID>, preserving evidence. Archive the report once all findings are linked; linked fixes are not thereby complete. Respect explicit report-only-await-owner and do not expand business/data/deployment scope. For INCOMPLETE audits repair the evidence plan and prerequisite before returning to Review; never queue an audit itself for implementation. Otherwise run exactly one ${cmd} move <ID> planned command for this card, even when planning fails use one ${cmd} issue <ID> "[planning] precise unmet prerequisite and evidence" command. Do not leave the card in Planning without a handoff, retry a stopped Planner into ambiguity, or issue multiple handoffs. After the handoff succeeds, stop that card immediately.`
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

// Role-prefixed names (b-i149, r-hk14) are how the board recognises a pane it
// spawned, so it only ever closes its own and never one you opened by hand.
export { agentName, isBoardAgent } from './ids.mjs'
