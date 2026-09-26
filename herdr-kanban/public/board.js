'use strict';



const PROJECT = new URLSearchParams(location.search).get('project') || 'Injectbuddy';

const MOCK = new URLSearchParams(location.search).has('mock');



const el = {
  project: document.getElementById('project-pick'),
  stage: document.getElementById('stage-pick'),
  conn: document.getElementById('conn'),
  agents: document.getElementById('agents'),
  lanes: document.getElementById('lanes'),
  toast: document.getElementById('toast'),
  drawer: document.getElementById('drawer'),
  drawerBackdrop: document.getElementById('drawer-backdrop'),
  drawerId: document.getElementById('drawer-id'),
  drawerTitle: document.getElementById('drawer-title'),
  drawerStatus: document.getElementById('drawer-status'),
  drawerBody: document.getElementById('drawer-body'),
  drawerClose: document.getElementById('drawer-close'),
  drawerArchive: document.getElementById('drawer-archive'),
  drawerQueue: document.getElementById('drawer-queue'),
  drawerMore: document.getElementById('drawer-more'),
  drawerMoreMenu: document.getElementById('drawer-more-menu'),
  dlg: document.getElementById('spawn-dlg'),
  dlgMsg: document.getElementById('spawn-msg'),
  slots: document.getElementById('slots'),
  reviewBtn: document.getElementById('review-btn'),
  sweepBtn: document.getElementById('sweep-btn'),
  archiveBtn: document.getElementById('archive-btn'),
  archiveCancel: document.getElementById('archive-cancel'),
  burger: document.getElementById('burger'),
  menu: document.getElementById('menu'),
  scrim: document.getElementById('scrim'),
  screen: document.getElementById('screen'),
  screenTitle: document.getElementById('screen-title'),
  screenBody: document.getElementById('screen-body'),
  screenClose: document.getElementById('screen-close'),
  menuAgents: document.getElementById('menu-agents'),
  menuTasks: document.getElementById('menu-tasks'),
  menuArchive: document.getElementById('menu-archive'),
  breakerBanner: document.getElementById('breaker-banner'),
  breakerMsg: document.getElementById('breaker-msg'),
  breakerReset: document.getElementById('breaker-reset')
};



let state = null;                 // last board payload
const projectPaused = () => state?.control?.paused ?? state?.config?.maxConcurrentAgents === 0;
const explicitCardRunning = () => (state?.cardRuns || []).some(r => r.status === 'running');

document.getElementById('herdr-open').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/herdr-open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: PROJECT }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'could not open herdr session');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

