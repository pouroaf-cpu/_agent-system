// Kanban Manager check-up: every active card's lane age, its agent, and optionally the agent's pane tail.
// Usage: node scripts/km-agents.mjs [project] [--tail N]
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const tailAt = args.indexOf('--tail');
const tail = tailAt >= 0 ? Number(args.splice(tailAt, 2)[1]) || 10 : 0;
const base = 'http://127.0.0.1:7777';

const summary = await (await fetch(`${base}/api/summary`)).json();
const projects = args[0] ? [args[0]] : summary.projects.filter(p => !p.paused).map(p => p.project);

for (const project of projects) {
  const board = await (await fetch(`${base}/api/board?project=${encodeURIComponent(project)}`)).json();
  const status = Object.fromEntries((board.agents || []).map(a => [a.name, a.agent_status]));
  const rows = Object.entries(board.laneTimes || {})
    .map(([id, t]) => ({ id, min: Math.round((Date.now() - Date.parse(t.since)) / 60000), ...t, stage: board.stageIndicators?.[id] }))
    .sort((a, b) => b.min - a.min);
  if (!rows.length) continue;
  console.log(`== ${project}`);
  for (const r of rows) {
    const who = r.agentName ? `${r.agentName} ${status[r.agentName] || 'no pane'}` : (r.stage?.reason || 'waiting');
    console.log(`${r.id.padEnd(6)} ${String(r.min).padStart(4)}m  ${(r.agentRole || '-').padEnd(8)} ${who}`);
    if (tail && r.agentName && status[r.agentName]) {
      try {
        const out = execFileSync('herdr', ['agent', 'read', r.agentName], { encoding: 'utf8' });
        const lines = out.split('\n').filter(l => l.trim());
        const prompt = lines.findLastIndex(l => /^\s*[›❯>]/.test(l)); // drop the input box and status bar
        for (const line of lines.slice(0, prompt >= 0 ? prompt : undefined).slice(-tail)) console.log(`         | ${line.slice(0, 160)}`);
      } catch (e) { console.log(`         | read failed: ${e.message.split('\n')[0]}`); }
    }
  }
}
