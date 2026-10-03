const headings = ['NZ reporting period', 'Integrated', 'Archived', 'Finished', 'Kick-backs', '[planning]', '[implementation]', '[evidence]', '[operational]', 'Untagged', 'Delivery failed', 'No handoff', 'Planner failures', 'Stalls', 'Owner escalations', 'Kick-backs / finished']
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
            row.kickBacksPerFinishedCard == null ? '—' : row.kickBacksPerFinishedCard.toFixed(2)]
          const tr = body.insertRow()
          for (const value of cells) tr.insertCell().textContent = value
        }
        wrap.append(table)
        section.append(wrap)
      } catch (error) {
        const message = document.createElement('p')
        message.textContent = `Could not load metrics: ${error.message}`
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