document.getElementById('project-control').addEventListener('click', async () => {
  const button = document.getElementById('project-control');
  button.disabled = true;
  try {
    const response = await fetch('/api/project-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: PROJECT, paused: explicitCardRunning() || !projectPaused() }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    state.control = result.control;
    render();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

const statusSince = new Map();    // agent name -> ms timestamp status last changed

const spawning = new Set();       // card ids with an in-flight /api/spawn

// Ordered, not a Set: the board has no "started reviewing X" signal, only "X left

// Review" on completion — so index 0 (batch send order) is our best guess at which

// card the reviewer is actually on right now. The rest are queued behind it.

let reviewing = [];

let openId = null;                // card id shown in the drawer, or null

let paneTimer = null;

let managerTasks = { loading: false, error: '', tasks: [], generatedAt: null, source: '', usage: {} };

let managerTaskSort = { key: 'date', dir: 'desc' };

const managerTaskOpen = new Set();



/* ------------------------------------------------------------------ data */



function mockPayload() {

  const cols = [['planning', 'planning', 'Planning'], ['planned', 'backlog', 'Planned'],

    ['queue', 'queue', 'Queue'], ['working', 'working', 'Working'], ['issues', 'issues', 'Issues'],

    ['review', 'review', 'Review'], ['completed', 'completed', 'Completed']];

  const c = (id, title, column, priority, extra) => Object.assign({

    id, title, file: id.toLowerCase() + '.md', path: 'C:\\mock\\' + id + '.md',

    column, priority, status: 'open — mock card', surface: 'both', mtime: Date.now()

  }, extra || {});

  return {

    project: 'Injectbuddy (mock)', projectPath: 'C:\\Users\\PFrew\\Projects\\Injectbuddy',

    columns: cols.map(([key, dir, label]) => ({ key, dir, label })),

    archive: { key: 'archive', dir: 'archive', label: 'Archive' },

    board: {

      planning: [c('T-09', 'Decide whether dose history should live in localStorage or Supabase', 'planning', 4, { surface: 'web' })],

      planned: [

        c('T-01', 'Semaglutide, tirzepatide and GLP-1 titration cannot take BAC water as an input in the calculator', 'planned', 5,

          { status: 'open — code landed, runtime-unverified', file: 'T-01-bac-water-input-glp1-calcs.md' }),

        c('T-07', 'Reconstitution results should round to syringe-readable units', 'planned', 9, { surface: 'app' })

      ],

      queue: [c('T-03', 'Add unit toggle (mg/mL vs units) to the peptide calculator output', 'queue', 7)],

      working: [

        c('T-04', 'Rewrite the vial volume solver so it stops dividing by zero on empty input', 'working', 8),

        c('T-05', 'Dark mode contrast pass across calculator screens', 'working', 3, { surface: 'web' })

      ],

      issues: [c('T-06', 'Blocked: Supabase RLS policy rejects anonymous dose reads', 'issues', 6, { status: 'blocked — waiting on policy decision' })],

      completed: [c('T-02', 'Ship the BAC water calculator landing page', 'completed', 5)],

      review: [c('T-08', 'Review peptide dosage disclaimer copy for medical accuracy', 'review', 10, { surface: 'both' })],

      archive: [c('T-00', 'Old spike: react-native shell for the calculator', 'archive', 2)]

    },

    agents: [

      { agent: 'claude', agent_status: 'working', cwd: 'C:\\Users\\PFrew\\Projects\\Injectbuddy', name: 'builder-injectbuddy', pane_id: 'w9:p4', tab_id: 'w9:t1', terminal_title_stripped: 'T-05 dark mode contrast pass', interactive_ready: true },

      // deliberately named so the old string-match heuristic CANNOT find it —

      // only the bindings entry below binds it to T-04

      { agent: 'claude', agent_status: 'idle', cwd: 'C:\\Users\\PFrew\\Projects\\Injectbuddy', name: 'worker-alpha', pane_id: 'w9:p5', tab_id: 'w9:t1', terminal_title_stripped: 'Rewrite the vial volume solver so it stops dividing by zero', interactive_ready: true },

      { agent: 'claude', agent_status: 'blocked', cwd: 'C:\\Users\\PFrew\\Projects\\Injectbuddy', name: 'planner-injectbuddy', pane_id: 'w9:p6', tab_id: 'w9:t2', terminal_title_stripped: 'Waiting on RLS policy decision for T-06', interactive_ready: false },

      { agent: 'claude', agent_status: 'done', cwd: 'C:\\Users\\PFrew\\Projects\\Injectbuddy', name: 'reviewer-injectbuddy', pane_id: 'w9:p7', tab_id: 'w9:t2', terminal_title_stripped: 'Reviewed disclaimer copy, handing back', interactive_ready: true }

    ],

    bindings: {

      'T-04': { pane_id: 'w9:p5', tab_id: 'w9:t1', model: 'sonnet', name: 'worker-alpha', started: new Date(Date.now() - 22 * 60000).toISOString() }

    },

    herdrUp: true,

    slotsFree: 2,

    config: { stallSeconds: 60, maxConcurrentAgents: 3, model: 'sonnet', reviewModel: 'claude-opus-4-6', sweepModel: 'sonnet' }

  };

}



async function loadBoard() {

  if (MOCK) {

    const p = mockPayload();

    // pre-aged so the stall shows immediately instead of 60s from now

    statusSince.set('worker-alpha', { status: 'idle', at: Date.now() - 4 * 60000 });

    return p;

  }

  const r = await fetch('/api/board?project=' + encodeURIComponent(PROJECT));

  if (!r.ok) throw new Error('board ' + r.status);

  return r.json();

}



/* ---------------------------------------------------------- stall logic */



// Real binding from /api/board `bindings` (card id -> pane). The string-match

// heuristic survives only as a fallback for hand-started agents that herdr

// never spawned, so they still show against their card.

function agentForCard(card, agents) {

  const list = agents || [];

  const b = state && state.bindings && state.bindings[card.id];

  if (b) return list.find(a => a.pane_id === b.pane_id) || null;

  const id = card.id.toLowerCase();

  return list.find(a =>

    (a.name || '').toLowerCase().includes(id) ||

    (a.terminal_title_stripped || '').toLowerCase().includes(id)) || null;

}



function trackStatuses(agents) {

  const now = Date.now();

  const seen = new Set();

  (agents || []).forEach(a => {

    seen.add(a.name);

    const prev = statusSince.get(a.name);

    if (!prev || prev.status !== a.agent_status) statusSince.set(a.name, { status: a.agent_status, at: now });

  });

  [...statusSince.keys()].forEach(k => { if (!seen.has(k)) statusSince.delete(k); });

}



function heldMs(agent) {

  const s = statusSince.get(agent.name);

  return s ? Date.now() - s.at : 0;

}



// A card in Working that no agent is bound to at all. Nothing is coming to move

// it — it needs you. Previously these were invisible, because stall detection

// only looked at cards that had an agent.

function orphaned(card) {

  if (!state || card.column !== 'working') return false;

  const b = state.bindings?.[card.id];

  if (b) return false;

  return !agentForCard(card, state.agents);

}



// returns stall duration in ms, or 0 if not stalled

function stallMs(card) {

  if (!state || card.column !== 'working') return 0;

  const a = agentForCard(card, state.agents);

  if (!a || (a.agent_status !== 'idle' && a.agent_status !== 'blocked')) return 0;

  const ms = heldMs(a);

  return ms > (state.config?.stallSeconds ?? 60) * 1000 ? ms : 0;

}



/* ------------------------------------------------------------------- ui */



const CONN_LABEL = { live: 'Live', reconnecting: 'Reconnecting…', offline: 'Offline' };
function setConn(kind) { el.conn.className = 'conn ' + kind; el.conn.textContent = CONN_LABEL[kind] || kind; }



let toastTimer;

function toast(msg, kind) {

  el.toast.textContent = msg;

  el.toast.className = 'toast' + (kind ? ' ' + kind : '') + ' show';

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3000);

}






/* --------------------------------------------------- bulk archive picking */

// Two clicks of one button: the first arms the Completed column (cards wobble and

// grow a checkbox), the second files whatever is ticked. Nothing moves until the

// second click, so an armed board is safe to walk away from.

let picking = false;

const picked = new Set();



function stopPicking() {

  picking = false;

  picked.clear();

}



// Lane timer: how long a card has sat in its lane, and whether an agent is on it
// right now. Comes from /api/board `laneTimes`; without it no timer is shown.
const TIMED_LANES = { planning: 'Planning', queue: 'Queue', working: 'Working', review: 'Review', completed: 'Completed' };
const ACTIVE_VERB = { planning: 'Planning', working: 'Building', review: 'Reviewing' };
const ROLE_VERB = { planner: 'Planning', builder: 'Building', reviewer: 'Reviewing' };
const AGENT_EXPECTED = new Set(['planning', 'working']);
const IDLE_WARN_MS = 20 * 60000;

// 45m, then 1h 20m, then 2d 3h.
function fmtAge(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h ' + (m % 60) + 'm' : Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function laneTimer(card) {
  const t = state?.laneTimes?.[card.id];
  const label = TIMED_LANES[card.column];
  if (!t || !label) return null;
  const since = typeof t.since === 'number' ? t.since : Date.parse(t.since);
  if (!Number.isFinite(since)) return null;
  const age = Date.now() - since;
  if (t.agentActive) {
    const verb = ROLE_VERB[String(t.agentRole || '').toLowerCase()] || ACTIVE_VERB[card.column] || label;
    return { text: verb + ' · ' + fmtAge(age), tone: 'active', title: (t.agentRole || 'Agent') + ' working · in ' + label + ' for ' + fmtAge(age) };
  }
  const expected = AGENT_EXPECTED.has(card.column);
  return {
    text: label + ' · ' + fmtAge(age) + (expected ? ' · no agent' : ''),
    tone: expected && age > IDLE_WARN_MS ? 'owner' : 'muted',
    title: 'In ' + label + ' for ' + fmtAge(age) + (expected ? '; no agent is working on it' : ''),
  };
}

// The one status line a card carries, strongest signal first. Returns
// { text, tone, title } or null. Tone names a status colour.
function cardStatus(card) {
  if (!state) return null;
  const stalled = stallMs(card);
  if (stalled) return { text: 'Stalled ' + fmtAge(stalled), tone: 'problem', title: 'Agent has been quiet for ' + fmtDur(stalled) };
  const timer = laneTimer(card);
  if (orphaned(card)) return { text: timer && timer.tone !== 'active' ? timer.text : 'No agent', tone: 'problem', title: 'In Working with nothing running on it — move it back to Queue to run it again' };
  if (spawning.has(card.id)) return { text: 'Starting…', tone: 'active' };
  if (card.column === 'pou') return { text: 'Waiting on Pou', tone: 'owner' };
  if (card.column === 'owner') return { text: 'Waiting on Kanban Manager', tone: 'muted' };
  const notice = state.workflow?.[card.id]?.operational?.reason || state.workflow?.[card.id]?.limitWarning;
  if (notice) return { text: notice, tone: 'problem' };
  // Why the board passed this card over on its last tick: a Queue start hold, or any
  // lane waiting for an engine that is out of usage ("Codex usage limit; retrying at …").
  const hold = state.holds?.[card.id];
  if (hold) return { text: hold, tone: 'muted' };
  const ind = state.stageIndicators?.[card.id];
  const review = ind?.stage === 'Reviewer';
  if (ind?.status === 'issue') return { text: review ? 'Review feedback' : 'Plan issue', tone: 'problem', title: ind.stage + ': ' + ind.reason };
  if (ind?.status === 'passed') return { text: review ? 'Review passed' : 'Plan passed', tone: 'ok', title: ind.stage + ': ' + ind.reason };
  const queued = reviewing.indexOf(card.id);
  if (queued === 0) return timer?.tone === 'active' ? timer : { text: 'Reviewing', tone: 'active' };
  if (queued > 0) return { text: 'Review queued', tone: 'muted' };
  if (timer) return timer;
  if (ind?.status === 'working') return { text: review ? 'Reviewing' : 'Planning', tone: 'active', title: ind.stage + ': ' + ind.reason };
  const bind = card.column === 'working' && state.bindings?.[card.id];
  if (bind) return { text: 'Building' + (bind.started ? ' · ' + fmtAge(Date.now() - Date.parse(bind.started)) : ''), tone: 'active' };
  return null;
}

function paintStatus(node, card) {
  const s = cardStatus(card);
  let line = node.querySelector('.card-status');
  if (!s) { line?.remove(); return; }
  if (!line) { line = document.createElement('div'); node.prepend(line); }
  line.className = 'card-status tone-' + s.tone;
  line.textContent = s.text;
  line.title = s.title || s.text;
}

const compactNum = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function cardNode(card) {
  const n = document.createElement('div');
  const busy = spawning.has(card.id);
  const reviewIdx = reviewing.indexOf(card.id);
  n.className = 'card' + (busy ? ' spawning' : '') +
    (reviewIdx === 0 ? ' reviewing' : reviewIdx > 0 ? ' review-queued' : '');
  n.draggable = !busy;
  n.dataset.id = card.id;
  n.dataset.from = card.column;
  n.tabIndex = 0;
  n.addEventListener('keydown', event => {
    if (event.target === n && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); n.click(); }
  });
  if (card.status) n.title = card.status;

  const t = document.createElement('div');
  t.className = 'title';
  t.textContent = card.title;
  n.append(t);
  paintStatus(n, card);

  // One meta line, plain words: which card, how urgent, and what it waits on.
  const bits = [];
  const bit = (text, title, cls) => bits.push({ text, title, cls });
  bit(card.id);
  // P0 on every card is noise: an unset priority is not a priority.
  if (card.priority) bit('P' + card.priority, null, card.priority >= 8 ? 'hot' : '');
  if (card.surface) bit(card.surface);
  // Only the estimate that matches where the card sits right now.
  const estMin = card.column === 'working' ? card.estBuild : card.column === 'review' ? card.estReview : null;
  if (estMin != null) bit('est ' + estMin + 'm');
  const waitingOn = (card.blockedBy || []).filter(id => {
    const c = allCards().find(x => x.id === id);
    return !c || !LANDED.has(c.column);
  });
  if (waitingOn.length) bit('waits ' + waitingOn.join(' '), 'Will not start until ' + waitingOn.join(', ') + ' reaches Completed');
  const holdsUp = allCards().filter(c => (c.blockedBy || []).includes(card.id)).length;
  if (holdsUp) bit('holds ' + holdsUp, holdsUp + ' card' + (holdsUp === 1 ? '' : 's') + ' cannot start until this one lands');
  // A card that failed to start is still queued, but it is on its second go.
  const retry = state.retries?.[card.id]?.attempts || 0;
  if (retry) bit('retry ' + retry + '/3', 'Failed to start ' + retry + ' time' + (retry === 1 ? '' : 's') + '; goes to Issues after 3');
  const usage = state?.cardUsage?.[card.id];
  if (usage) bit(usage.tokens ? compactNum.format(usage.tokens.total) + ' tokens' + (usage.unknown ? ' (partial)' : '') : 'usage unverified', usage.tokens ? fmtNum(usage.tokens.total) + ' tokens' : null);
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  bits.forEach((b, i) => {
    if (i) meta.append(' · ');
    const s = document.createElement('span');
    s.textContent = b.text;
    if (b.cls) s.className = b.cls;
    if (b.title) s.title = b.title;
    meta.append(s);
  });
  n.append(meta);

  // Operator buttons: Approve a Pou or Owner card, Finish a Review or Completed card.
  const op = ['pou', 'owner'].includes(card.column) ? 'approve' : ['review', 'completed'].includes(card.column) ? 'finish' : null;
  if (op && !picking) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn card-op' + (op === 'approve' ? ' primary' : '');
    b.textContent = op === 'approve' ? 'Approve' : 'Finish';
    b.setAttribute('aria-label', (op === 'approve' ? 'Approve ' : 'Finish ') + card.id);
    b.title = op === 'approve' ? 'Approve and send it back to work' : 'Integrate if needed, then archive';
    b.draggable = false;
    b.addEventListener('click', e => { e.stopPropagation(); operatorAction(op, card.id, b); });
    b.addEventListener('keydown', e => e.stopPropagation());
    n.append(b);
  }

  // Only Completed is pickable — it is the only column this button files from.
  const pickable = picking && card.column === 'completed';
  if (pickable) {
    n.classList.add('picking');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'card-pick';
    box.checked = picked.has(card.id);
    box.title = 'Tick to archive on Confirm';
    // The whole card is the hit target, so the box only ever reflects state.
    box.addEventListener('click', e => e.preventDefault());
    t.prepend(box);
  }
  n.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', card.id);
    e.dataTransfer.effectAllowed = 'move';
    n.classList.add('dragging');
  });
  n.addEventListener('dragend', () => n.classList.remove('dragging'));
  // While picking, a click on a Completed card ticks it instead of opening the drawer.
  n.addEventListener('click', () => {
    if (!pickable) return openDrawer(card.id);
    if (picked.has(card.id)) picked.delete(card.id); else picked.add(card.id);
    n.querySelector('.card-pick').checked = picked.has(card.id);
    n.classList.toggle('picked', picked.has(card.id));
    renderArchiveBtn();
  });
  if (pickable && picked.has(card.id)) n.classList.add('picked');
  return n;
}



const EMPTY_LABEL = 'Empty';



/* ------------------------------------------------------------------ views */



// Four screens, one at a time. The board stays mounted underneath rather than

// being torn down, so switching back does not refetch or lose scroll.

let view = 'board';
const dependencyHover = createDependencyHover({
  root: el.lanes,
  enabled: () => view === 'board' && !openId && !picking,
  getBlockers: id => {
    const matches = Object.entries(state?.board || {}).filter(([key]) => key !== 'archive').flatMap(([, cards]) => cards).filter(card => card.id === id);
    if (matches.length !== 1) return [];
    return [...new Set((state?.blockerIds?.[id] || matches[0].blockedBy || []).filter(other => other !== id && /^(?:T-\d+|[A-Z]{1,3}\d+)$/i.test(other)))];
  },
});
let audits = { loading: true, error: '', items: [] };



function setView(next) {
  dependencyHover.reset();

  const resetScroll = next === 'tasks' && view !== 'tasks';

  view = next;

  closeMenu();

  const onBoard = next === 'board';

  el.lanes.hidden = !onBoard;

  el.screen.hidden = onBoard;

  if (state) {

    renderReviewBtn();

    renderSweepBtn();

    renderArchiveBtn();

  }

  if (!onBoard) {

    el.screenTitle.textContent = { agents: 'Agents', tasks: 'Historical requests', archive: 'Archive', audits: 'Audits', settings: 'Settings' }[next];

    renderScreen(resetScroll);

    if (next === 'tasks') loadManagerTasks();
    if (next === 'audits') loadAudits();

  }

}



function openMenu() {

  el.menu.style.top = document.getElementById('bar').getBoundingClientRect().bottom + 'px';
  el.menu.hidden = false;

  el.scrim.hidden = false;

  el.burger.setAttribute('aria-expanded', 'true');

}

function closeMenu() {

  el.menu.hidden = true;

  el.scrim.hidden = true;

  el.burger.setAttribute('aria-expanded', 'false');

}



function renderScreen(resetScroll) {

  if (!state || view === 'board') return;

  const scrollTop = resetScroll ? 0 : el.screenBody.scrollTop;

  el.screenBody.innerHTML = '';

  if (view === 'agents') renderAgentsScreen();

  else if (view === 'tasks') renderManagerTasksScreen();

  else if (view === 'archive') renderArchiveScreen();
  else if (view === 'audits') renderAuditsScreen();

  else if (view === 'settings') renderSettingsScreen();

  el.screenBody.scrollTop = scrollTop;

}

