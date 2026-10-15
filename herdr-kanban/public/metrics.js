const headings = ['NZ reporting period', 'Integrated', 'Archived', 'Finished', 'Kick-backs', '[planning]', '[implementation]', '[evidence]', '[operational]', 'Untagged', 'Delivery failed', 'No handoff', 'Planner failures', 'Stalls', 'Owner escalations', 'Kick-backs / finished']
const difficulties = ['tiny', 'easy', 'medium', 'hard']
headings.push(...difficulties.flatMap(d => [`${d} attempts`, `${d} kick-backs`]))
const stepHeadings = ['NZ day', 'Role', 'Group', 'Sessions', 'Unknown steps', 'Median steps', 'p90 steps', 'Median tokens']
const stepGroups = [['all', 'All'], ['child', 'Child of a split'], ['notSplit', 'Not split'], ['parent', 'Split parent']]
const summaryHeadings = ['Project', 'Newest day', 'Finished', 'Kick-backs / finished', 'Finished, last 7 days', 'Kick-backs, last 7 days', 'Go to']
// Days newer than this show by default; older days sit behind a "show older days" button.
const OPEN_DAYS = 2
// Which older-day groups the reader has opened, kept across the 5 second refresh.
const openOlder = new Set()
async function get(url) {
  const response = await fetch(url)
  const data = await response.json()
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}
const dayLabel = day => formatNZTime(day + 'T00:00:00Z') + ' – ' + formatNZTime(Date.parse(day + 'T00:00:00Z') + 86400000)
const anchorFor = (project, i) => 'project-' + i + '-' + project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const ratio = (kickBacks, finished) => finished ? (kickBacks / finished).toFixed(2) : '—'

// Rows for the newest OPEN_DAYS days go in the visible body; older days go in a second
// body that starts hidden behind a button. `days` is [{ day, rows: [[value, ...], ...] }], newest first.
function fillDays(table, labels, days, key) {
  const recent = table.createTBody()
  const older = table.createTBody()
  older.hidden = true
  days.forEach((entry, i) => {
    const target = i < OPEN_DAYS ? recent : older
    for (const values of entry.rows) {
      const tr = target.insertRow()
      values.forEach((value, j) => { const cell = tr.insertCell(); cell.textContent = value; cell.dataset.label = labels[j] })
    }
  })
  const hiddenDays = days.length - OPEN_DAYS
  if (hiddenDays <= 0) return null
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'older-toggle'
  const paint = () => {
    const open = openOlder.has(key)
    older.hidden = !open
    button.setAttribute('aria-expanded', String(open))
    button.textContent = open ? 'Hide older days' : `Show ${hiddenDays} older day${hiddenDays === 1 ? '' : 's'}`
  }
  button.addEventListener('click', () => { openOlder.has(key) ? openOlder.delete(key) : openOlder.add(key); paint() })
  paint()
  return button
}

function headerRow(table, labels) {
  const head = table.createTHead().insertRow()
  for (const label of labels) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = label
    head.append(cell)
  }
}

