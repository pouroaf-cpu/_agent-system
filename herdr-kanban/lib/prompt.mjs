// What a spawned agent is actually told.
//
// Prompts reach the agent as keystrokes, not as an API payload. deliver() types
// only a short pointer to a file holding this text. The card file is the brief —
// the prompt points at it and states the one thing the agent must do at the end.

import { resolve } from 'node:path'
import { capabilityBrief } from './review-capabilities.mjs'
import { writeBrief } from './card-history.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { workflowLimits } from './workflow-limits.mjs'
import { engineKind } from './quota.mjs'
const briefing = (tasksDir, card, role, handover = '') => {
  if (!tasksDir || !existsSync(card.path)) return card.path.replaceAll('\\', '/')
  const path = writeBrief(tasksDir, card, role, { maxChars: workflowLimits().maxBriefChars, handover })
  return `${path} (revision ${createHash('sha256').update(readFileSync(path)).digest('hex')})`
}

export const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`
// Operator decision 2026-10-10: cards stalled asking to touch test-account data.
export const TEST_DATA_RULE = "Operator decision 2026-10-10: you may add, edit and delete the dev/test account's data (the DEVTOOLS_TEST user) as the card needs, including seeding fixtures and logging, skipping or undoing doses, without asking; keep any fixture the Project constraints call permanent, since other cards' checks use it. Real users' data, and deleting anything in PROD outside the test account, still need the operator's OK."
const hkb = (boardRoot, tasksDir) => `node ${psLiteral(resolve(boardRoot, 'hkb.mjs'))}${tasksDir ? ` --tasks ${psLiteral(tasksDir)}` : ''}`
// Codex's PowerShell tool takes login/yield_time_ms/max_output_tokens; Claude's has
// none of them, so it gets the engine-neutral wording (planner audit F7). Each Codex
// poll re-sends the whole context, so polls wait 30 s (builder audit F1).
export const isCodex = engine => engineKind(engine) === 'codex'
const shellRule = engine => `${isCodex(engine)
  ? 'Use the existing PowerShell tool with login:false and the supplied isolated workdir. Put commands directly in cmd: never prefix bare -NoProfile and never wrap them in nested pwsh -Command. Start checks with yield_time_ms 30000 and poll with yield_time_ms 30000; never poll faster.'
  : 'Run commands directly in the supplied isolated workdir: never prefix bare -NoProfile and never wrap them in nested pwsh -Command.'} Poll a running check's existing session; do not launch a duplicate. Use the check's documented timeout and observed failure; do not invent new timeouts or retry an unchanged failure without diagnosis. Keep full logs in evidence and return a bounded result, not repeated full logs. Check changes with git diff --stat / --numstat; show hunks only for one named file, capped${isCodex(engine) ? ' with max_output_tokens 1500' : ' to about 150 lines'}. Never run npm ci or npm install in a card checkout: its node_modules is a link to the shared install, and installing through it empties every other card's packages (Tradeflow TF103/TF107). Missing packages are [operational]; if the card itself changes package.json or a lockfile, first remove only the link with cmd /c rmdir node_modules, then install.`