async function loadAudits() {
  audits.loading = true;
  if (view === 'audits') renderScreen();
  try {
    const response = await fetch('/api/audits?project=' + encodeURIComponent(PROJECT));
    const result = await response.json();
    if (!response.ok || !result.ok || result.project !== PROJECT) throw new Error(result.error || 'Could not load audits');
    audits = { loading: false, error: '', items: result.audits || [] };
  } catch (err) { audits = { loading: false, error: err.message, items: [] }; }
  if (view === 'audits') renderScreen();
}

function renderAuditsScreen() {
  if (audits.loading) return el.screenBody.append(note('Loading reports…'));
  if (audits.error) return el.screenBody.append(note(audits.error));
  el.screenBody.append(note('Reports for ' + PROJECT + '. Read a report, then request any follow-up yourself. No findings are turned into work here.'));
  if (!audits.items.length) return el.screenBody.append(note('No audit reports found for this project.'));
  const grid = document.createElement('div');
  grid.className = 'audits-grid';
  for (const audit of audits.items) {
    const card = document.createElement('article'); card.className = 'audit-card';
    const title = document.createElement('h2'); title.textContent = audit.title;
    const date = document.createElement('p');
    date.textContent = audit.dateLabel + ': ' + new Date(audit.date).toLocaleDateString();
    const status = document.createElement('p'); status.className = 'audit-status'; status.textContent = audit.status;
    card.append(title, date, status);
    for (const report of audit.reports) {
      const open = document.createElement('button'); open.type = 'button'; open.className = 'btn audit-open';
      open.textContent = audit.reports.length === 1 ? 'Open report in VS Code' : 'Open ' + report.name + ' in VS Code';
      open.title = report.file;
      open.addEventListener('click', () => openInEditor(null, report.id));
      card.append(open);
    }
    if (!audit.reports.length) card.append(note('No Markdown report is available.'));
    grid.append(card);
  }
  el.screenBody.append(grid);
}



function renderAgentsScreen() {

  const agents = visibleAgents();

  if (!state.herdrUp) return el.screenBody.append(note('herdr is not running, so there is nothing to report.'));

  if (!agents.length) return el.screenBody.append(note('No agents are running on ' + state.project + '.'));



  // Which card each agent is on, so this reads as work rather than as processes.

  const byPane = {};

  for (const [id, b] of Object.entries(state.bindings || {})) byPane[b.pane_id] = { id, ...b };



  const table = document.createElement('div');

  table.className = 'agents-grid';

  agents.forEach(a => {

    const b = byPane[a.pane_id];

    const row = document.createElement('article');

    row.className = 'agent-row ' + (a.agent_status || 'unknown');



    const head = document.createElement('div');

    head.className = 'agent-head';

    head.innerHTML = '<strong class="agent-name"></strong>' +
      '<span class="agent-status"></span><span class="agent-pane"></span>';

    head.querySelector('.agent-name').textContent = b ? b.id : a.name;

    head.querySelector('.agent-status').textContent = a.agent_status;

    head.querySelector('.agent-pane').textContent = a.pane_id;



    const doing = document.createElement('p');

    doing.className = 'agent-doing';

    doing.textContent = a.terminal_title_stripped || '—';



    const meta = document.createElement('p');

    meta.className = 'agent-meta';

    const bits = [];

    if (b) bits.push('card ' + b.id);

    if (b?.model) bits.push(b.model);

    if (b?.started) bits.push('running ' + fmtDur(Date.now() - Date.parse(b.started)));

    if (!b) bits.push('not started by the board');

    meta.textContent = bits.join(' · ');



    row.append(head, doing, meta);
    if (a.agent_status !== 'missing') {
      const sessionButton = document.createElement('button');
      sessionButton.className = 'btn';
      sessionButton.textContent = 'Open session';
      sessionButton.addEventListener('click', () => openAgent(a));
      row.append(sessionButton);
    }

    if (b) {

      const open = document.createElement('button');

      open.className = 'btn';

      open.textContent = 'Open card';

      open.addEventListener('click', () => { setView('board'); openDrawer(b.id); });

      row.append(open);

    }

    table.append(row);

  });

  el.screenBody.append(table);

}



function renderArchiveScreen() {

  const cards = state.board.archive || [];

  if (!cards.length) return el.screenBody.append(note('Nothing archived yet.'));

  const grid = document.createElement('div');

  grid.className = 'archive-grid';

  cards.forEach(c => grid.append(cardNode(c)));

  el.screenBody.append(grid);

}



function renderManagerTasksScreen() {

  if (managerTasks.loading && !managerTasks.tasks.length) return el.screenBody.append(note('Loading tasks...'));

  if (managerTasks.error && !managerTasks.tasks.length) return el.screenBody.append(note(managerTasks.error));

  if (!managerTasks.tasks.length) return el.screenBody.append(note('No tasks recorded.'));



  const wrap = document.createElement('div');

  wrap.className = 'manager-tasks';



  const meta = document.createElement('p');

  meta.className = 'manager-tasks-meta';

  meta.textContent = (managerTasks.generatedAt ? 'Refreshed ' + fmtTaskTime(managerTasks.generatedAt) : 'Refresh time unknown') +

    ' | Recorded token usage to date. Unknown and shared work are excluded from totals; these are not billing totals.';

  wrap.append(meta);

  if (managerTasks.error) wrap.append(note(managerTasks.error));



  const projects = [...new Set(managerTasks.tasks.map(t => t.project || 'Unassigned'))].sort();

  const groups = projects.map(project => {

    const tasks = sortedManagerTasks().filter(t => (t.project || 'Unassigned') === project);

    const tokens = { total: 0, uncachedInput: 0, cachedInput: 0, output: 0 };

    let known = 0, unknown = 0;

    for (const task of tasks) {

      const u = taskUsage(task);

      if (u?.tokens) { known++; for (const key of Object.keys(tokens)) tokens[key] += u.tokens[key] || 0; }

      if (!u?.tokens || u.unknown || u.shared || u.active) unknown++;

    }

    return { project, tasks, tokens, known, unknown };

  }).sort((a,b) => b.tokens.total - a.tokens.total || a.project.localeCompare(b.project));

  for (const group of groups) {

  const section = document.createElement('section'); section.className = 'task-project';

  const title = document.createElement('h2'); title.textContent = group.project; section.append(title);

  const totals = document.createElement('p'); totals.className = 'project-usage';

  totals.textContent = group.known ? `Recorded total ${fmtNum(group.tokens.total)} | New input ${fmtNum(group.tokens.uncachedInput)} | Cached input ${fmtNum(group.tokens.cachedInput)} | Output ${fmtNum(group.tokens.output)}` : 'Recorded total: Unknown';

  if (group.unknown) totals.textContent += ` | ${group.unknown} task(s) with incomplete or shared coverage`;

  section.append(totals);

  const table = document.createElement('table');

  table.className = 'manager-tasks-table';

  const thead = document.createElement('thead');

  const head = document.createElement('tr');

  const columns = [

    ['date', 'Date'],

    ['time', 'Time'],

    ['category', 'Category'],

    ['description', 'Job'],

    ['assignedTo', 'Assigned to'],

    ['status', 'Status'],

    ['usage', 'Usage']

  ];

  columns.forEach(([key, label]) => {

    const th = document.createElement('th');

    th.scope = 'col';

    const btn = document.createElement('button');

    btn.type = 'button';

    btn.className = 'task-sort';

    const active = managerTaskSort.key === key;

    const nextDir = active && managerTaskSort.dir === 'asc' ? 'desc' : 'asc';

    const textSort = !/date|time|usage/.test(key);

    const sortHint = textSort

      ? (managerTaskSort.dir === 'asc' ? 'A-Z' : 'Z-A')

      : (key === 'usage' ? (managerTaskSort.dir === 'asc' ? 'lowest first' : 'highest first') : (managerTaskSort.dir === 'asc' ? 'oldest first' : 'newest first'));

    th.setAttribute('aria-sort', active ? (managerTaskSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

    btn.setAttribute('aria-label', 'Sort by ' + label + ' ' + (nextDir === 'asc' ? 'ascending' : 'descending'));

    btn.textContent = label + (active ? ' ' + (managerTaskSort.dir === 'asc' ? '↑' : '↓') + ' ' + sortHint : '');

    btn.addEventListener('click', () => {

      managerTaskSort = { key, dir: nextDir };

      renderScreen();

    });

    th.append(btn);

    head.append(th);

  });

  thead.append(head);

  table.append(thead);



  const tbody = document.createElement('tbody');

  group.tasks.forEach(t => {

    const tr = document.createElement('tr');

    tr.dataset.requestId = t.id || '';

    [

      fmtTaskDate(t),

      t.timeKnown ? fmtTaskClock(t.time) : 'Unknown',

      t.category || 'General',

      t.description || 'No description recorded',

      t.assignedTo || 'Unknown',

      t.status || 'unknown',

      fmtTaskUsage(t)

    ].forEach((value, i) => {

      const td = document.createElement('td');

      td.dataset.label = columns[i][1];

      td.textContent = value;

      if (i === 5) td.className = 'task-status ' + String(value).replace(/\s+/g, '-').toLowerCase();

      if (i === 6) td.className = 'task-usage';

      tr.append(td);

    });

    tr.tabIndex = 0; tr.setAttribute('aria-expanded', String(managerTaskOpen.has(t.id)));

    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tr.click(); } });

    tr.addEventListener('click', () => {

      if (!taskUsage(t)) return;

      if (managerTaskOpen.has(t.id)) managerTaskOpen.delete(t.id); else managerTaskOpen.add(t.id);

      renderScreen();

    });

    tbody.append(tr);

    const usage = taskUsage(t);

    if (usage && managerTaskOpen.has(t.id)) {

      const detail = document.createElement('tr');

      detail.className = 'task-usage-detail';

      const td = document.createElement('td');

      td.colSpan = columns.length;

      td.textContent = [...usage.agents].sort((a,b) => (b.tokens?.total || 0) - (a.tokens?.total || 0)).map(formatAgentUsage).join('\n') || 'No agent rows recorded.';

      detail.append(td);

      tbody.append(detail);

    }

  });

  table.append(tbody);

  section.append(table); wrap.append(section);

  }

  const ah = document.createElement('h2');
  ah.textContent = 'Agent execution';
  const ap = document.createElement('p');
  ap.className = 'settings-help';
  ap.textContent = 'Manual choices apply to new assignments only. Running agents keep their saved launch settings; the board never fails over automatically.';
  wrap.append(ah, ap);
  const stages = state.config?.agentSettings || {};
  const catalog = state.config?.supportedAgentSettings || {};
  for (const [stage, label] of [['planning', 'Planner'], ['working', 'Builder'], ['review', 'Reviewer'], ['issues', 'Issues'], ['trivial', 'Trivial']]) {
    const current = stages[stage] || {};
    const line = document.createElement('div'); line.className = 'settings-agent-row';
    const title = document.createElement('strong'); title.textContent = label;
    const engine = document.createElement('select');
    for (const key of Object.keys(catalog)) { const o = document.createElement('option'); o.value = key; o.textContent = key; o.selected = key === current.engine; engine.append(o); }
    const model = document.createElement('select');
    const reasoning = document.createElement('select');
    const refresh = () => {
      model.replaceChildren();
      for (const name of catalog[engine.value]?.models || []) { const o = document.createElement('option'); o.value = name; o.textContent = name; o.selected = name === current.model; model.append(o); }
      reasoning.replaceChildren();
      for (const name of catalog[engine.value]?.reasoning || []) { const o = document.createElement('option'); o.value = name; o.textContent = name; o.selected = name === current.reasoning; reasoning.append(o); }
    };
    refresh();
    const save = () => saveConfig({ agentSettings: { [stage]: { engine: engine.value, model: model.value, reasoning: reasoning.value } } });
    engine.addEventListener('change', () => { refresh(); save(); }); model.addEventListener('change', save); reasoning.addEventListener('change', save);
    line.append(title, engine, model, reasoning); wrap.append(line);
  }
  el.screenBody.append(wrap);

}



