// Writes the current column filters, global search and WHERE query as one
// WHERE condition in plank's query syntax, for the "full query" view. The
// text runs in the query bar and selects the same rows.

import { hasValueFilter, isActive, textError, compileRegex } from './filters.js'

const KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'ILIKE', 'REGEXP', 'IREGEXP', 'RLIKE',
  'IS', 'NULL', 'TRUE', 'FALSE', 'ESCAPE',
])
const NUMERIC_TERM = /^[0-9eE+\-.:, nainf]*$/

export function ident(name) {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !KEYWORDS.has(name.toUpperCase())) return name
  return name.includes('"') ? '`' + name.replace(/`/g, '``') + '`' : '"' + name + '"'
}

export function str(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

function num(v) {
  if (v === Infinity) return '9e999'
  if (v === -Infinity) return '-9e999'
  return String(v)
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c)
const regexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The value part of a column filter, or null when it has none. */
function valueCondition(col, spec) {
  if (!hasValueFilter(col, spec)) return null
  const c = ident(col.name)
  switch (col.type) {
    case 'number':
    case 'date':
    case 'datetime': {
      const isNum = col.type === 'number'
      const lo = spec.min === null ? null : isNum ? num(spec.min) : str(spec.minText.trim())
      const hi = spec.max === null ? null : isNum ? num(spec.max) : str(spec.maxText.trim())
      if (lo !== null && hi !== null) return `${c} BETWEEN ${lo} AND ${hi}`
      return lo !== null ? `${c} >= ${lo}` : `${c} <= ${hi}`
    }
    case 'boolean':
      return `${c} = ${spec.bool ? 'TRUE' : 'FALSE'}`
    case 'category': {
      const levels = Array.from(spec.codes).sort((a, b) => a - b).map((k) => str(col.levels[k]))
      if (!levels.length) return 'FALSE'
      return levels.length === 1 ? `${c} = ${levels[0]}` : `${c} IN (${levels.join(', ')})`
    }
    default: {
      const q = spec.contains
      if (spec.mode === 'regex') return `${c} ${spec.caseSensitive ? 'REGEXP' : 'IREGEXP'} ${str(q)}`
      if (spec.mode === 'exact') return spec.caseSensitive ? `${c} = ${str(q)}` : `LOWER(${c}) = ${str(q.toLowerCase())}`
      return spec.caseSensitive ? `${c} REGEXP ${str(regexEscape(q))}` : `${c} LIKE ${str('%' + likeEscape(q) + '%')}`
    }
  }
}

/** One column's filter as a condition: value match, invert, then missing values. */
export function columnSQL(col, spec) {
  if (!isActive(col, spec)) return null
  const parts = []
  const v = valueCondition(col, spec)
  if (v) parts.push(spec.invert ? `(${v}) IS NOT TRUE` : v)
  if (spec.na === 'exclude') parts.push(`${ident(col.name)} IS NOT NULL`)
  else if (spec.na === 'only') parts.push(`${ident(col.name)} IS NULL`)
  return parts.join(' AND ')
}

function searchSQL(cols, search, regex, invert) {
  const text = search.trim()
  if (!text || !cols.length) return null
  let cond
  if (regex) {
    if (compileRegex(text, false).error) return null
    cond = cols.map((col) => `${ident(col.name)} IREGEXP ${str(text)}`).join(' OR ')
    cond = `(${cond})`
  } else {
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean)
    const each = terms.map((term) => {
      const hits = cols
        .filter((col) => !(col.num && col.type !== 'boolean' && !NUMERIC_TERM.test(term)))
        .map((col) => `${ident(col.name)} LIKE ${str('%' + likeEscape(term) + '%')}`)
      return hits.length ? `(${hits.join(' OR ')})` : 'FALSE'
    })
    cond = each.length === 1 ? each[0] : `(${each.join(' AND ')})`
  }
  return invert ? `${cond} IS NOT TRUE` : cond
}

/**
 * @param {object} o
 * @param {{col: object, spec: object}[]} o.filters column filters in table order
 * @param {object[]} o.searchCols columns the global search looks in
 * @param {string} o.search
 * @param {boolean} o.searchRegex
 * @param {boolean} o.searchInvert
 * @param {string} o.query WHERE text (only used when valid)
 * @param {boolean} o.queryInvert
 * @returns {string[]} the conditions, ANDed together; empty when nothing filters
 */
export function fullQueryParts(o) {
  const and = []
  const or = []
  for (const { col, spec } of o.filters) {
    if (textError(spec)) continue
    const s = columnSQL(col, spec)
    if (!s) continue
    // A column condition is "value AND missing-rule" at most, so it only
    // needs brackets inside an OR group, and only when it has both parts.
    const both = hasValueFilter(col, spec) && spec.na !== 'any'
    if (spec.join === 'or') or.push(both ? `(${s})` : s)
    else and.push(s)
  }
  const out = and.slice()
  if (or.length === 1) out.push(or[0].replace(/^\((.*)\)$/, '$1'))
  else if (or.length) out.push('(' + or.join(' OR ') + ')')
  const s = searchSQL(o.searchCols || [], o.search || '', o.searchRegex, o.searchInvert)
  if (s) out.push(s)
  const q = (o.query || '').trim()
  if (q) out.push(o.queryInvert ? `(${q}) IS NOT TRUE` : `(${q})`)
  return out
}

/** Multi-line text for display, or '' when nothing filters. */
export function formatFullQuery(parts) {
  if (!parts.length) return ''
  return 'WHERE ' + parts.join('\n  AND ')
}
