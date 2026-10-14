// HK77: one search for several terms. `hkb locate` prints every hit's file, line and a short window,
// so a Planner's lookup is one turn instead of one grep or file read per term.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LINE = /^(.*?):(\d+):/

// Every hit of every term, in term order then git's file/line order; no cap. Fixed-string, case-sensitive.
export function locateTerms({ root, terms, paths = [], context = 1 }) {
  const files = new Map()
  const linesOf = (file) => {
    if (!files.has(file)) files.set(file, readFileSync(join(root, file), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/))
    return files.get(file)
  }
  return terms.flatMap((term) => {
    let out = ''
    try {
      out = execFileSync('git', ['-C', root, 'grep', '-n', '-I', '-F', '-e', term, ...(paths.length ? ['--', ...paths] : [])], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      if (err.status !== 1) throw new Error(String(err.stderr || err.message).trim()) // status 1 is git's "no hits"
    }
    return out.split('\n').flatMap((row) => {
      const m = LINE.exec(row)
      if (!m) return []
      const file = m[1], line = Number(m[2]), all = linesOf(file), window = []
      for (let n = Math.max(1, line - context); n <= Math.min(all.length, line + context); n++) window.push({ line: n, text: all[n - 1] })
      return [{ term, file, line, window }]
    })
  })
}

const cut = (s) => (s.length > 160 ? s.slice(0, 160) : s)

export function formatLocate(results, terms) {
  const out = []
  for (const term of terms) {
    const hits = results.filter((r) => r.term === term)
    out.push(`# ${term}: ${hits.length ? `${hits.length} hit(s)` : 'no hits'}`)
    for (const h of hits) {
      out.push(`${h.file}:${h.line}`)
      for (const w of h.window) out.push(`${w.line === h.line ? '>' : ' '} ${w.line}| ${cut(w.text)}`)
    }
  }
  return out.join('\n')
}