function renderSettingsScreen() {

  const max = state.config?.maxConcurrentAgents ?? 0;

  const mode = state.config?.mode ?? 'auto';

  const wrap = document.createElement('div');

  wrap.className = 'settings';



  const mh = document.createElement('h2');

  mh.textContent = 'Board mode';

  const mp = document.createElement('p');

  mp.className = 'settings-help';

  mp.textContent = 'Auto starts Queue cards on its own and sweeps Issues. Auto-Manager stops that: ' +

    'a manager agent sweeps Issues and Owner every 15 minutes, answers what the evidence settles, ' +

    'parks what only you can, and decides what gets started.';



  const mrow = document.createElement('div');

  mrow.className = 'pri-set settings-steps';

  for (const [key, label] of [['auto', 'Auto'], ['manager', 'Auto-Manager']]) {

    const b = document.createElement('button');

    b.type = 'button';

    b.className = 'pri-step' + (key === mode ? ' on' : '');

    b.textContent = label;

    b.addEventListener('click', () => saveConfig({ mode: key }));

    mrow.append(b);

  }



  const h = document.createElement('h2');

  h.textContent = 'Agents running at once';

  const p = document.createElement('p');

  p.className = 'settings-help';

  p.textContent = 'Cards in Queue start automatically while fewer than this many agents are running. ' +

    'Set it to 0 to stop the board starting anything on its own.';



  const row = document.createElement('div');

  row.className = 'pri-set settings-steps';

  for (let n = 0; n <= 10; n++) {

    const b = document.createElement('button');

    b.type = 'button';

    b.className = 'pri-step' + (n === max ? ' on' : '');

    b.textContent = n;

    b.addEventListener('click', () => saveConfig({ maxConcurrentAgents: n }));

    row.append(b);

  }



  const now = document.createElement('p');

  now.className = 'settings-now';

  now.textContent = mode === 'manager'

    ? 'Auto-Manager is on — the manager starts cards, this limit is not applied.'

    : max === 0

      ? 'Auto-spawn is off — Queue is a staging column.'

      : state.slotsFree + ' of ' + max + ' free right now.';



  wrap.append(mh, mp, mrow, h, p, row, now);

  el.screenBody.append(wrap);

}



function note(text) {

  const p = document.createElement('p');

  p.className = 'screen-note';

  p.textContent = text;

  return p;

}



function fmtTaskTime(value) {

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? fmtWhen(ms) : 'unknown';

}



const taskDateFmt = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

const taskTimeFmt = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit' });



function fmtTaskDate(task) {

  if (task.timeKnown && Number.isFinite(Date.parse(task.time))) return taskDateFmt.format(new Date(task.time));

  return task.date || 'Unknown';

}



function fmtTaskClock(value) {

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? taskTimeFmt.format(new Date(ms)) : 'Unknown';

}



function taskSortValue(task, key) {

  if (key === 'date') return Date.parse((task.date || '0000-01-01') + 'T00:00:00+12:00') + (task.seq || 0);

  if (key === 'time') return task.timeKnown && Number.isFinite(Date.parse(task.time))

    ? Number(fmtTaskClock(task.time).replace(/\D/g, ''))

    : -1;

  if (key === 'usage') return taskUsage(task)?.tokens ? taskUsage(task).tokens.total : -1;

  return String(key === 'assignedTo' ? task.assignedTo || 'Unknown' : task[key] || '').toLowerCase();

}



function taskUsage(task) {

  return task.id ? managerTasks.usage?.[task.id] : null;

}



function fmtNum(n) {

  return Number.isFinite(n) ? n.toLocaleString('en-NZ') : 'Unknown';

}



function fmtTaskUsage(task) {

  const u = taskUsage(task);

  if (!u || !u.tokens) return 'Unknown';

  const flags = [u.shared ? 'shared separate' : '', u.pending ? 'pending final' : '', u.ambiguous ? 'ambiguous' : '', u.interrupted ? 'interrupted' : '', u.unknown ? 'partial coverage' : ''].filter(Boolean);

  return fmtNum(u.tokens.total) + (flags.length ? ' · ' + flags.join(', ') : '');

}



function formatAgentUsage(a) {

  const t = a.tokens;

  const parts = [

    a.role || 'unknown role',

    a.model || 'unknown model',

    a.sessionId || 'unknown session',

    a.status || 'unknown',

  ];

  if (a.shared) parts.push('shared attribution');

  const usage = t

    ? `total ${fmtNum(t.total)}; uncached ${fmtNum(t.uncachedInput)}; cached ${fmtNum(t.cachedInput)}; output ${fmtNum(t.output)}`

    : 'usage unknown';

  return parts.join(' · ') + ' — ' + usage;

}



function sortedManagerTasks() {

  const mul = managerTaskSort.dir === 'asc' ? 1 : -1;

  return [...managerTasks.tasks].sort((a, b) => {

    const av = taskSortValue(a, managerTaskSort.key);

    const bv = taskSortValue(b, managerTaskSort.key);

    return (av > bv ? 1 : av < bv ? -1 : ((a.id || '').localeCompare(b.id || ''))) * mul;

  });

}



async function loadManagerTasks() {

  if (MOCK) {

    managerTasks = {

      loading: false, error: '', generatedAt: new Date().toISOString(), source: 'mock',

      usage: { 'REQ-20260910-016': { tokens: { total: 12000, uncachedInput: 2000, cachedInput: 8000, output: 2000 }, sharedTokens: null, unknown: 0, agents: [{ role: 'manager', model: 'gpt-5.5', sessionId: 'mock', status: 'complete', tokens: { total: 12000, uncachedInput: 2000, cachedInput: 8000, output: 2000 } }] } },

      tasks: [

        { id: 'REQ-20260910-016', date: '2026-09-10', seq: 16, timeKnown: false, project: 'Kanban', description: 'read-only Manager Tasks page', assignedTo: 'kanban-observer', status: 'working' },

        { id: 'REQ-20260910-018', date: '2026-09-10', seq: 18, timeKnown: false, project: 'Kanban', description: 'Restore automatic board progression', assignedTo: 'Manager', status: 'handed off' },

      ]

    };

    if (view === 'tasks') renderScreen();

    return;

  }

  managerTasks = { ...managerTasks, loading: true, error: '' };

  if (view === 'tasks') renderScreen();

  try {

    const r = await fetch('/api/manager-tasks');

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'could not load manager tasks');

    managerTasks = { loading: false, error: '', tasks: j.tasks || [], generatedAt: j.generatedAt, source: j.source || '', usage: j.usage || {} };

  } catch (err) {

    managerTasks = { ...managerTasks, loading: false, error: String(err.message || err) };

  }

  if (view === 'tasks') renderScreen();

}



async function saveConfig(patch) {

  try {

    const r = await fetch('/api/config', {

      method: 'POST', headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify(patch)

    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'could not save settings');

    if (state.config) Object.assign(state.config, j.config);

    toast('agentSettings' in patch
      ? 'Future agent settings saved'
      : 'mode' in patch

      ? (j.config.mode === 'manager' ? 'Auto-Manager mode on' : 'Auto mode on')

      : 'Agent limit set to ' + j.config.maxConcurrentAgents);

    renderScreen();

  } catch (err) {

    toast(String(err.message || err));

  }

}



el.breakerReset.addEventListener('click', async () => {

  if (!(await ask('Reset the circuit breaker and resume auto-spawn?'))) return;

  try {

    const r = await fetch('/api/breaker-reset', { method: 'POST' });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'could not reset breaker');

    state.breakerTripped = false;

    if (state.config) state.config.maxConcurrentAgents = j.config.maxConcurrentAgents;

    toast('circuit breaker reset');

    render();

  } catch (err) {

    toast(String(err.message || err));

  }

});



el.burger.addEventListener('click', () => (el.menu.hidden ? openMenu() : closeMenu()));

el.scrim.addEventListener('click', closeMenu);

el.screenClose.addEventListener('click', () => setView('board'));

document.querySelectorAll('.menu-item').forEach(b =>

  b.addEventListener('click', () => setView(b.dataset.view)));



/* --------------------------------------------------------------- collapse */



// Which lanes are collapsed, per project, so the shape of your board survives a

// reload. localStorage rather than the server: this is a view preference, not

// state any agent should ever see.

const COLLAPSE_KEY = 'herdr-kanban.collapsed.' + PROJECT;



function readCollapsed() {

  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || []); }

  catch { return new Set(); }

}



let collapsed = readCollapsed();



const mobileBoard = () => matchMedia('(max-width: 760px)').matches;



function toggleLane(key) {

  if (mobileBoard()) return;

  if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);

  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* private mode */ }

  render();

}



const CHEVRON = '<svg class="lane-chev" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3l4 4-4 4"/></svg>';

function laneNode(col, cards) {
  const lane = document.createElement('div');
  const isShut = collapsed.has(col.key) && !mobileBoard();
  lane.className = 'lane' + (col.key === selectedStage ? ' selected' : '') +
    (isShut ? ' collapsed' : '') + (cards.length ? '' : ' vacant');
  lane.dataset.key = col.key;

  const head = document.createElement('button');
  head.className = 'lane-head';
  head.type = 'button';
  head.setAttribute('aria-expanded', String(!isShut));
  // Collapsed strips hide the label, so the tooltip is the only place the stage
  // name survives — always name it, and say what the count is counting.
  head.title = (isShut ? 'Expand ' : 'Collapse ') + col.label + ' — ' +
    cards.length + ' card' + (cards.length === 1 ? '' : 's');
  head.innerHTML = '<span class="lane-label">' + CHEVRON + '<span class="lane-name"></span></span><span class="count"></span>';
  head.querySelector('.lane-name').textContent = col.label;
  head.querySelector('.count').textContent = cards.length;
  head.addEventListener('click', () => toggleLane(col.key));

  const body = document.createElement('div');
  body.className = 'lane-body';
  fillBody(body, col.key, cards);

  lane.append(head, body);
  wireDrop(lane, col.key);
  return lane;
}

