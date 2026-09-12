# herdr-kanban

A kanban board for work you hand to coding agents. Cards are markdown files in your repo. Columns are
folders. Moving a card moves the file — there is no database, and nothing to keep in sync.

Agents run in [herdr](https://herdr.dev) panes, so you can watch them work, see when one is stalled,
and take over the terminal at any time.

![the board](docs/board.png)

## Why

Existing agent kanban tools either store tasks in a cloud database your agents cannot read, or observe
agents without being able to start one. This does neither: the cards live next to the code as plain
markdown, and the board drives real terminal sessions through herdr's CLI.

Live status comes from `herdr agent list`, which reports `idle | working | blocked | done` per pane.
A card sitting in Working whose agent has gone idle is a stalled agent, and the board says so.

## Requirements

- Windows 11
- [herdr](https://herdr.dev) 0.8.0 or newer, on `PATH`
- Node 20+
- Claude Code or Codex CLI on `PATH`

No npm install. There are no dependencies.

## Quick start

```powershell
git clone https://github.com/<you>/herdr-kanban
cd herdr-kanban
.\kanban.ps1
```

That starts the board server, opens it in your browser, and attaches herdr. Stop it with
`.\kanban.ps1 -Stop`.

Point it at your own repos by editing `board.config.json`:

```json
{
  "port": 7777,
  "projectsRoot": "C:/Users/you/Projects",
  "projects": ["MyProject"],
  "maxConcurrentAgents": 0,
  "stallSeconds": 60,
  "engine": { "kind": "claude" },
  "models": { "planning": "opus", "working": "sonnet", "issues": "sonnet", "review": "claude-opus-4-6" }
}
```

Omit `engine` for the same Claude default. For Codex, use `"engine": { "kind": "codex" }`
and Codex model names such as `gpt-5.5`; the board adds Codex's bypass flag and
`-c check_for_update_on_startup=false`.

## How cards work

A card is any markdown file in `<project>/TASKS/<column>/`. The board reads the first heading as the
title and picks up a few optional fields:

```markdown
# T-04 — Money calc pages fail mobile LCP

**Priority** 7/10 · **Status:** open · **Surface:** pwa/mobile
```

`README.md`, `TASKLOG.md`, `BRIEF.md` and `TASK-TEMPLATE.md` are ignored, so an existing `TASKS/`
folder works without changes.

| Column    | Folder      | Who puts cards there                                  |
|-----------|-------------|-------------------------------------------------------|
| Planning  | `planning/` | your planner agent, as its first act                   |
| Planned   | `backlog/`  | your planner agent, when the plan is finished          |
| Queue     | `queue/`    | the board, from Planned when `autoQueuePlanned` is on  |
| Working   | `working/`  | the spawner, when an agent slot frees                  |
| Issues    | `issues/`   | the working agent, or you                              |
| Completed | `completed/`| the working agent                                      |
| Review    | `review/`   | you, or automatically for cards flagged Auto-review     |
| Archive   | `archive/`  | the reviewer when a card passes                        |

`backlog/` and `queue/` keep their conventional names so existing repos need no migration.

## Arming the spawner

`maxConcurrentAgents` ships at `0`, which means Queue is just a staging column and nothing starts on
its own. Set it to the number of agents you want running at once:

```json
"maxConcurrentAgents": 3
```

In `mode: auto`, `autoQueuePlanned` moves Planned cards into Queue for you. Queue starts an agent as
soon as a slot is free; blockers only clear once the prerequisite is in Archive. Completed cards keep
their per-card review behavior: cards flagged Auto-review move to Review automatically, while the rest
wait for you.

Technical corrections route through Issues and Planning instead of disappearing. `hkb issue` records a
same-card dirty snapshot for card-listed files; unchanged listed edits can continue on that card,
changed or new listed edits still hold, and unrelated repo dirt is ignored for that card. Auto-review
selection survives correction attempts.

Spawn retries and mission build limits stay bounded. If the circuit breaker sees repeated hard
failures, it stops automatic starts until you reset it rather than burning through more agents.

## How an agent reports back

Every spawned agent is told to finish by running one command from the project root:

```powershell
node C:\path\to\herdr-kanban\hkb.mjs done  T-04
node C:\path\to\herdr-kanban\hkb.mjs issue T-04 "acceptance criterion 3 fails at 390px"
node C:\path\to\herdr-kanban\hkb.mjs pass  T-04
```

That moves the card and frees the agent's slot. `issue` appends the reason to the bottom of the card,
so the next agent to pick it up reads why it came back.

If an agent never runs it, nothing is lost — the card stays in Working and the board marks it stalled.

### Prompts must be one line

Prompts reach the agent as keystrokes into a terminal UI, where a newline is the submit key. A
multi-line prompt submits on its first line break and leaves the remainder sitting unsent in the input
box — the agent gets a truncated brief and never learns how to report back. `lib/prompt.mjs` therefore
builds every prompt through `oneLine()`, `spawn.mjs` refuses to send a string containing `\n`, and
delivery uses `herdr agent prompt --wait --until working` so a prompt that fails to submit is caught
rather than assumed. There is a test covering this; keep it passing if you edit the prompts.

## Layout

```
server.mjs            http server, SSE, file watching
hkb.mjs               the CLI agents call to report back
kanban.ps1            single launch
lib/cards.mjs         card parsing and column moves
lib/bindings.mjs      which pane is running which card
lib/herdr.mjs         herdr CLI wrappers
lib/prompt.mjs        what a spawned agent is told
public/               the board itself
test.mjs              node --test test.mjs
```

## Licence

MIT