// The kanban manager always holds this herdr agent name, in this session — that
// pair IS its address (see _roles/KANBAN_MANAGER.md). herdr looks names up per
// session, so the --session is not optional for an agent working in another
// project's window.
const BUILDER = 'C:/Users/PFrew/Projects/_roles/BUILDER.md'
const REVIEWER = 'C:/Users/PFrew/Projects/_roles/REVIEWER.md'
const AUDITOR = 'C:/Users/PFrew/Projects/_roles/AUDITOR-CARD-WORKFLOW.md'
const PLANNER = 'C:/Users/PFrew/Projects/_roles/PLANNER.md'
const DIFFICULTY_GUIDE = new URL('../PLANNER-DIFFICULTY.md', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PLANNER_OVERLAYS = {
  ui: 'C:/Users/PFrew/Projects/_roles/PLANNER-UI.md',
  code: 'C:/Users/PFrew/Projects/_roles/PLANNER-CODE.md',
  'auth-security': 'C:/Users/PFrew/Projects/_roles/PLANNER-AUTH-SECURITY.md',
  data: 'C:/Users/PFrew/Projects/_roles/PLANNER-DATA.md',
}
// Audit/recovery rules (planner audit F2) only cost tokens on the cards that need them.
const PLANNER_AUDIT_RECOVERY = 'C:/Users/PFrew/Projects/_roles/PLANNER-AUDIT-RECOVERY.md'

// Collapse to one line and strip any stray newline: a newline in a prompt is a
// submit keypress, not whitespace.
const oneLine = (...parts) => parts.join(' ').replace(/\s+/g, ' ').trim()

// SINGLE LINE, always. Prompts are delivered as keystrokes into a TUI, where a
// newline is the submit key — a multi-line prompt submits on its first blank line
// and leaves the rest sitting unsent in the input box.
export function workerPrompt({ card, projectPath, boardRoot, tasksDir, workspacePath: explicitWorkspacePath, engine, previousAttempt = false, handover = '' }) {
  // Absolute paths, not relative: a relative path sends the agent hunting for the
  // file with a glob/search before it can read it, which costs a turn every spawn.
  const cardPath = briefing(tasksDir, card, 'builder', handover)
  const workspacePath = resolve(explicitWorkspacePath || projectPath, explicitWorkspacePath ? '.' : (card.workspace || '.')).replace(/\\/g, '/')
  const cmd = hkb(boardRoot, tasksDir)
  return oneLine(
    previousAttempt ? 'Your previous attempt\'s changes are already in this worktree; read the kick-back feedback in Current feedback, fix only what the feedback names, then re-run your per-AC tests. Preserve existing commits and files.' : '',
    `Read ${cardPath}, ${BUILDER}, the Project constraints the briefing points to (there is no separate safety file), the card's ## Implementation plan, and only applicable required skills. Ponytail is already loaded by hook: do not open its SKILL.md, Projects/filemap.md, or any README.md/AGENTS.md unless this card names it. Workspace root: ${workspacePath}; file paths are relative to it. Scope is the exact listed files: before your first edit, list every file your change needs (start from the plan's Callers checked line, add shared components, styles and tests) and run ${cmd} files ${card.id} <paths, written as ## Files writes them>; if it reports a file missing, hand back at once with the issue command below, category [planning], naming each missing file, and make no edit. Any other missing essential scope requires a specific proposed deviation and operator clarification, not self-approved widening or automatic planning restart.`,
    `Open each line range the plan lists (file, lines A-B, name) directly; search only when a pointer is wrong.`,
    shellRule(engine),
    `For this assigned workspace use workdir=${psLiteral(workspacePath)}. Read the briefing with Get-Content -LiteralPath ${psLiteral(cardPath.replace(/ \(revision [a-f0-9]{64}\)$/, ''))}. Follow known functions/selectors and bounded source ranges; expand a named range only when required context is missing.`,
    `do not deploy, write production data, purchase anything or send external messages unless this card explicitly authorizes it.`,
    `Classify other findings per BUILDER.md's "Classify findings" rule; do not fix confirmed unrelated pre-existing ones.`,
    `Use a ${card.trivial ? 'deterministic' : 'proportional'} check per BUILDER.md's check-type and failure-stop rules.`,
    `Only if the check passes and that workspace is Git-backed, stage only the exact implementation files/paths that changed with git -C ${psLiteral(workspacePath)} add -- <approved-paths>; inspect git -C ${psLiteral(workspacePath)} diff --cached --name-only; then git -C ${psLiteral(workspacePath)} commit -m ${psLiteral(`${card.id} concise title`)}. Quote each approved path individually; never a wildcard or git add .. Never push. Non-Git work needs no commit. If the check fails, the staged set is ambiguous, or the commit fails, leave the work uncommitted and use issue or owner.`,
    `Before declaring the build complete, verify every named prerequisite file, route, selector, dependency and check from the card and plan in the assigned workspace. A missing or unverified prerequisite is a blocker; record the exact path/route, command and observed result instead of assuming it exists. Testing is your job, not the plan's: for each acceptance criterion run the smallest fitting test and record one line per AC, e.g. AC1: npm test -> 4 passing. Record a short structured result in the card's ## Implementation and ## Evidence sections, one line each: the AC lines above, then Stage: builder, Outcome: PASS or BLOCKED, Files: exact paths, Check: your main command, Result: observed result, Evidence: file/link, Blocker: none or exact blocker. done validates these fields and that every AC has its recorded test. Do not print the authoritative card; the briefing already holds its current text. Write both with one command, not a script: ${cmd} result ${card.id} --file <Implementation and Evidence text> (or stdin); only those bodies change; it refuses what done refuses. Keep full logs in evidence files.`,
    `For a check over 10 minutes run ${cmd} tests ${card.id} <name> "<command>", then stop; the board starts a fresh agent on the result.`,
    `When you are finished, run exactly one of these:`,
    `${cmd} unchanged ${card.id} "passing check and observed result" if the requested implementation was already present and the passing check confirms it; this validates a clean unchanged worktree against integration, so never fabricate an empty commit;`,
    `${cmd} finish ${card.id} --file <path> (writes the result, commits staged files, hands off; names every missing part) or ${cmd} done ${card.id} when the result is already written and committed;`,
    `${cmd} issue ${card.id} "[planning|implementation|operational|evidence] specific unmet criterion or prerequisite and evidence" for a failure; select exactly one category. A stop condition the plan itself names, or a plan step that cannot work as written, is [planning]. Planning corrects scope; implementation returns to your Builder session; operational/evidence holds the current stage without restarting product work.`,
    `${cmd} owner ${card.id} "Only the operator can grant <access/permission>; verified <failure>; approved methods exhausted; Evidence: <exact check/result>; <specific ask>" for access only the human can supply. Technical failures and missing evidence use issue.`,
    `For nontrivial code cards, done enters Review and only an independent Reviewer PASS can make the card Completed; explicitly trivial cards may enter Completed after their focused check. Run one of them even if you failed: that command is how the board learns you are done. After the handoff succeeds, stop immediately; do not inspect the board or do more work.`
  )
}

// HK64: the fresh short agent that reads a handed-off test run's saved result. Carries the record
// path and the card's AC lines, never the log text. Single line, like workerPrompt.
export function testResultPrompt({ card, record, recordPath, workspacePath, boardRoot, tasksDir, engine }) {
  const cmd = hkb(boardRoot, tasksDir)
  const text = existsSync(card.path) ? readFileSync(card.path, 'utf8') : ''
  const section = text.match(/^## Acceptance criteria\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? ''
  const criteria = [...section.matchAll(/^-\s+AC\d+:\s+\S.+$/gm)].map(m => m[0].trim())
  const value = v => v ?? 'unknown'
  const verdict = record.error ? ` error: ${record.error}.` : ''
  return oneLine(
    `A test run you handed off for ${card.id} has finished. Read ${briefing(tasksDir, card, 'builder')} and ${BUILDER}; result record: ${recordPath.replaceAll('\\', '/')}.`,
    `Result: name ${record.name}, exit code ${value(record.exitCode)}, passed ${value(record.passed)}, failed ${value(record.failed)}, timed out ${!!record.timedOut}.${verdict}`,
    `Log: ${String(record.log || '').replaceAll('\\', '/')} (when something failed read only its tail, never the whole log).`,
    `Acceptance criteria: ${criteria.join(' ')}`,
    `Workspace root: ${resolve(workspacePath).replace(/\\/g, '/')}; use it as workdir=${psLiteral(workspacePath)}.`,
    shellRule(engine),
    `Do not re-run the handed-off command unless the result is missing or the failure needs a change to your code; if it does, fix, commit and hand off a new run with ${cmd} tests ${card.id} <name> "<command>", then stop.`,
    `Record each AC as AC1: <command> -> <observed result> and Stage: builder, Outcome: PASS or BLOCKED, Files, Check, Result, Evidence, Blocker, one line each, with ${cmd} result ${card.id} --file <text> (or stdin).`,
    `Then run exactly one of: ${cmd} done ${card.id} (the work is committed and the result passes); ${cmd} issue ${card.id} "[planning|implementation|operational|evidence] specific unmet criterion and evidence" for a failure; ${cmd} owner ${card.id} "<specific ask>" only for access the operator alone can supply. Commit before done. After the handoff succeeds, stop immediately.`
  )
}

// The tag names are also parsed by lib/autospawn.mjs (PLAN_ISSUES), which refuses a FAIL without one.
export const PLAN_CHECK_RULE = `Run the exact setup and Check. PASS requires a clean execution failing only on the AC's own assertion, with every selector, route, count, fixture and file verified in current code. An AC assertion failing on the unchanged base is the expected result and is PASS: never FAIL a plan because the requested behaviour is still missing, and never ask for the implementation to be corrected. The Check must also reach and measure every AC target on every listed viewport/state (values in its output or a results file it writes both count). FAIL instead when the Check could not measure: a selector/locator timeout, zero measurements for a viewport/state, or a target only rendered after an interaction the Check does not perform; give the exact Planner correction naming the missing selector/state/interaction. RETRY is only for environment failures. A base run cannot show a Check that a correct build would also fail (an AC that stops early on the base never reaches its real comparison), so read the Check script and every script it runs line by line: for each AC, compare what the Check measures or compares with what the planned build would produce, and FAIL (check-unreachable) when a correct build could not pass it (for example a value one side truncates, rounds or limits, a row an earlier step removed, or a count that ignores other seeds).`
export const PLAN_FAIL_TAGS = `wrong-path = a named file/route does not exist; stale-plan = counts, lines or code facts out of date (a moved HEAD alone is not a fault); check-broken = the Check script errors before measuring; check-unreachable = selector/state/interaction the Check never reaches; check-passes-on-base = an AC already passes unchanged; check-flaky = same base, different results; other`

export function planCheckerPrompt({ cards, projectPath, boardRoot, tasksDir, reviewClaim, reviewRoot, engine, envFile }) {
  const card = cards[0]
  const cmd = `${hkb(boardRoot, tasksDir)} --review-root ${psLiteral(reviewRoot)} --review-claim ${psLiteral(reviewClaim)} plancheck ${card.id}`
  return oneLine(`Independently check this plan: ${briefing(tasksDir, card, 'planner')}.`,
    `Read ${psLiteral(resolve(boardRoot, 'PLAN-CHECKER.md'))}. Your assigned unchanged card checkout is ${psLiteral(projectPath)}. Do not edit code or the card.`,
    shellRule(engine),
    ...(envFile ? [`Approved dev environment file: ${psLiteral(envFile)}. Use it only for the card's setup/Check; never copy or print its values.`, TEST_DATA_RULE] : []),
    PLAN_CHECK_RULE,
    `Handoff: ${cmd} PASS '<command, output, failing AC assertion and dependency evidence>' or ${cmd} FAIL '<tag>: <what is wrong and what must change>' (tag, the main cause: ${PLAN_FAIL_TAGS}) or ${cmd} RETRY '<observed environment failure>'. Quote literal evidence with PowerShell single quotes, doubling embedded apostrophes. Stop after handoff.`)
}

export function reviewerPrompt({ cards, projectPath, boardRoot, tasksDir, reviewClaim, reviewRoot = boardRoot, reportOnly = false, envFile, engine }) {
  const cmd = hkb(boardRoot, tasksDir) + (reviewClaim ? ` --review-root ${psLiteral(reviewRoot)} --review-claim ${psLiteral(reviewClaim)}` : '')
  const workspaceRule = reportOnly ? 'Non-Git workspace: inspection/report only. Do not run builds, install dependencies or mutate this shared directory; return any required isolated-build prerequisite to Planner.' : 'Use only this isolated checkout for builds; preserve its snapshot and evidence after handoff.'
  const list = cards
    .map((c) => `${c.id} (${briefing(tasksDir, c, 'reviewer')})`)
    .join(', ')
  if (cards.every((c) => c.audit)) return oneLine(
    `Audit these cards: ${list}.`,
    `Your assigned snapshot workspace is ${projectPath}. Own only the listed cards. Use a free dedicated local port; never kill shared servers, edit product source, reset account data or run builds in another checkout.`,
    workspaceRule,
    shellRule(engine),
    ...(envFile ? [`Approved project dev environment: ${envFile}. For a local Next check, run node --env-file="${envFile}" node_modules/next/dist/bin/next dev -p <free-card-port> from this isolated snapshot. Do not copy or print environment values; the npm dev wrapper may ignore port arguments. Open localhost (not a different host) for the existing Person 1 authenticated session, /account/ first. Missing injected env is setup recovery, not a request for new credentials. Signed-in check scripts (DEVTOOLS_TEST_EMAIL) load only .env.devtools.local from the project folder, never together with this envFile: both define the test account and the last --env-file wins.`, TEST_DATA_RULE] : []),
    capabilityBrief(cards),
    `Read only ${AUDITOR}, those card files, and the exact targets they list. Use only the required tools/MCPs named on each card.`,
    `Do not edit implementation files, create remediation cards, push, deploy, or claim CLEAR without every evidence gate.`,
    `For each card replace its Evidence, Findings, and Audit conclusion comments. Record CLEAR, FINDINGS, or INCOMPLETE; missing tooling or evidence is INCOMPLETE, never CLEAR. When a card has ## Card-ready findings, FINDINGS also needs its valid json block matching the numbered findings, or the handoff is held as INCOMPLETE.`,
    `Then run ${cmd} audit <ID> "<status>". FINDINGS goes to the responsible Planner for validation/deduplicated linked fixes; CLEAR with evidence closes; INCOMPLETE goes to technical recovery. Explicit Audit disposition: report-only-await-owner opts completed findings into Owner.`,
    `After the final handoff succeeds, stop immediately.`
  )
  return oneLine(
    `Review these finished tasks: ${list}.`,
    `Your assigned snapshot workspace is ${projectPath}. Own only the listed cards, with a separate verdict for each. Use a free dedicated local port; never kill shared servers, edit product source, reset account data or run builds in another checkout. Do not install through a shared dependency junction.`,
    workspaceRule,
    shellRule(engine),
    ...(envFile ? [`Approved project dev environment: ${envFile}. For a local Next check, run node --env-file="${envFile}" node_modules/next/dist/bin/next dev -p <free-card-port> from this isolated snapshot. Do not copy or print environment values; the npm dev wrapper may ignore port arguments. Use localhost for the existing Person 1 authenticated session, /account/ first. Missing injected env is setup recovery, not a request for new credentials. Signed-in check scripts (DEVTOOLS_TEST_EMAIL) load only .env.devtools.local from the project folder, never together with this envFile: both define the test account and the last --env-file wins.`, TEST_DATA_RULE] : []),
    capabilityBrief(cards),
    `Read ${REVIEWER}, those focused briefings, the card's Project constraints section (there is no separate safety file) and only relevant required skills. Ponytail is already loaded by hook: do not open its SKILL.md, Projects/filemap.md, or any README.md/AGENTS.md unless this card names it. Independently inspect actual changed files and map every acceptance criterion to evidence, including a check that fails when the required behaviour is absent.`,
    `Do not run repository-wide searches when a card supplies exact files or selectors. Do not edit implementation code, push or deploy.`,
    `Verify incidental findings against the base and agreed scope. Preserve confirmed unrelated pre-existing findings alongside the verdict; do not demand scope expansion solely for them. In-scope, change-caused, unsafe or acceptance-blocking defects still require rework.`,
    `Check each card's Evidence and re-run the Builder's recorded per-AC tests and main check command in the assigned workdir${isCodex(engine) ? ' with login:false' : ''}, using one proportional check type. Prefer the named callable MCP/CLI tools; Chrome navigation, keyboard and visual/screenshot checks are allowed when relevant to acceptance. Read only relevant skills explicitly referenced by the card. Preflight tool availability, correct project/target and approved isolated auth; never skip required checks or claim PASS from automation alone when visual/keyboard evidence is required.`,
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

// The card Planner's prompt (card-planner.mjs). PLANNER.md holds the ownership, failed-return and Owner rules; this gives the
// cards, the files and the handoff (planner audit F7).
export function plannerPrompt({ cards, projectPath, boardRoot, tasksDir, manager = false, plannerAssignment, engine, amend, envFile }) {
  // IA97 (2026-10-09): a Planner not told the envFile looked for .env files in the checkout and sent the card to Owner.
  const env = envFile ? [`Approved dev environment file (gitignored, in no checkout): ${psLiteral(envFile)}. Any setup needing env or the test account loads it with node --env-file=${psLiteral(envFile)}; it exists, so .env files missing from the checkout are not an access blocker. Never copy or print its values.`, TEST_DATA_RULE] : []
  const cmd = hkb(boardRoot, tasksDir) + (plannerAssignment ? ` --planner-assignment ${plannerAssignment}` : '')
  const list = cards
    .map((c) => `${c.id} [${c.category || 'code'}] [${c.column}] (${briefing(tasksDir, c, 'planner')})`)
    .join(', ')
  const overlays = [...new Set(cards.map((c) => PLANNER_OVERLAYS[c.category || 'code'] || PLANNER_OVERLAYS.code))]
  if (cards.some((c) => c.audit || c.buildAttempts > 0)) overlays.push(PLANNER_AUDIT_RECOVERY)
  if (amend) return oneLine(
    `Amend mode: correct the existing plan for ${list}. Builder's issue: ${amend}`,
    shellRule(engine),
    ...env,
    `Read the card at its authoritative path (named "Authoritative card" in its briefing) for the existing plan and issue; the briefing itself now holds only changed feedback, notes or constraints. Edit only ## Files and ## Prerequisites in that card. Keep everything else unchanged, including the implementation plan, acceptance criteria and Difficulty. Do not re-plan, implement or delegate. Read only the exact source needed to verify the correction in ${psLiteral(projectPath)}; verify any corrected path before handoff.`,
    `After editing, hand off with exactly one ${cmd} <verb> ${cards[0].id} [args] command: move planned when done -- the move is refused until every required label and path is present, the refusal names exactly what is missing, fix it and move again (that is not a second handoff); issue "[planning] precise broader blocker and evidence" if the issue cannot be resolved within these edits; covered <card> "<check> -> <result>" when another card already fixed this (the covering card must be in Archive, Completed or Review); or wait "<file or card>" "<why>" when a prerequisite genuinely needs a file or card that does not exist yet. Stop immediately after the handoff.`
  )
  return oneLine(
    cards.length ? `Plan these approved cards: ${list}.` : `No cards to plan.`,
    shellRule(engine),
    ...env,
    // One combined cat of brief + role files overflows the output cap (planner audit F6).
    `Read each card once at its authoritative path (named in its briefing) for the full plan -- brief, files, prerequisites, AC, Project constraints (no safety file); read the briefing only for what changed: feedback, notes or constraints. Read ${PLANNER} and ${overlays.join(', ')} ${isCodex(engine) ? 'one file per command' : 'with the Read tool, one file per call'}; never concatenate them in one shell command. Read only applicable required skills and source needed to plan. Do not open Projects/filemap.md or any README.md/AGENTS.md unless this card names it. If the card has a ## Finder list (pointers from the board's Finder), read it first and open those ranges directly; search yourself only when a pointer is wrong or the list is short. Verify every named prerequisite file, route, selector, dependency and check exists in the stated workspace before calling the plan build-ready; record the exact path/route and observed result, or mark the plan investigation/blocked when it cannot be verified. Do not accept an unrelated finding as a planning return.`,
    `Search: ${cmd} locate <ID> <term> [<term> ...] prints file, line and window per hit. Files and Changes lines: same command, pointer <ID> <path> <name> prints the A-B range; never type one.`,
    `Read ${DIFFICULTY_GUIDE}. Set **Difficulty:** tiny | easy | medium | hard on every planned card, replacing any Trivial instruction in the shared role. Never lower the workflow's escalated Builder level.`,
    ...(cards.some(c => c.audit) ? [`For FINDINGS audits, validate current findings and deduplicate existing cards; create/update only missing approved remediation cards with scoped independent review. Number findings and map every one under ## Remediation links as - F1: <existing fix card ID>, preserving evidence. Archive the report once all findings are linked; linked fixes are not thereby complete. Respect explicit report-only-await-owner and do not expand business/data/deployment scope. For INCOMPLETE audits repair the evidence plan and prerequisite before returning to Review; never queue an audit itself for implementation. Otherwise:`] : []),
    `Hand off this card with exactly one ${cmd} command, chosen by outcome: move <ID> planned when the plan is ready (refused until every required label and path is present; the refusal names what is missing -- fix it and move again, not a second handoff); issue <ID> "[planning] precise unmet prerequisite and evidence" when planning itself fails; issue <ID> "[decision] the question and the options" for a product or operator decision, which goes to the project manager, not another Planner; issue <ID> "[board] the conflict and the options" for a conflict with the board's own tooling (the plan check, a gate, an hkb refusal you believe is wrong), which goes to the Kanban Manager, never the operator; owner <ID> "Only the operator can grant <permission/access>; verified <failure>; approved methods exhausted; Evidence: <exact check/result>; <specific ask>" for verified missing permission/access only; covered <ID> <card> "<check> -> <result>" when another card already fixed this (the covering card must be in Archive, Completed or Review); wait <ID> "<file or card>" "<why>" when the plan needs a file or card that does not exist yet; or split <ID> --parts <part1.md> <part2.md> [...] when the work is really two or more pieces that edit different files and can each be built and tested alone -- the board checks every part, creates one card per part in Planned and archives this card (two parts may not edit the same file unless one carries **Blocked by:** part N; never split a tiny/easy card or a piece that cannot be tested without another). Do not leave the card in Planning without a handoff, retry a stopped Planner into ambiguity, or issue multiple handoffs. After the handoff succeeds, stop that card immediately.`
  )
}

// Audit 2026-10-15 F4: a correction sent into a Planner's own session (resume, prompt cache
// warm) carries only what is outstanding, never the full brief again: the session already
// holds the card, the role files and the plan. One hand-off, then stop.
export function plannerReentryPrompt({ card, boardRoot, tasksDir, plannerAssignment, engine, note }) {
  const cmd = hkb(boardRoot, tasksDir) + (plannerAssignment ? ` --planner-assignment ${plannerAssignment}` : '')
  return oneLine(
    `Re-entry for ${card.id}: your hand-off for this card was not accepted. Outstanding: ${note || 'read the card\'s Current feedback section for the failing items'}.`,
    shellRule(engine),
    `Fix only those items in the card at ${psLiteral(card.path)}; do not re-read the role files, re-plan what already passed, implement or delegate. Then hand off again with exactly one ${cmd} <verb> ${card.id} [args] command (move planned, issue, owner, covered, wait or split, as before) and stop immediately after it succeeds.`
  )
}

// The Finder (HK29) only reads. Its list is the Planner's first read, so it prints only the list
// and, since HK40, one final Size line the board uses to hold a card too big for one plan.
export function finderPrompt({ card, projectPath }) {
  const root = resolve(projectPath, card.workspace || '.')
  return oneLine(
    `You are the Finder for card ${card.id}. You are read-only: you have Read, Grep and Glob only; change nothing.`,
    `Read the card at ${psLiteral(card.path.replaceAll('\\', '/'))} (## Approved brief and ## Files only), then search ${psLiteral(root.replaceAll('\\', '/'))} for the code the card's ask touches.`,
    `Print only the list, one line per place, exactly: \`repository-relative path\` lines START-END, \`function or selector name\` — one line on why. At most 40 lines and at most 25 tool calls.`,
    `Then print one final line exactly: Size: N files, M areas (N = files the change will edit, M = distinct flows or areas), or exactly: Size: unbounded when you cannot bound the scope within the 25 tool calls. When you find nothing, print only Size: unbounded. Nothing else but the list and that one size line: no headings, no prose.`
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

// Role-prefixed names (b-i149, r-hk14) are how the board recognises a pane it
// spawned, so it only ever closes its own and never one you opened by hand.
export { agentName, isBoardAgent } from './ids.mjs'