function fillBody(body, key, cards) {
  if (!cards.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = EMPTY_LABEL;
    body.append(e);
  } else cards.forEach(c => body.append(cardNode(c)));
}



// Crossing the board to reach Review used to light up every column on the way,

// so five lanes claimed a card only one of them was getting. A column only

// becomes the target once the card has actually settled over it.

const DWELL_MS = 150;



function wireDrop(node, key) {

  let dwell = null;

  const clear = () => { clearTimeout(dwell); dwell = null; node.classList.remove('over'); };

  node.addEventListener('dragover', e => {

    e.preventDefault();

    e.dataTransfer.dropEffect = 'move';

    if (dwell === null && !node.classList.contains('over')) {

      dwell = setTimeout(() => node.classList.add('over'), DWELL_MS);

    }

  });

  node.addEventListener('dragleave', e => { if (!node.contains(e.relatedTarget)) clear(); });

  node.addEventListener('drop', e => {

    e.preventDefault();

    clear();

    move(e.dataTransfer.getData('text/plain'), key);

  });

}



function renderSlots() {
  const cap = state.config?.maxConcurrentAgents ?? 0;
  const count = document.createElement('b');
  count.textContent = `${cap - (state.slotsFree ?? cap)} / ${cap}`;
  el.slots.replaceChildren('Builders ', count);
  el.slots.title = 'Builder slots in use. Slots count live Builder assignments and startup reservations. Idle sessions do not imply token use. Missing sessions do not occupy a live slot.';
}



function renderReviewBtn() {

  if (view !== 'board') {

    el.reviewBtn.hidden = true;

    return;

  }

  const n = (state.board.review || []).length;

  el.reviewBtn.hidden = n === 0;

  el.reviewBtn.textContent = 'Review ' + n + ' card' + (n === 1 ? '' : 's');

  el.reviewBtn.title = 'One ' + (state.config?.reviewModel || 'reviewer') + ' agent reads all of them in a single pass';

}



function renderArchiveBtn() {

  if (view !== 'board') {

    el.archiveBtn.hidden = true;

    el.archiveCancel.hidden = true;

    return;

  }

  const n = (state.board.completed || []).length;

  if (!n && picking) stopPicking();   // last card filed elsewhere: nothing left to pick

  el.archiveBtn.hidden = n === 0;

  el.archiveBtn.textContent = picking

    ? 'Confirm' + (picked.size ? ' ' + picked.size : '')

    : 'Archive';

  el.archiveBtn.classList.toggle('primary', picking);

  el.archiveBtn.title = picking

    ? 'File the ticked cards into Archive'

    : 'Pick which finished cards to file into Archive';

  el.archiveCancel.hidden = !picking || n === 0;

}



function renderSweepBtn() {

  if (view !== 'board') {

    el.sweepBtn.hidden = true;

    return;

  }

  const n = (state.board.issues || []).length;

  el.sweepBtn.hidden = n === 0;

  el.sweepBtn.textContent = 'Sweep ' + n + ' issue' + (n === 1 ? '' : 's');

  el.sweepBtn.title = 'One ' + (state.config?.sweepModel || 'sweeper') + ' agent fixes or hands each one back in a single pass';

}



// Switching project is a full page load: every timer, the SSE stream and the

// drawer are all scoped to one project, and a reload is cheaper than unwinding

// them by hand.

async function loadProjects() {

  if (MOCK) return;

  try {

    const r = await fetch('/api/projects');

    const j = await r.json();

    el.project.innerHTML = '';

    (j.projects || [PROJECT]).forEach(p => {

      const o = document.createElement('option');

      o.value = p;

      o.textContent = p + ((j.open || []).includes(p) ? ' •' : '');

      o.selected = p === PROJECT;

      el.project.append(o);

    });

  } catch { /* leave whatever render() put there */ }

}



el.project.addEventListener('change', () => {

  location.search = '?project=' + encodeURIComponent(el.project.value) + (view === 'audits' ? '&view=audits' : '');

});



const MOBILE_ORDER = ['pou', 'working', 'queue', 'issues', 'owner', 'review', 'completed', 'planned', 'planning'];

let selectedStage = '';



function mobileColumns() {

  return state.columns.slice().sort((a, b) => {

    const ai = MOBILE_ORDER.indexOf(a.key);

    const bi = MOBILE_ORDER.indexOf(b.key);

    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);

  });

}



function renderStagePick() {

  const current = el.stage.value;

  el.stage.innerHTML = '';

  const cols = mobileColumns();

  if (!selectedStage || !cols.some(c => c.key === selectedStage)) selectedStage = cols[0]?.key || '';

  cols.forEach(col => {

    const o = document.createElement('option');

    o.value = col.key;

    o.textContent = col.label + ' (' + (state.board[col.key] || []).length + ')';

    el.stage.append(o);

  });

  selectedStage = current && cols.some(c => c.key === current) ? current : selectedStage;

  el.stage.value = selectedStage;

}



function selectStage(key) {

  selectedStage = key;

  el.lanes.querySelectorAll('.lane').forEach(lane => {

    const on = lane.dataset.key === key;

    lane.classList.toggle('selected', on);

    if (on) {

      lane.querySelector('.lane-body')?.scrollTo({ top: 0 });

      el.lanes.scrollTop = 0;

    }

  });

}



el.stage.addEventListener('change', () => {

  selectStage(el.stage.value);

});



// Agent status arrives every 2s. Rebuilding the lanes on each one threw away

// scroll position (and hover, and any drag in flight), so the DOM is only rebuilt

// when the cards themselves actually changed.

function boardSignature() {

  const cols = [...state.columns.map(c => c.key), 'archive'];

  return cols.map(k => k + ':' + (state.board[k] || [])

      .map(c => c.id + c.priority + c.mtime + (c.autoReview ? '!' : '')).join(',')).join('|') +

    '#' + [...collapsed].sort().join(',') +

    '#' + [...spawning].sort().join(',') +

    '#' + (picking ? 'pick:' + [...picked].sort().join(',') : '') +

    '#' + reviewing.join(',') +

    '#' + Object.entries(state.stageIndicators || {}).map(([id, v]) => id + v.status + v.reason).sort().join('|') +

    '#' + Object.entries(state.retries || {}).map(([k, v]) => k + v.attempts).sort().join(',');

}



// Stall state is time-based, so it moves without the board changing.

function refreshCardStates() {
  el.lanes.querySelectorAll('.card').forEach(node => {
    const hit = findCard(node.dataset.id);
    if (hit) paintStatus(node, hit.card);
  });
}



let laneSig = null;



const PAUSE_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 3v8M9 3v8"/></svg>';
const START_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 2.5l7 4.5-7 4.5z"/></svg>';

function render() {
  dependencyHover.reset();
  const status = document.getElementById('project-status');
  status.textContent = projectPaused() ? 'Paused' : 'Running';
  status.classList.toggle('paused', projectPaused());
  const projectAction = projectPaused() && !explicitCardRunning() ? 'Start' : 'Pause';
  const projectButton = document.getElementById('project-control');
  document.getElementById('project-control-label').textContent = projectAction;
  document.getElementById('project-control-icon').innerHTML = projectAction === 'Start' ? START_ICON : PAUSE_ICON;
  projectButton.classList.toggle('primary', projectAction === 'Start');
  projectButton.setAttribute('aria-label', projectAction);
  projectButton.title = projectAction + ' project: ' + PROJECT;

  if (!state) return;



  // A reviewer starts only after an explicit click. Agent names are optional in

  // herdr's list payload, so use them only to recover state after a reload.

  const reviewerLive = (state.agents || []).some(a => /^(?:kb-review-|[ra]-(?:t-\d+|[a-z]{1,3}\d+)(?:-\d+)?$)/.test(a.name || ''));

  if (reviewerLive && !reviewing.length) {

    reviewing = (state.board.review || []).map(c => c.id);

  } else if (!reviewerLive && reviewing.length) {

    reviewing = []; // reviewer gone (finished or crashed) — nothing left to flash

  }



  // Drop a card from the queue the moment it actually leaves Review — the reviewer

  // moves cards one at a time, so the "active" flash hands off to the next card in

  // line one at a time too, not all at once when the whole batch finishes.

  if (reviewing.length) {

    const stillInReview = new Set((state.board.review || []).map(c => c.id));

    reviewing = reviewing.filter(id => stillInReview.has(id));

  }



  if (!el.project.options.length) {

    el.project.innerHTML = '<option>' + state.project + '</option>';

  }

  renderBreaker();

  renderSlots();

  renderReviewBtn();

  renderSweepBtn();

  renderArchiveBtn();

  renderAgents();

  renderStagePick();



  const sig = boardSignature();

  if (sig === laneSig) {

    // Nothing moved — only agent state ticked. Leave the DOM, and the scroll

    // position, exactly where the user left them.

    state.columns.forEach(col => {

      const n = el.lanes.querySelector('.lane[data-key="' + col.key + '"] .count');

      if (n) n.textContent = (state.board[col.key] || []).length;

    });

    refreshCardStates();

  } else {

    laneSig = sig;



    // A rebuild is unavoidable when cards actually move, so carry the scroll

    // offsets across it rather than dumping the user back at the top.

    const scrolls = {};

    el.lanes.querySelectorAll('.lane').forEach(l => {

      const body = l.querySelector('.lane-body');

      if (body) scrolls[l.dataset.key] = body.scrollTop;

    });



    el.lanes.innerHTML = '';

    state.columns.forEach(col => el.lanes.append(laneNode(col, state.board[col.key] || [])));



    el.lanes.querySelectorAll('.lane').forEach(l => {

      const body = l.querySelector('.lane-body');

      if (body && scrolls[l.dataset.key]) body.scrollTop = scrolls[l.dataset.key];

    });

  }



  el.menuArchive.textContent = (state.board.archive || []).length;

  el.menuAgents.textContent = visibleAgents().length;

  el.menuTasks.textContent = managerTasks.tasks.length;



  if (view !== 'board') renderScreen();

  if (openId) renderDrawer();

}



