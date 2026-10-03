# Planner difficulty

Set `**Difficulty:** tiny | easy | medium | hard` on every card before handing off a plan. This replaces the shared Planner role's Trivial marker.

- tiny: mechanical edit in one file, with an obvious check.
- easy: clear local fix, with a focused check and known cause.
- medium: multiple files or interacting behavior requiring reasoning.
- hard: architecture, security, or uncertain work across components.

Old `**Trivial:** yes` cards read as easy. New difficulty does not bypass review or completion evidence.

The next Builder steps up after a kick-back, missing handoff, or failed return and never steps down, even after replanning. The workflow state records the attempted and next levels. Tiny uses easy while `agentSettings.tinyEnabled` is false; enable it only when local Ollama serves `qwen3-coder`.

Configure engine, model, reasoning and fallback in `agentSettings.global.builder-tiny`, `builder-easy`, `builder-medium`, and `builder-hard`.
