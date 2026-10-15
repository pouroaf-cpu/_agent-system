const headings = ['NZ reporting period', 'Integrated', 'Archived', 'Finished', 'Kick-backs', '[planning]', '[implementation]', '[evidence]', '[operational]', 'Untagged', 'Delivery failed', 'No handoff', 'Planner failures', 'Stalls', 'Owner escalations', 'Kick-backs / finished']
const difficulties = ['tiny', 'easy', 'medium', 'hard']
headings.push(...difficulties.flatMap(d => [`${d} attempts`, `${d} kick-backs`]))
const stepHeadings = ['NZ day', 'Role', 'Group', 'Sessions', 'Unknown steps', 'Median steps', 'p90 steps', 'Median tokens']
const stepGroups = [['all', 'All'], ['child', 'Child of a split'], ['notSplit', 'Not split'], ['parent', 'Split parent']]
async function get(url) {
  const response = await fetch(url)
  const data = await response.json()
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}
async function refresh() {
  try {
    const { projects } = await get('/api/projects')
    const sections = await Promise.all(projects.map(async project => {
      const section = document.createElement('section')
      const heading = document.createElement('h2')
      heading.textContent = project
      section.append(heading)
      try {
        const { metrics } = await get(`/api/metrics?project=${encodeURIComponent(project)}`)
        const wrap = document.createElement('div')
        wrap.className = 'table-wrap'
        const table = document.createElement('table')
        table.setAttribute('aria-label', `${project} daily board health`)
        const head = table.createTHead().insertRow()
        for (const label of headings) {
          const cell = document.createElement('th')
          cell.scope = 'col'
          cell.textContent = label
          head.append(cell)
        }
        const body = table.createTBody()
        for (const row of metrics) {
          const cells = [formatNZTime(row.day + 'T00:00:00Z') + ' – ' + formatNZTime(Date.parse(row.day + 'T00:00:00Z') + 86400000), row.integrated, row.archived, row.finished, row.kickBacks.total,
            ...['planning', 'implementation', 'evidence', 'operational', 'untagged'].map(tag => row.kickBacks[tag]),
            row.builderDeliveryFailed, row.builderNoHandoff, row.plannerFailures, row.stalls, row.ownerEscalations,
            row.kickBacksPerFinishedCard == null ? '—' : row.kickBacksPerFinishedCard.toFixed(2),
            ...difficulties.flatMap(d => [row.builderDifficulty?.[d]?.attempts || 0, row.builderDifficulty?.[d]?.kickBacks || 0])]
          const tr = body.insertRow()
          // data-label carries the column heading for the stacked layout under 1300 px.
          cells.forEach((value, i) => { const cell = tr.insertCell(); cell.textContent = value; cell.dataset.label = headings[i] })
        }
        wrap.append(table)
        section.append(wrap)
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
        const head = table.createTHead().insertRow()
        for (const label of stepHeadings) {
          const cell = document.createElement('th')
          cell.scope = 'col'
          cell.textContent = label
          head.append(cell)
        }
        const body = table.createTBody()
        const show = value => value == null ? '—' : value
        for (const row of rollup) for (const role of ['planner', 'builder']) for (const [group, label] of stepGroups) {
          const g = row[role][group]
          if (group !== 'all' && !g.sessions) continue
          const tr = body.insertRow()
          ;[row.day, role === 'planner' ? 'Planner' : 'Builder', label, g.sessions, g.unknown, g.medianSteps, g.p90Steps, g.medianTokens].forEach((value, i) => { const cell = tr.insertCell(); cell.textContent = show(value); cell.dataset.label = stepHeadings[i] })
        }
        wrap.append(table)
        section.append(wrap)
      } catch (error) {
        const message = document.createElement('p')
        message.textContent = `Could not load step roll-up: ${error.message}`
        section.append(message)
      }
      return section
    }))
    document.getElementById('projects').replaceChildren(...sections)
    document.getElementById('status').textContent = ''
  } catch (error) {
    document.getElementById('status').textContent = `Could not refresh metrics: ${error.message}`
  } finally { setTimeout(refresh, 5000) }
}
refresh()