function visibleAgents() {
  const finished = new Set(Object.entries(state.workflow || {}).filter(([id, value]) => value.completedStage && !state.bindings?.[id]).map(([, value]) => value.builder?.pane_id));
  const agents = (state.agents || []).filter(a => a.agent_status !== 'done' && !(a.agent_status === 'idle' && finished.has(a.pane_id)));
  const present = new Set((state.agents || []).map(a => a.pane_id));
  for (const [id, binding] of Object.entries(state.bindings || {})) {
    if (!present.has(binding.pane_id)) agents.push({ ...binding, name: `${id} missing session`, agent_status: binding.spawning && Date.now() - Date.parse(binding.started) < 300000 ? 'starting' : 'missing' });
  }
  return agents;
}
async function openAgent(agent) {
  try {
    const response = await fetch('/api/agent-open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: PROJECT, paneId: agent.pane_id }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
  } catch (error) { toast(error.message); }
}
// The header only says when herdr itself is down; the Agents page lists agents.
function renderAgents() {
  el.agents.replaceChildren();
  if (state.herdrUp) return;
  const m = document.createElement('span');
  m.className = 'bar-msg';
  m.textContent = 'herdr is not running — no agent status available.';
  m.title = m.textContent;
  el.agents.append(m);
}



// Persistent, not a toast — a toast disappears and this must stay visible

// until a human resets it, since nothing will clear it on its own.

function renderBreaker() {

  const tripped = !!state.breakerTripped;

  el.breakerBanner.hidden = !tripped;

  if (!tripped) return;

  el.breakerMsg.textContent = 'Auto-spawn halted — circuit breaker tripped (' +

    (state.breakerReason || 'too many spawns') + '). Builders and the reviewer will not start until reset.';

}



/* ----------------------------------------------------------------- move */



function findCard(id) {

  for (const key of Object.keys(state.board)) {

    const i = state.board[key].findIndex(c => c.id === id);

    if (i >= 0) return { key, i, card: state.board[key][i] };

  }

  return null;

}



function ask(msg) {

  el.dlgMsg.textContent = msg;

  el.dlg.showModal();

  return new Promise(res => el.dlg.addEventListener('close', () => res(el.dlg.returnValue === 'run'), { once: true }));

}



// Dropping into Working means "start an agent on this card", not just a move.

async function spawn(hit) {

  const id = hit.card.id;

  const model = state.config?.model || 'sonnet';

  if (!await ask('Run ' + id + ' with ' + model + ' in a new herdr window?')) return;



  spawning.add(id);

  state.board[hit.key].splice(hit.i, 1);

  hit.card.column = 'working';

  state.board.working.push(hit.card);

  render();



  if (MOCK) { setTimeout(() => { spawning.delete(id); render(); }, 2000); return; }

  try {

    const r = await fetch('/api/spawn', {

      method: 'POST', headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ project: PROJECT, id })

    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'spawn failed (' + r.status + ')');

    if (j.binding) (state.bindings = state.bindings || {})[id] = j.binding;

  } catch (err) {

    const back = findCard(id);

    if (back) state.board[back.key].splice(back.i, 1);

    hit.card.column = hit.key;

    state.board[hit.key].splice(hit.i, 0, hit.card);

    toast(String(err.message || err));

  } finally {

    spawning.delete(id);

    render();

  }

}



const LANE_LABEL = { pou: 'Pou', owner: 'Owner', planning: 'Planning', planned: 'Planned', queue: 'Queue', working: 'Working', issues: 'Issues', review: 'Review', completed: 'Completed', archive: 'Archive' };
async function operatorAction(op, id, button) {
  if (MOCK) return toast('mock: would ' + op + ' ' + id);
  button.disabled = true;
  try {
    const r = await fetch('/api/' + op, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: PROJECT, id })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || op + ' failed (' + r.status + ')');
    const lane = LANE_LABEL[j.card?.column] || j.card?.column;
    toast(op === 'approve' ? id + ' approved' + (j.investigation ? ' (investigation)' : '') + ', back to ' + lane
      : j.held ? id + ' moved to Completed with operator PASS; archives after integration (held: ' + j.held + ')'
      : id + ' finished and archived', j.held ? 'info' : undefined);
  } catch (err) {
    button.disabled = false;
    toast(String(err.message || err));
  }
}

async function move(id, to) {

  const hit = id && findCard(id);

  if (!hit || hit.key === to || spawning.has(id)) return;

  if (to === 'working') return spawn(hit);



  // optimistic

  state.board[hit.key].splice(hit.i, 1);

  hit.card.column = to;

  state.board[to].push(hit.card);

  render();



  if (MOCK) return;

  try {

    const r = await fetch('/api/move', {

      method: 'POST', headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ project: PROJECT, id, to })

    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'move failed (' + r.status + ')');

    if (j.card) Object.assign(hit.card, j.card);

    render();

  } catch (err) {

    const back = findCard(id);

    if (back) {

      state.board[back.key].splice(back.i, 1);

      hit.card.column = hit.key;

      state.board[hit.key].splice(hit.i, 0, hit.card);

    }

    render();

    toast(String(err.message || err));

  }

}



/* --------------------------------------------------------------- drawer */



function fmtDur(ms) {

  const s = Math.floor(ms / 1000);

  if (s < 60) return s + 's';

  const m = Math.floor(s / 60);

  return m < 60 ? m + 'm ' + (s % 60) + 's' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';

}



let paneText = '';



function row(dl, k, v) {

  const dt = document.createElement('dt'); dt.textContent = k;

  const dd = document.createElement('dd'); dd.textContent = v;

  dl.append(dt, dd);

}



function fmtWhen(ms) {

  const d = new Date(ms);

  const today = new Date().toDateString() === d.toDateString();

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return today ? 'today ' + time : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;

}



// Every card on the board, whatever column it is in. Blockers point at ids, and an

// id can be anywhere — the card you are waiting on is usually NOT in your column.

function allCards() {

  return Object.values(state?.board || {}).flat();

}



// A blocker only counts as met once the card has actually landed in Archive.

// Anything else — Completed included — is still a card you are genuinely waiting on.

// Mirrors unmetBlockers() in lib/autospawn.mjs;

// keep the two in step.

const LANDED = new Set(['archive']);



function gatingRows(dl, card) {

  const cards = allCards();

  const by = (id) => cards.find(c => c.id === id);

  const describe = (id) => {

    const c = by(id);

    if (!c) return id + ' (not on the board)';

    return id + ' — ' + c.column + (LANDED.has(c.column) ? ' ✓' : '');

  };



  const waits = card.blockedBy || [];

  if (waits.length) {

    const unmet = waits.filter(id => !LANDED.has(by(id)?.column));

    row(dl, unmet.length ? 'Gated by' : 'Was gated by', waits.map(describe).join(', '));

    if (unmet.length) {

      const dd = dl.lastElementChild;

      dd.classList.add('gated');

    }

  }



  // The reverse edge, which no card records about itself: who is stuck behind this

  // one. This is the number that says whether a stalled card matters.

  const blocking = cards.filter(c => (c.blockedBy || []).includes(card.id));

  if (blocking.length) {

    row(dl, 'Holding up', blocking.map(c => c.id + ' — ' + c.column).join(', '));

    if (!LANDED.has(card.column)) dl.lastElementChild.classList.add('blocking');

  }

}



// Drawer state that must survive the re-render on every agent tick.
let usageOpen = false;
let overrideOpen = false;

const ASK_KINDS = /^(Needs you|Kicked back|Spawn failed|Review feedback)\b[\s:·—–-]*/;

function drawerSection(title, cls) {
  const s = document.createElement('section');
  if (cls) s.className = cls;
  const h = document.createElement('h3');
  h.textContent = title;
  s.append(h);
  return s;
}

