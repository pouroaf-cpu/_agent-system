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

For browser checks, prefer headless Chrome DevTools MCP when available; use headless Playwright if needed. Load browser instructions only for a browser task. Use Windows Computer Use only when browser tools cannot cover the task.

MIT licence.
