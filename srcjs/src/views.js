// Saved views: named states of the table (columns and their order, pinned
// columns, column filters, search, WHERE query, sort and the Counts panel) that can be
// switched between. Views are kept per data set in the browser, and a
// report's author can add views from R (see pqview_view()).

const SPEC_KEYS = ['na', 'min', 'max', 'minText', 'maxText', 'contains', 'mode', 'caseSensitive', 'bool', 'invert', 'join', 'paused']
const SPEC_DEFAULT = {
  na: 'any', min: null, max: null, minText: '', maxText: '', contains: '', mode: 'contains',
  caseSensitive: false, bool: null, invert: false, join: 'and', paused: false,
}

/** True when a filter spec does nothing and has no options set. */
export function isDefaultSpec(spec) {
  if (spec.codes != null) return false
  for (const k of SPEC_KEYS) {
    if (k === 'paused') continue
    if ((spec[k] ?? SPEC_DEFAULT[k]) !== SPEC_DEFAULT[k]) return false
  }
  return true
}

/**
 * A filter spec as stored in a view: category codes become their level
 * text, so the view survives levels being renumbered (marker columns).
 */
export function specToView(spec, col) {
  const out = {}
  for (const k of SPEC_KEYS) out[k] = spec[k] ?? SPEC_DEFAULT[k]
  out.values = spec.codes == null ? null
    : Array.from(spec.codes).sort((a, b) => a - b).map((c) => (col && col.levels ? col.levels[c] : null)).filter((v) => v != null)
  return out
}

/** The live filter spec for a stored one; level text is matched back to codes. */
export function specFromView(stored, col, emptySpec) {
  const spec = emptySpec()
  for (const k of SPEC_KEYS) if (stored[k] !== undefined) spec[k] = stored[k]
  if (Array.isArray(stored.values) && col && col.levels) {
    const index = new Map(col.levels.map((l, i) => [l, i]))
    spec.codes = new Set(stored.values.map((v) => index.get(v)).filter((c) => c !== undefined))
  }
  return spec
}

/**
 * Builds a view from the viewer's state.
 * @param {object} s { columns, specs: [name, spec][], colOf(name), search, searchRegex,
 *   searchInvert, where, whereInvert, sort: {name, dir}[], pinned: string[], counts }
 */
export function makeView(name, s) {
  const filters = []
  for (const [col, spec] of s.specs) {
    if (!s.columns.includes(col) || isDefaultSpec(spec)) continue
    filters.push([col, specToView(spec, s.colOf(col))])
  }
  return {
    name,
    columns: s.columns.slice(),
    filters,
    search: s.search || '',
    searchRegex: !!s.searchRegex,
    searchInvert: !!s.searchInvert,
    where: (s.where || '').trim(),
    whereInvert: !!s.whereInvert,
    sort: s.sort.map((x) => ({ name: x.name, dir: x.dir === 'desc' ? 'desc' : 'asc' })),
    pinned: (s.pinned || []).filter((name) => s.columns.includes(name)),
    counts: s.counts ? cleanCounts(s.counts) : null,
  }
}

function cleanCounts(c) {
  if (!c || !Array.isArray(c.by) || !c.by.length || typeof c.by[0] !== 'string') return null
  return {
    by: c.by.filter((x) => typeof x === 'string' && x).slice(0, 2),
    bins: Array.isArray(c.bins) ? c.bins.slice(0, 2).map((b) => (typeof b === 'string' ? b : null)) : [],
    value: typeof c.value === 'string' && c.value ? c.value : null,
    stat: typeof c.stat === 'string' ? c.stat : 'mean',
  }
}

/**
 * Checks a view read from storage or sent from R, filling in defaults.
 * Returns null when it is not usable.
 */