function renderDrawer() {
  if (!openId || !state) return;
  const hit = findCard(openId);
  if (!hit) return closeDrawer();
  const card = hit.card;
  const bind = state.bindings?.[openId] || null;
  const agent = agentForCard(card, state.agents);
  const stalled = stallMs(card);

  el.drawerId.textContent = card.id;
  el.drawerTitle.textContent = card.title;
  document.getElementById('drawer-history').href = '/api/card-history?project=' + encodeURIComponent(PROJECT) + '&id=' + encodeURIComponent(card.id);

  // Lane, then what the card is doing: "Owner · waiting on you".
  const lane = LANE_LABEL[card.column] || card.column;
  const status = cardStatus(card);
  const said = status?.text || '';
  el.drawerStatus.textContent = !status ? lane : said.startsWith(lane) ? said
    : lane + ' · ' + (/^[A-Z][a-z]/.test(said) ? said[0].toLowerCase() + said.slice(1) : said);
  el.drawerStatus.className = 'drawer-status' + (status ? ' tone-' + status.tone : '');
  el.drawerStatus.title = status?.title || el.drawerStatus.textContent;

  // Filing a finished card is the one thing you come to this drawer to do, so it
  // gets the primary slot — and only appears once the card is actually finished.
  el.drawerArchive.hidden = card.column !== 'completed' || !!card.mission || card.cardOwned;

  // Owner and Issues are the two columns nothing moves out of on its own, so
  // they are the two that get a one-click way back into the run.
  // A Working card with nothing running on it is stuck; requeuing is the fix.
  const handedBack = ['pou', 'owner', 'issues'].includes(card.column) || orphaned(card);
  el.drawerQueue.hidden = !handedBack;

  // Keep the terminal tail where the user put it.
  const oldPane = document.getElementById('pane');
  const paneScroll = oldPane ? oldPane.scrollTop : 0;
  const paneAtEnd = oldPane ? oldPane.scrollHeight - oldPane.scrollTop - oldPane.clientHeight < 24 : true;

  el.drawerBody.innerHTML = '';

  // ---- More menu: run this card, and the legacy auto-review marker.
  const cardRun = (state.cardRuns || []).filter(r => r.cardId === card.id).at(-1);
  const runBox = document.createElement('div');
  runBox.className = 'card-run-control';
  const runStatus = document.createElement('p');
  runStatus.setAttribute('role', 'status');
  const runReason = state.cardRunEligibility?.[card.id] || '';
  const planningRecovery = state.plannerRecoveryCards?.includes(card.id);
  const recoveryRunNote = 'Planning recovery only: preserve saved work and stop after the corrected plan for inspection; no Builder or Reviewer starts.';
  runStatus.textContent = cardRun ? cardRun.status + ': ' + cardRun.reason + ' · Auto-review ' + (cardRun.autoReview ? 'on' : 'off') + ' at authorization.' : runReason || (planningRecovery ? recoveryRunNote : 'Runs only this card; all other work stays paused.');
  const runButton = document.createElement('button');
  runButton.type = 'button'; runButton.className = 'btn';
  const cancelling = cardRun?.status === 'running';
  runButton.textContent = cancelling ? 'Cancel card run' : 'Run this card';
  runButton.disabled = !cancelling && (!state.cardRunEligibility || !!runReason);
  runButton.title = cancelling ? 'Stop further prompts; let the current turn finish' : runReason || (planningRecovery ? recoveryRunNote : card.autoReview ? 'Run through independent Review, then stop' : 'Run until ready for review; no Reviewer will start');
  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    try {
      const response = await fetch('/api/card-run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: PROJECT, id: card.id, requestId: crypto.randomUUID(), cancel: cancelling }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Card run request failed');
      runStatus.textContent = cancelling ? 'Cancelled; current turn may finish.' : 'Authorized; awaiting eligible stage.';
    } catch (err) { runStatus.textContent = err.message; runButton.disabled = false; }
  });
  runBox.append(runButton, runStatus);
  // Auto-review is a marker inside the card file, so this toggle rewrites the
  // card — it is not board-only state.
  const ar = document.createElement('label');
  ar.className = 'auto-review';
  const arBox = document.createElement('input');
  arBox.type = 'checkbox';
  arBox.checked = !!card.autoReview;
  arBox.addEventListener('change', () => setAutoReview(card.id, arBox.checked));
  ar.append(arBox, document.createTextNode(' Move legacy Completed cards to Review automatically'));
  el.drawerMoreMenu.replaceChildren(runBox, ar);

  // ---- The agent's own words on what it needs: the one thing you have to read.
  // Handover notes only mean something where the card still waits on someone.
  const askIsLive = card.ask && (['pou', 'owner', 'issues'].includes(card.column) || orphaned(card));
  if (askIsLive) {
    // The parser can hand back "Kind: first clause" as the kind; the heading is
    // only the kind, and everything after it is the body.
    const m = ASK_KINDS.exec(card.ask.kind || '');
    const kind = m ? m[1] : card.ask.kind;
    const rest = m ? card.ask.kind.slice(m[0].length) : '';
    const mine = kind === 'Needs you';
    const box = drawerSection(mine ? 'What needs to be done' : kind, 'ask' + (mine ? ' mine' : ''));
    const p = document.createElement('p');
    p.textContent = (rest ? rest + ': ' : '') + card.ask.text;
    box.append(p);
    el.drawerBody.append(box);
  }

  const recoveryNotice = state.workflow?.[card.id]?.operational?.reason || state.workflow?.[card.id]?.limitWarning;
  if (recoveryNotice) {
    const notice = document.createElement('p');
    notice.className = 'drawer-stall';
    notice.textContent = recoveryNotice;
    el.drawerBody.append(notice);
  }
  if (stalled) {
    const s = document.createElement('p');
    s.className = 'drawer-stall';
    s.textContent = 'Stalled — agent has been ' + (agent ? agent.agent_status : 'quiet') + ' for ' + fmtDur(stalled) + '.';
    el.drawerBody.append(s);
  }

  // ---- Details
  const details = drawerSection('Details');
  const dl = document.createElement('dl');
  dl.className = 'drawer-dl';
  // Priority is editable here because this is where you have the card's detail in
  // front of you; it writes straight back into the markdown.
  const pri = document.createElement('div');
  pri.className = 'pri-set';
  pri.setAttribute('role', 'group');
  pri.setAttribute('aria-label', 'Priority');
  for (let n = 0; n <= 10; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pri-step' + (n === card.priority ? ' on' : '');
    b.setAttribute('aria-pressed', String(n === card.priority));
    b.textContent = n;
    b.title = 'Set priority ' + n + '/10';
    b.addEventListener('click', () => setPriority(card.id, n));
    pri.append(b);
  }
  const pterm = document.createElement('dt');
  pterm.textContent = 'Priority';
  const pdef = document.createElement('dd');
  pdef.append(pri);
  dl.append(pterm, pdef);
  if (agent) {
    const model = bind?.model || agent.model;
    const running = bind?.started ? fmtDur(Date.now() - Date.parse(bind.started)) : fmtDur(heldMs(agent));
    row(dl, 'Agent', agent.name + ' · ' + agent.agent_status + (bind ? '' : ' (unbound match)') + (model ? ' · ' + model : '') + ' · running ' + running);
  } else {
    row(dl, 'Agent', bind ? 'bound to ' + (bind.name || bind.pane_id) + ' — pane not found' : 'none');
  }
  row(dl, 'Status', card.status || '—');
  row(dl, 'Surface', card.surface || '—');
  if (card.added) row(dl, 'Added', fmtWhen(card.added) + ' · ' + fmtDur(Date.now() - card.added) + ' ago');
  gatingRows(dl, card);
  const fterm = document.createElement('dt');
  fterm.textContent = 'File';
  const fdef = document.createElement('dd');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'file-open';
  open.textContent = card.file || '—';
  open.title = 'Open in VS Code';
  open.addEventListener('click', () => openInEditor(card.id));
  fdef.append(open);
  dl.append(fterm, fdef);
  details.append(dl);
  el.drawerBody.append(details);

  if (bind) {
    const term = drawerSection('Agent output');
    const pre = document.createElement('pre');
    pre.className = 'pane';
    pre.id = 'pane';
    pre.textContent = paneText || 'loading pane…';
    const stop = document.createElement('button');
    stop.className = 'btn danger';
    stop.textContent = 'Stop agent';
    stop.addEventListener('click', stopAgent);
    term.append(pre, stop);
    el.drawerBody.append(term);
    pre.scrollTop = paneAtEnd ? pre.scrollHeight : paneScroll;
  }

  // ---- Token usage: one row per run; shared runs fold into one muted row.
  const usage = state?.cardUsage?.[card.id];
  const usageBox = drawerSection('Token usage', 'card-usage');
  const sum = document.createElement('span');
  sum.className = 'usage-sum';
  sum.textContent = usage?.tokens ? fmtNum(usage.tokens.total) + ' recorded' + (usage.unknown ? ', partial' : '') : 'not yet verified';
  usageBox.firstChild.append(' · ', sum);
  const runs = usage?.agents || [];
  const runsTable = document.createElement('table');
  runsTable.className = 'usage-runs';
  const runsHead = runsTable.createTHead().insertRow();
  for (const label of ['Run', 'Model', 'Tokens']) {
    const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; runsHead.append(th);
  }
  const runsBody = runsTable.createTBody();
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : 'Unknown';
  const seen = {};
  for (const run of runs.filter(r => !r.shared)) {
    const k = seen[run.role] = (seen[run.role] ?? -1) + 1;
    const tr = runsBody.insertRow();
    tr.title = (run.name || 'Unknown agent') + ' · ' + (run.status || 'Unknown status');
    tr.insertCell().textContent = cap(run.role) + (k ? ' (rerun' + (k > 1 ? ' ' + k : '') + ')' : '');
    tr.insertCell().textContent = run.model || 'Unknown model';
    tr.insertCell().textContent = run.tokens ? fmtNum(run.tokens.total) : 'unverified';
  }
  const sharedBy = {};
  for (const run of runs.filter(r => r.shared)) (sharedBy[run.role || 'unknown'] ||= []).push(run);
  for (const [role, group] of Object.entries(sharedBy)) {
    const tr = runsBody.insertRow();
    tr.className = 'shared';
    tr.insertCell().textContent = group.length + ' ' + role + ' run' + (group.length === 1 ? '' : 's');
    tr.insertCell().textContent = [...new Set(group.map(r => r.model || 'Unknown model'))].join(', ');
    tr.insertCell().textContent = 'shared, not counted';
  }
  if (!runs.length) {
    const cell = runsBody.insertRow().insertCell(); cell.colSpan = 3; cell.className = 'tone-muted';
    cell.textContent = 'No recorded agent runs. Missing usage is not zero.';
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'link-btn';
  more.textContent = usageOpen ? 'Hide breakdown' : 'Show breakdown';
  more.setAttribute('aria-expanded', String(usageOpen));
  more.addEventListener('click', () => { usageOpen = !usageOpen; renderDrawer(); });
  usageBox.append(runsTable, more);
  if (usageOpen) usageBox.append(usageBreakdown(card, usage));
  el.drawerBody.append(usageBox);

  // ---- Agent override for new assignments, folded away until wanted.
  const override = document.createElement('details');
  override.className = 'card-settings';
  override.open = overrideOpen;
  override.addEventListener('toggle', () => { overrideOpen = override.open; });
  const summary = document.createElement('summary');
  summary.textContent = 'Agent override for new assignments';
  const grid = document.createElement('div');
  grid.className = 'override-grid';
  const stagePick = document.createElement('select');
  for (const [stage, label] of [['planning', 'Planner'], ['working', 'Builder'], ['review', 'Reviewer'], ['issues', 'Issues'], ['trivial', 'Trivial']]) { const o = document.createElement('option'); o.value = stage; o.textContent = label; stagePick.append(o); }
  const oe = document.createElement('select'), om = document.createElement('select'), or = document.createElement('select'), os = document.createElement('button');
  stagePick.setAttribute('aria-label', 'Stage'); oe.setAttribute('aria-label', 'Engine'); om.setAttribute('aria-label', 'Model'); or.setAttribute('aria-label', 'Reasoning');
  os.type = 'button'; os.className = 'btn'; os.textContent = 'Save override';
  const refreshOverride = () => {
    const stage = stagePick.value, current = card.agentSettings?.[stage] || state.config?.agentSettings?.[stage] || {}, catalog = state.config?.supportedAgentSettings || {};
    oe.replaceChildren(); for (const key of Object.keys(catalog)) { const o = document.createElement('option'); o.value = key; o.textContent = key; o.selected = key === current.engine; oe.append(o); }
    om.replaceChildren(); for (const name of catalog[oe.value]?.models || []) { const o = document.createElement('option'); o.value = name; o.textContent = name; o.selected = name === current.model; om.append(o); }
    or.replaceChildren(); for (const name of catalog[oe.value]?.reasoning || []) { const o = document.createElement('option'); o.value = name; o.textContent = name; o.selected = name === current.reasoning; or.append(o); }
  };
  refreshOverride(); stagePick.addEventListener('change', refreshOverride); oe.addEventListener('change', refreshOverride);
  os.addEventListener('click', async () => { try { const r = await fetch('/api/card-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: PROJECT, id: card.id, stage: stagePick.value, settings: { engine: oe.value, model: om.value, reasoning: or.value } }) }); const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || 'could not save override'); toast('Card override saved for new assignments'); } catch (err) { toast(err.message); } });
  grid.append(stagePick, oe, om, or, os);
  override.append(summary, grid);
  el.drawerBody.append(override);
}

// The full fresh / cached / output table, behind "Show breakdown".
function usageBreakdown(card, usage) {
  const wrap = document.createElement('div');
  wrap.className = 'usage-breakdown';
  const created = document.createElement('p');
  created.textContent = `Created: ${new Date(card.createdAt || card.added).toLocaleString()}`;
  const total = document.createElement('p');
  total.textContent = usage?.tokens ? `${fmtNum(usage.tokens.total)} processed tokens${usage.unknown ? ' — partial; unverified runs excluded' : ''}` : 'Usage not yet verified';
  wrap.append(created, total);
  if (!(usage?.agents || []).some(run => run.role === 'orchestrator')) {
    const intake = document.createElement('p');
    intake.textContent = 'Orchestrator intake usage is unmeasured and is not included in this agent total.';
    wrap.append(intake);
  }
  const scroll = document.createElement('div');
  scroll.className = 'usage-table-scroll'; scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Recorded token usage table; scroll horizontally for all columns');
  const table = document.createElement('table'); table.className = 'usage-table';
  table.setAttribute('aria-label', 'Recorded token usage by agent');
  const head = table.createTHead().insertRow();
  for (const [index, label] of ['Agent / role', 'Fresh input', 'Cached input', 'Output', 'Total', 'Attribution / status'].entries()) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label;
    if (index > 0 && index < 5) cell.className = 'usage-number';
    head.append(cell);
  }
  const appendTokenCells = (row, tokens) => {
    for (const key of ['uncachedInput', 'cachedInput', 'output', 'total']) {
      const cell = row.insertCell(); cell.className = 'usage-number';
      cell.textContent = tokens?.[key] == null ? '—' : fmtNum(tokens[key]);
    }
  };
  const body = table.createTBody();
  for (const run of usage?.agents || []) {
    const row = body.insertRow();
    const agent = document.createElement('th'); agent.scope = 'row';
    agent.textContent = `${run.name || 'Unknown agent'} · ${run.role || 'Unknown role'}`;
    const detail = document.createElement('span'); detail.className = 'usage-detail';
    detail.textContent = `${run.model || 'Unknown model'} · Started: ${run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Unknown'} · Finished: ${run.finishedAt ? new Date(run.finishedAt).toLocaleString() : 'Pending'}`;
    agent.append(detail); row.append(agent);
    appendTokenCells(row, run.tokens);
    row.insertCell().textContent = `${run.shared ? 'Shared — excluded from card total' : run.tokens ? 'Attributed to this card' : 'Missing / unverified — excluded'} · ${run.status || 'Unknown status'}`;
  }
  if (!usage?.agents?.length) {
    const cell = body.insertRow().insertCell(); cell.colSpan = 6;
    cell.textContent = 'No recorded agent runs. Missing usage is not zero.';
  }
  const footer = table.createTFoot().insertRow();
  const label = document.createElement('th'); label.scope = 'row'; label.textContent = 'Recorded card total'; footer.append(label);
  // Display the existing authoritative summary; never sum shared/unknown rows here.
  appendTokenCells(footer, usage?.tokens);
  footer.insertCell().textContent = usage?.tokens ? (usage.unknown ? 'Partial — shared / unverified runs excluded' : 'Recorded attributable runs only') : 'Unverified — not zero';
  scroll.append(table);
  wrap.append(scroll);
  return wrap;
}



async function pollPane() {

  if (!openId || !state?.bindings?.[openId]) return;

  if (MOCK) {

    paneText = '$ claude --model sonnet\n> reading vial-solver.js …\n> found division by zero at line 42\n(idle, waiting for input)';

  } else {

    try {

      const r = await fetch('/api/pane?project=' + encodeURIComponent(PROJECT) + '&id=' + encodeURIComponent(openId));

      const j = await r.json().catch(() => ({}));

      paneText = j.ok ? (j.output || '(no output)') : (j.error || 'pane unavailable');

    } catch { paneText = 'pane unavailable'; }

  }

  const pre = document.getElementById('pane');

  if (!pre) return;

  const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;

  const was = pre.scrollTop;

  pre.textContent = paneText;

  pre.scrollTop = atEnd ? pre.scrollHeight : was;

}



async function stopAgent() {

  const id = openId;

  if (MOCK) { delete state.bindings[id]; paneText = ''; render(); return; }

  try {

    const r = await fetch('/api/stop', {

      method: 'POST', headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ project: PROJECT, id })

    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'stop failed (' + r.status + ')');

    if (state.bindings) delete state.bindings[id];

    paneText = '';

    render();

  } catch (err) { toast(String(err.message || err)); }

}



async function setPriority(id, priority) {

  if (MOCK) { const h = findCard(id); if (h) h.card.priority = priority; return render(); }

  try {

    const r = await fetch('/api/priority', {

      method: 'POST', headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ project: PROJECT, id, priority })

    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'could not set priority');

  } catch (err) {

    toast(String(err.message || err));

    render();

  }

}



async function openInEditor(id, reportId) {

  if (MOCK) return toast('mock: would open in VS Code');

  try {

    const r = await fetch('/api/open', {

      method: 'POST', headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ project: PROJECT, ...(reportId ? { reportId } : { id }) })

    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'could not open the file');

  } catch (err) {

    toast(String(err.message || err));

  }

}