async function projectSection(project, i) {
  const section = document.createElement('section')
  section.id = anchorFor(project, i)
  const heading = document.createElement('h2')
  heading.textContent = project
  section.append(heading)
  const result = { project, anchor: section.id, metrics: null, section }
  try {
    const { metrics } = await get(`/api/metrics?project=${encodeURIComponent(project)}`)
    result.metrics = metrics
    const wrap = document.createElement('div')
    wrap.className = 'table-wrap'
    const table = document.createElement('table')
    table.setAttribute('aria-label', `${project} daily board health`)
    headerRow(table, headings)
    const days = metrics.map(row => ({
      day: row.day,
      rows: [[dayLabel(row.day), row.integrated, row.archived, row.finished, row.kickBacks.total,
        ...['planning', 'implementation', 'evidence', 'operational', 'untagged'].map(tag => row.kickBacks[tag]),
        row.builderDeliveryFailed, row.builderNoHandoff, row.plannerFailures, row.stalls, row.ownerEscalations,
        row.kickBacksPerFinishedCard == null ? '—' : row.kickBacksPerFinishedCard.toFixed(2),
        ...difficulties.flatMap(d => [row.builderDifficulty?.[d]?.attempts || 0, row.builderDifficulty?.[d]?.kickBacks || 0])]],
    }))
    wrap.append(table)
    section.append(wrap)
    const toggle = fillDays(table, headings, days, project + ':daily')
    if (toggle) section.append(toggle)
  } catch (error) {
    const message = document.createElement('p')
    message.textContent = `Could not load metrics: ${error.message}`
    section.append(message)
  }
  try {
    const { rollup } = await get(`/api/session-steps?project=${encodeURIComponent(project)}`)
    const wrap = document.createElement('div')
    wrap.className = 'table-wrap'
    const table = document.createElement('table')
    table.setAttribute('aria-label', `${project} steps per session`)
    headerRow(table, stepHeadings)
    const show = value => value == null ? '—' : value
    const days = rollup.map(row => ({
      day: row.day,
      rows: [['planner', 'Planner'], ['builder', 'Builder']].flatMap(([role, roleLabel]) => stepGroups.flatMap(([group, label]) => {
        const g = row[role][group]
        if (group !== 'all' && !g.sessions) return []
        return [[row.day, roleLabel, label, g.sessions, g.unknown, g.medianSteps, g.p90Steps, g.medianTokens].map(show)]
      })),
    }))
    wrap.append(table)
    section.append(wrap)
    const toggle = fillDays(table, stepHeadings, days, project + ':steps')
    if (toggle) section.append(toggle)
  } catch (error) {
    const message = document.createElement('p')
    message.textContent = `Could not load step roll-up: ${error.message}`
    section.append(message)
  }
  return result
}

// One row per project at the top of the page, so the first screen says where each project stands.
function summaryFor(results) {
  const section = document.createElement('section')
  section.setAttribute('aria-labelledby', 'summary-title')
  const title = document.createElement('h2')
  title.id = 'summary-title'
  title.textContent = 'All projects'
  section.append(title)
  const wrap = document.createElement('div')
  wrap.className = 'table-wrap'
  const table = document.createElement('table')
  table.setAttribute('aria-label', 'Summary by project')
  headerRow(table, summaryHeadings)
  const body = table.createTBody()
  for (const { project, anchor, metrics } of results) {
    const tr = body.insertRow()
    const link = document.createElement('a')
    link.href = '#' + anchor
    link.textContent = 'Go to ' + project
    const newest = metrics?.[0]
    const last7 = metrics || []
    const finished = last7.reduce((sum, row) => sum + row.finished, 0)
    const kickBacks = last7.reduce((sum, row) => sum + row.kickBacks.total, 0)
    const cells = [
      project,
      newest ? dayLabel(newest.day) : 'Could not load',
      newest ? newest.finished : '—',
      newest ? ratio(newest.kickBacks.total, newest.finished) : '—',
      metrics ? finished : '—',
      metrics ? kickBacks : '—',
    ]
    cells.forEach((value, j) => { const cell = tr.insertCell(); cell.textContent = value; cell.dataset.label = summaryHeadings[j] })
    const cell = tr.insertCell()
    cell.dataset.label = summaryHeadings[6]
    cell.append(link)
  }
  wrap.append(table)
  section.append(wrap)
  return section
}

async function refresh() {
  try {
    const { projects } = await get('/api/projects')
    const results = await Promise.all(projects.map((project, i) => projectSection(project, i)))
    document.getElementById('summary').replaceChildren(summaryFor(results))
    document.getElementById('projects').replaceChildren(...results.map(r => r.section))
    document.getElementById('status').textContent = ''
  } catch (error) {
    document.getElementById('status').textContent = `Could not refresh metrics: ${error.message}`
  } finally { setTimeout(refresh, 5000) }
}
refresh()