export function normalizeView(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) return null
  const strings = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string') : typeof x === 'string' ? [x] : [])
  const filters = Array.isArray(raw.filters)
    ? raw.filters.filter((f) => Array.isArray(f) && typeof f[0] === 'string' && f[1] && typeof f[1] === 'object')
    : []
  const sort = (Array.isArray(raw.sort) ? raw.sort : raw.sort ? [raw.sort] : [])
    .filter((x) => x && typeof x.name === 'string')
    .map((x) => ({ name: x.name, dir: x.dir === 'desc' ? 'desc' : 'asc' }))
  return {
    name: raw.name.trim(),
    columns: raw.columns == null ? null : strings(raw.columns),
    filters,
    search: typeof raw.search === 'string' ? raw.search : '',
    searchRegex: !!raw.searchRegex,
    searchInvert: !!raw.searchInvert,
    where: typeof raw.where === 'string' ? raw.where.trim() : '',
    whereInvert: !!raw.whereInvert,
    sort,
    pinned: strings(raw.pinned),
    counts: raw.counts == null ? null : cleanCounts(Array.isArray(raw.counts) || typeof raw.counts === 'string'
      ? { by: strings(raw.counts) } : raw.counts),
  }
}

/**
 * What decides the rows and columns of a view, as text, so the current
 * state can be matched against saved views. The Counts panel is left out.
 */
export function viewSignature(v) {
  return JSON.stringify([
    v.columns, v.filters.map(([n, s]) => [n, SPEC_KEYS.map((k) => s[k]), s.values]),
    v.search, v.searchRegex, v.searchInvert, v.where, v.whereInvert, v.sort.map((x) => [x.name, x.dir]),
    v.pinned || [],
  ])
}

/** Parses the JSON saved in the browser into a list of views. */
export function parseSaved(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.views) ? raw.views : []
  const out = []
  const seen = new Set()
  for (const r of list) {
    const v = normalizeView(r)
    if (v && v.columns && !seen.has(v.name)) {
      seen.add(v.name)
      out.push(v)
    }
  }
  return out
}

export function serializeSaved(views) {
  return JSON.stringify({ version: 1, views })
}

/** A short description such as "6 columns · 2 filters · WHERE · sorted by age". */
export function describeView(v) {
  const parts = []
  if (v.columns) parts.push(`${v.columns.length} column${v.columns.length === 1 ? '' : 's'}`)
  const nf = v.filters.filter(([, s]) => !s.paused).length
  if (nf) parts.push(`${nf} filter${nf === 1 ? '' : 's'}`)
  if (v.search.trim()) parts.push('search')
  if (v.where) parts.push('WHERE')
  if (v.pinned && v.pinned.length) parts.push(`${v.pinned.length} pinned`)
  if (v.sort.length) parts.push('sorted by ' + v.sort.map((s) => s.name + (s.dir === 'desc' ? ' ↓' : '')).join(', '))
  if (v.counts) parts.push('counts by ' + v.counts.by.join(' × '))
  return parts.join(' · ') || 'no filters'
}

const rString = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  .replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
const rVector = (xs) => (xs.length === 1 ? rString(xs[0]) : `c(${xs.map(rString).join(', ')})`)

/**
 * R code for pqview_view() that reproduces a view: the column filters and
 * search are written into `where` (the same text as See Query shows).
 * @param {object} v a view
 * @param {string} where the combined WHERE condition
 * @param {string} [name] view name, written as `"name" = pqview_view(...)` for a list of views
 */
export function viewToR(v, where, name = '') {
  const args = []
  args.push(`columns = ${v.columns.length ? rVector(v.columns) : 'character(0)'}`)
  if (where) args.push(`where = ${rString(where)}`)
  if (v.pinned && v.pinned.length) args.push(`pin = ${rVector(v.pinned)}`)
  if (v.sort.length) args.push(`sort = ${rVector(v.sort.map((s) => (s.dir === 'desc' ? '-' : '') + s.name))}`)
  if (v.counts) args.push(`counts = ${rVector(v.counts.by)}`)
  const code = `pqview_view(\n  ${args.join(',\n  ')}\n)`
  return name ? `${rString(name)} = ${code}` : code
}