async function setAutoReview(id, on) {

  if (MOCK) { const h = findCard(id); if (h) h.card.autoReview = on; return render(); }

  try {

    const r = await fetch('/api/auto-review', {

      method: 'POST', headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ project: PROJECT, id, on })

    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'could not set auto-review');

    toast(id + (on ? ' will move legacy Completed work to Review automatically' : ' will remain in Completed until review is requested'));

  } catch (err) {

    toast(String(err.message || err));

    render(); // put the checkbox back where the card actually is

  }

}



// Computed fresh on click — never polled, never runs on its own. Shows the

// batch plan (postman route: cards sharing files review together) and lets

// the owner run the first batch; the rest follow on later clicks once the

// reviewer lock frees up, one at a time.

async function runReview() {

  const n = (state.board.review || []).length;

  if (!n) return;

  el.reviewBtn.disabled = true;

  let plan;

  try {

    const r = await fetch('/api/review-plan?project=' + encodeURIComponent(PROJECT));

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) throw new Error(j.error || 'could not compute review plan');

    plan = j;

  } catch (err) {

    el.reviewBtn.disabled = false;

    return toast(String(err.message || err));

  }

  if (!plan.batches.length) {

    el.reviewBtn.disabled = false;

    return toast('nothing ready to review' + (plan.heldBack.length ? ' — rest held back' : ''), 'info');

  }



  const lines = plan.batches.map((b, i) =>

    'Batch ' + (i + 1) + ' (' + b.estMinutes + 'm): ' + b.cards.join(', ') + ' — ' + b.reason);

  if (plan.heldBack.length) {

    lines.push('', 'Held back:');

    plan.heldBack.forEach(h => lines.push(h.card + ' waiting on ' + h.waitingOn + ' — ' + h.reason));

  }

  el.dlgMsg.style.whiteSpace = 'pre-line';

  el.dlgMsg.textContent = lines.join('\n');

  const runBtn = document.getElementById('spawn-run');

  const runLabel = runBtn.textContent;

  runBtn.textContent = 'Run next batch';

  el.dlg.showModal();

  const proceed = await new Promise(res =>

    el.dlg.addEventListener('close', () => res(el.dlg.returnValue === 'run'), { once: true }));

  runBtn.textContent = runLabel;

  el.dlgMsg.style.whiteSpace = '';

  if (!proceed) { el.reviewBtn.disabled = false; return; }



  const batch = plan.batches[0];

  el.reviewBtn.textContent = 'starting reviewer…';

  try {

    const r = await fetch('/api/review', {

      method: 'POST', headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ project: PROJECT, cardIds: batch.cards })

    });

    const j = await r.json().catch(() => ({}));

    // One reviewer at a time is the design, so clicking twice is a note, not a fault.

    if (r.status === 409) return toast(j.error || 'a reviewer is already running', 'info');

    if (!r.ok || !j.ok) throw new Error(j.error || 'reviewer failed to start');

    reviewing = batch.cards.slice();

    toast('reviewer running on ' + (j.reviewer?.cards || []).join(', '));

  } catch (err) {

    toast(String(err.message || err));

  } finally {

    el.reviewBtn.disabled = false;

    render();

  }

}



// One sweeper for the whole Issues column, not one per card.

async function runSweep() {

  const n = (state.board.issues || []).length;

  if (!n) return;

  if (!(await ask('Sweep all ' + n + ' issue' + (n === 1 ? '' : 's') +

      ' with ' + (state.config?.sweepModel || 'the sweeper') + ' in one pass?'))) return;

  el.sweepBtn.disabled = true;

  el.sweepBtn.textContent = 'starting sweeper…';

  try {

    const r = await fetch('/api/sweep-issues', {

      method: 'POST', headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ project: PROJECT })

    });

    const j = await r.json().catch(() => ({}));

    // One sweeper at a time is the design, so clicking twice is a note, not a fault.

    if (r.status === 409) return toast(j.error || 'a sweeper is already running', 'info');

    if (!r.ok || !j.ok) throw new Error(j.error || 'sweeper failed to start');

    toast('sweeper running on ' + (j.sweeper?.cards || []).join(', '));

  } catch (err) {

    toast(String(err.message || err));

  } finally {

    el.sweepBtn.disabled = false;

    render();

  }

}



function setMore(open) {
  el.drawerMoreMenu.hidden = !open;
  el.drawerMore.setAttribute('aria-expanded', String(open));
}

function openDrawer(id) {
  openId = id;
  paneText = '';
  setMore(false);
  el.drawer.hidden = false;
  el.drawerBackdrop.hidden = false;
  renderDrawer();
  clearInterval(paneTimer);
  pollPane();
  paneTimer = setInterval(pollPane, 3000);
}

function closeDrawer() {
  openId = null;
  setMore(false);
  el.drawer.hidden = true;
  el.drawerBackdrop.hidden = true;
  clearInterval(paneTimer);
  paneTimer = null;
}



el.drawerQueue.addEventListener('click', () => {

  const id = openId;

  if (!id) return;

  closeDrawer();

  move(id, 'queue');   // straight back into the run; the spawner picks it up

});

el.drawerArchive.addEventListener('click', () => {

  const id = openId;

  if (!id) return;

  closeDrawer();          // the card is leaving the column you were looking at

  move(id, 'archive');

});

el.reviewBtn.addEventListener('click', runReview);

el.sweepBtn.addEventListener('click', runSweep);

el.archiveBtn.addEventListener('click', async () => {

  if (!picking) { picking = true; render(); return; }

  const ids = [...picked];

  stopPicking();

  render();

  // One at a time: each move is its own optimistic update and its own rollback,

  // so one card failing to file does not take the rest of the batch with it.

  for (const id of ids) await move(id, 'archive');

  if (ids.length) toast('archived ' + ids.length + ' card' + (ids.length === 1 ? '' : 's'));

});

el.archiveCancel.addEventListener('click', () => { stopPicking(); render(); });

el.drawerClose.addEventListener('click', closeDrawer);
el.drawerBackdrop.addEventListener('click', closeDrawer);
el.drawerMore.addEventListener('click', () => setMore(el.drawerMoreMenu.hidden));
document.addEventListener('click', e => {
  if (!el.drawerMoreMenu.hidden && !e.target.closest('.more')) setMore(false);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || el.dlg.open) return;
  if (!el.drawerMoreMenu.hidden) { setMore(false); el.drawerMore.focus(); }
  else if (openId) closeDrawer();
  else if (!el.menu.hidden) closeMenu();
  else if (view !== 'board') setView('board');
});

document.getElementById('spawn-run').addEventListener('click', () => el.dlg.close('run'));

document.getElementById('spawn-cancel').addEventListener('click', () => el.dlg.close('cancel'));



/* ------------------------------------------------------------ transport */



function apply(payload) {

  trackStatuses(payload.agents);

  state = payload;

  render();

}



async function poll() {

  try { apply(await loadBoard()); setConn('live'); }

  catch { setConn('offline'); }

}



function connect() {

  const es = new EventSource('/api/events?project=' + encodeURIComponent(PROJECT));

  es.addEventListener('open', () => setConn('live'));

  es.addEventListener('board', e => { apply(JSON.parse(e.data)); setConn('live'); });

  es.addEventListener('agents', e => {

    const d = JSON.parse(e.data);

    if (!state) return;

    trackStatuses(d.agents);

    state.agents = d.agents;

    state.herdrUp = d.herdrUp;

    render();

  });

  es.addEventListener('error', () => setConn('reconnecting')); // EventSource retries itself

}



loadProjects();
if (new URLSearchParams(location.search).get('view') === 'audits') setView('audits');

poll();

if (!MOCK) {

  connect();

  setInterval(poll, 30000);      // fallback in case SSE dies silently

  setInterval(() => { if (view === 'tasks') loadManagerTasks(); }, 30000);

  setInterval(render, 15000);    // refresh stall timers

}

