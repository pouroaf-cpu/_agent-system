// The project key a board agent's registry rows and per-project state are filed under.

export const sessionOf = (project) => (project || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || null
