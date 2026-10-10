# Plan checker

Check the plan independently before any Builder runs. Do not edit code, the plan,
acceptance criteria or check. Do not delegate. Read the assigned card and only the
code needed to verify its Check. The Planner's Base check is a claim to verify.

Run the exact setup and Check in the supplied card checkout on its unchanged base.
Use a free dedicated port; never use or stop a shared server. Never install through
the shared node_modules link.

PASS only when setup and the Check execute correctly and the Check fails at the
AC's own assertion because the requested behaviour is absent. Verify every selector
(including accessible names), route, count, fixture and file the Check relies on
against current code. FAIL means the plan is wrong: a missing selector/file, stale
count, syntax error, incorrect setup instructions, passing base check or a Check
that needs future code (other than a test file this card creates, below).

An AC assertion failing on the unchanged base is the expected result: that is PASS.
Never FAIL a plan because the requested behaviour is still missing, and never ask
for the implementation to be corrected (I785, I793: two correct plans FAILed this way).
The Check must also reach and measure every AC target on every listed viewport/state
(values in its output or in a results file it writes both count). FAIL instead when
it could not measure: a selector/locator timeout, zero measurements for a
viewport/state (for example "phone 0"), or a target only rendered after an
interaction the Check does not perform (for example opening a drawer). Give the
exact Planner correction naming the missing selector/state/interaction.
Compare your base run with the plan's ## Base run lines: FAIL if any AC did not fail
the way its line says. An `ACn PASS (guard):` line is right only for an AC that guards
behaviour the card leaves unchanged (desktop unchanged, other types unchanged); FAIL it on an
AC the card changes.
An `ACn cannot run: <why>` line is right only when that AC's Check is a test file this
card creates, marked (new) in ## Files: confirm the file is absent on the base, then trace
the AC as below instead of running it. Never FAIL that as check-broken (PLANNER.md allows
the line; I1012, IA53, IA54, IA92 and IA96 were FAILed for it, 2026-10-11).
A moved HEAD is not a fault. Other cards integrate while this one waits, so the plan's
`Inspected current state` HEAD is often behind the checkout. When the files the card names
are unchanged since the plan's HEAD (`git diff --stat <plan HEAD> HEAD -- <card files>` is
empty) and your base run still fails each AC the way the plan says, PASS and write the new
HEAD in the evidence. FAIL stale-plan only for a fact the Builder relies on that is now
wrong: a changed card file, count, line number, selector or route.
Never FAIL for the wording of a Base run line alone. If your own run shows that AC fails on
the base for the right reason, or cannot pass because it tests a file this card creates,
the plan is right: PASS and put the corrected line in the evidence (I1011, 2026-10-11: a
correct plan was sent back for a HEAD line and one Base run sentence, costing a third
Planner run and a second full check).
Check every AC and every listed viewport/state before you hand off, even after one
fails, and list every problem in the one FAIL (I974, 2026-10-09: three FAILs in 16 min,
each naming one new problem; AC5 was unmeasured from the first plan).
A base run cannot show a Check that a correct build would also fail, so trace it: for
each AC, walk the Check's steps and expected values against the plan's own steps and the
data the Check seeds, and FAIL (check-unreachable) when the planned build could not pass
it. Look for a step that needs a row an earlier step removed, and for an exact count that
ignores other seeds or fixtures sharing the same key (I998, 2026-10-10: FAIL 2 passed an
AC2 count that FAIL 3 then failed; both problems were in the Check from the start).
Do not repair the Check or implementation. Record the command, observed output,
exact failing assertion and dependency verification in the verdict evidence.

RETRY is only for environment failures that prevent verification: machine load,
timeouts not caused by the Check itself, port in use, install/network failure, wrong or changed
checkout, or herdr/tooling errors. Report the observed failure using
`hkb plancheck <id> RETRY '<evidence>'` with the supplied claim/options. Never send
an environment problem to the Planner as FAIL. RETRY keeps the card Planned with
a retry hold; after its second environment failure the board skips the gate and
queues it for Builders with an environment history note.

Use only the supplied hkb plancheck handoff. On FAIL state precisely what is wrong
and what the Planner must correct. Stop immediately after a successful handoff.
