# herdr-kanban

A local Kanban board for work assigned to coding agents. Markdown cards in each project's `TASKS/` folders are the durable record; the board moves cards, launches agents through herdr, and shows live progress.

![The board](docs/board.png)

## Start

Requires Windows 11, Node 20+, herdr 0.8.0+, and the selected Claude Code or Codex CLI on `PATH`. There are no npm dependencies.

From this folder, run `.\kanban.ps1` to launch the board at `http://127.0.0.1:7777`; stop it with `.\kanban.ps1 -Stop`. Configure project paths and agent settings in `board.config.json`. Check the live board for current cards and agent state.

## Read more when needed

- [HOW-IT-WORKS.md](HOW-IT-WORKS.md): card lifecycle, agent handoffs, audit and recovery, settings, and safe operation.
- [hkb.mjs](hkb.mjs): CLI used for card handoffs.
- [test.mjs](test.mjs): focused Node tests. Run the whole suite with `node run-tests.mjs`.

## Optional agent tools

Card-owned plans with a Check receive an independent check in their unchanged card
checkout before automatic Queue promotion. PASS requires correct execution failing
on the AC assertion and verified selectors, routes, counts, fixtures and files.
FAIL returns to Planning with `Plan check: ...` feedback, without a Builder return.
The Planner's Base-check rule still applies. Set `planCheck: false` in
board.config.json (or POST /api/config) to disable this gate.
`agentSettings.global.plancheck` defaults to Claude, `claude-sonnet-5`, reasoning
`medium`; card overrides use `Plancheck engine/model/reasoning`.

Reviewers and plan checks can run without interactive panes. Set this in
`board.config.json`, or send the same JSON to `POST /api/config`:

```json
{"agentBackend":{"reviewer":"headless","plancheck":"headless"}}
```

The default is `"herdr"`. `"headless"` as a single value selects both supported
roles; Planner and Builder launches still use herdr in this phase, even when their
role setting says headless. Switching settings does not move existing agents.
Headless agents receive their full task at process launch, keep logs and a durable
registry in `.agents/`, and resume their recorded session for corrections after
exit. Opening an agent uses a Windows Terminal tab with `scripts/agent-view.mjs`:
messages, tool inputs and short results are readable while the raw log stays intact.
Closing the viewer leaves the agent running; closing the agent kills its process tree.
Windows requires `wt` and a native CLI executable or the standard npm installation.

Phase 2 (Planners): select the backend in `card-planner.mjs`, bypass workspace/shell
startup, and replace staged-input/Enter recovery with launch/resume delivery while
preserving the planner ownership and correction state.
Phase 3 (Builders): select the backend in `spawn.mjs`, preserve restricted-runtime
guards and worktree binding, capture the JSON session id before guard/usage checks,
and adapt continuation, completed handoff and delivery recovery to process exits.

External hook follow-up (not edited here): `_roles/context-guard.mjs:13`,
`_roles/load-state.mjs:12`, and `_roles/resume-after-clear.mjs:12` should accept
`BOARD_AGENT_ID` wherever they check `HERDR_PANE_ID`. Headless launches currently
set both markers so those existing hooks already skip board agents.

For browser checks, prefer headless Chrome DevTools MCP when available; use headless Playwright if needed. Load browser instructions only for a browser task. Use Windows Computer Use only when browser tools cannot cover the task.

MIT licence.
