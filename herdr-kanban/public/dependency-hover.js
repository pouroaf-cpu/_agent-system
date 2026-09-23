'use strict';

// Standalone presentation controller. It never changes cards or scheduling state.
globalThis.createDependencyHover = function ({ root, getBlockers, enabled }) {
  let timer = null, active = null, frame = null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('dependency-lines'); svg.setAttribute('aria-hidden', 'true');
  const announcement = document.createElement('span');
  announcement.className = 'dependency-announcement'; announcement.setAttribute('role', 'status');
  document.body.append(svg, announcement);
  const cards = () => [...root.querySelectorAll('.card')];
  function reset() {
    clearTimeout(timer); timer = null; active = null;
    cancelAnimationFrame(frame); frame = null;
    cards().forEach(card => card.classList.remove('dependency-focus', 'dependency-muted'));
    svg.replaceChildren(); announcement.textContent = '';
  }
  function center(node) {
    if (!node?.isConnected || !node.getClientRects().length) return null;
    const rect = node.getBoundingClientRect(), x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (style.visibility === 'hidden' || style.display === 'none') return null;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (x < bounds.left || x > bounds.right)) return null;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (y < bounds.top || y > bounds.bottom)) return null;
    }
    return { x, y };
  }
  function draw() {
    frame = null;
    if (!active || !enabled() || !active.isConnected) return reset();
    const all = cards(), ids = new Set(getBlockers(active.dataset.id));
    const targets = all.filter(card => card !== active && ids.has(card.dataset.id));
    const uniqueTargets = targets.filter(card => targets.filter(other => other.dataset.id === card.dataset.id).length === 1);
    const origin = center(active), visible = uniqueTargets.map(card => ({ card, point: center(card) })).filter(item => item.point);
    all.forEach(card => {
      card.classList.toggle('dependency-focus', card === active || uniqueTargets.includes(card));
      card.classList.toggle('dependency-muted', !!origin && visible.length > 0 && card !== active && !uniqueTargets.includes(card));
    });
    svg.replaceChildren();
    if (!origin) return;
    for (const { point } of visible) {
      const line = document.createElementNS(svg.namespaceURI, 'line');
      for (const [key, value] of Object.entries({ x1: origin.x, y1: origin.y, x2: point.x, y2: point.y })) line.setAttribute(key, value);
      svg.append(line);
    }
  }
  function start(card) {
    reset();
    if (!card || !enabled() || !getBlockers(card.dataset.id).length) return;
    timer = setTimeout(() => {
      timer = null;
      if (!enabled() || !card.isConnected) return;
      active = card;
      announcement.textContent = `${card.dataset.id} recorded blockers: ${getBlockers(card.dataset.id).join(', ')}. Offscreen or missing cards are not connected.`;
      draw();
    }, 1500);
  }
  const cardOf = node => node instanceof Element ? node.closest('.card') : null;
  root.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const card = cardOf(event.target);
    if (card && !card.contains(event.relatedTarget)) start(card);
  });
  root.addEventListener('pointerout', event => { const card = cardOf(event.target); if (card && !card.contains(event.relatedTarget)) reset(); });
  root.addEventListener('focusin', event => { const card = cardOf(event.target); if (card && !card.contains(event.relatedTarget)) start(card); });
  root.addEventListener('focusout', event => { const card = cardOf(event.target); if (card && !card.contains(event.relatedTarget)) reset(); });
  root.addEventListener('pointerdown', reset);
  root.addEventListener('dragstart', reset);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') reset(); });
  window.addEventListener('blur', reset);
  const realign = () => { if (active && frame === null) frame = requestAnimationFrame(draw); };
  document.addEventListener('scroll', realign, true);
  window.addEventListener('resize', realign);
  return { reset };
};
