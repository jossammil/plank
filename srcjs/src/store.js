// Columnar store. Each decoded parquet column becomes a compact typed
// representation that filters, sorting and rendering can scan quickly.
//
//   number | date | datetime | boolean -> num: Float64Array (NaN where missing)
//   category                           -> codes: Int32Array (-1 where missing) + levels
//   string                             -> str: Array<string|null>
//
// Every column also carries isNull: Uint8Array and nullCount.

import { formatNumber, formatDate, formatDateTime, makeZone } from './format.js'

export const CATEGORY_MAX = 50

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function toText(v) {
  if (typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
    } catch {
      return String(v)
    }
  }
  return String(v)
}

/**
 * @param {string} name
 * @param {any[]} values decoded values, null/undefined where missing
 * @param {object} [info] { kind: 'date'|'datetime', base: 'number'|'boolean' (type from the file, used
 *   when there are no values to look at), integer: boolean, levels: string[], tz, label, rClass, digits }
 */
export function buildColumn(name, values, info = {}) {
  const n = values.length
  const isNull = new Uint8Array(n)
  let nullCount = 0
  let sample
  for (let i = 0; i < n; i++) {
    if (values[i] == null) {
      isNull[i] = 1
      nullCount++
    } else if (sample === undefined) sample = values[i]
  }

  const col = {
    name, n, isNull, nullCount,
    type: 'string',
    label: info.label || null,
    rClass: info.rClass || null,
    digits: info.digits || 7,
    zone: null,
    integer: false,
    factor: false,
    error: info.error || null,
  }

  let type
  if (info.kind === 'date' || info.kind === 'datetime') type = info.kind
  else if (info.levels) type = 'string'
  else if (sample === undefined && (info.base === 'number' || info.base === 'boolean')) type = info.base
  else if (typeof sample === 'number' || typeof sample === 'bigint') type = 'number'
  else if (typeof sample === 'boolean') type = 'boolean'
  else if (sample instanceof Date) type = 'datetime'
  else type = 'string'

  if (type === 'number' || type === 'date' || type === 'datetime' || type === 'boolean') {
    const num = new Float64Array(n)
    let integer = true
    let safe = true
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < n; i++) {
      let v = values[i]
      if (v == null) {
        num[i] = NaN
        continue
      }
      if (typeof v === 'bigint') {
        if (v > 9007199254740991n || v < -9007199254740991n) safe = false
        v = Number(v)
      } else if (typeof v !== 'number') v = +v
      num[i] = v
      if (v === v) {
        if (v < min) min = v
        if (v > max) max = v
        if (integer && !Number.isInteger(v)) integer = false
      }
    }
    if (safe) {
      col.type = type
      col.num = num
      // Prefer the stored type (so whole-number doubles stay "dbl") when known.
      col.integer = type === 'number' && (info.integer == null ? integer && min <= max : !!info.integer)
      col.min = min <= max ? min : null
      col.max = min <= max ? max : null
      if (type === 'datetime') {
        col.zone = makeZone(info.tz)
        col.tz = info.tz || null
      }
      return col
    }
    // 64-bit integers beyond double precision: keep exact digits as text
  }

  const str = new Array(n)
  for (let i = 0; i < n; i++) str[i] = values[i] == null ? null : toText(values[i])

  let levels = info.levels ? info.levels.slice() : null
  if (!levels) {
    const seen = new Set()
    for (let i = 0; i < n && seen.size <= CATEGORY_MAX; i++) {
      if (str[i] !== null) seen.add(str[i])
    }
    const k = seen.size
    if (k > 0 && k <= CATEGORY_MAX && (k <= 10 || k <= (n - nullCount) / 2)) {
      levels = Array.from(seen).sort(collator.compare)
    }
  }

  if (levels) {
    const index = new Map(levels.map((l, i) => [l, i]))
    const codes = new Int32Array(n)
    const counts = new Array(levels.length).fill(0)
    for (let i = 0; i < n; i++) {
      const s = str[i]
      if (s === null) {
        codes[i] = -1
        continue
      }
      let c = index.get(s)
      if (c === undefined) {
        c = levels.length
        levels.push(s)
        counts.push(0)
        index.set(s, c)
      }
      codes[i] = c
      counts[c]++
    }
    col.type = 'category'
    col.factor = !!info.levels
    col.codes = codes
    col.levels = levels
    col.counts = counts
    return col
  }

  col.type = 'string'
  col.str = str
  return col
}

/** Short R-style type tag for display. */
export function typeTag(col) {
  switch (col.type) {
    case 'number': return col.integer ? 'int' : 'dbl'
    case 'date': return 'date'
    case 'datetime': return 'dttm'
    case 'boolean': return 'lgl'
    case 'category': return col.marker ? 'mark' : col.factor ? 'fct' : 'chr'
    default: return 'chr'
  }
}

/** Display text for one cell, or null when missing. */
export function cellText(col, i) {
  if (col.isNull[i]) return null
  switch (col.type) {
    case 'number': return formatNumber(col.num[i], col.digits)
    case 'date': return formatDate(col.num[i])
    case 'datetime': return formatDateTime(col.num[i], col.zone)
    case 'boolean': return col.num[i] ? 'TRUE' : 'FALSE'
    case 'category': return col.levels[col.codes[i]]
    default: return col.str[i]
  }
}

/** Display text per row (null where missing), cached. Used by text matching. */
export function displayText(col) {
  if (col._text) return col._text
  if (col.type === 'string') {
    col._text = col.str
    return col._text
  }
  const n = col.n
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = cellText(col, i)
  col._text = out
  return out
}

/** Lowercased display text per row (null where missing), cached. Used by search. */
export function lowerText(col) {
  if (col._lower) return col._lower
  const text = displayText(col)
  const n = col.n
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = text[i] === null ? null : text[i].toLowerCase()
  col._lower = out
  return out
}

/**
 * Sort key per row as a Float64Array, NaN where missing, cached.
 * Strings get a rank from a natural-order collation, so later sorts are
 * plain numeric comparisons.
 */
export function sortKey(col) {
  if (col._key) return col._key
  const n = col.n
  let key
  if (col.num) {
    key = col.num
  } else if (col.type === 'category') {
    // Marker levels are kept in the order they were added; sort them by text.
    let rank = null
    if (col.marker) {
      const idx = col.levels.map((_, c) => c).sort((a, b) => collator.compare(col.levels[a], col.levels[b]))
      rank = new Float64Array(col.levels.length)
      idx.forEach((c, r) => { rank[c] = r })
    }
    key = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const c = col.codes[i]
      key[i] = c < 0 ? NaN : rank ? rank[c] : c
    }
  } else {
    const str = col.str
    const idx = []
    for (let i = 0; i < n; i++) if (str[i] !== null) idx.push(i)
    idx.sort((a, b) => collator.compare(str[a], str[b]))
    key = new Float64Array(n).fill(NaN)
    let rank = -1
    let prev
    for (let k = 0; k < idx.length; k++) {
      const s = str[idx[k]]
      if (k === 0 || collator.compare(prev, s) !== 0) rank++
      key[idx[k]] = rank
      prev = s
    }
  }
  col._key = key
  return key
}

/** Summary stats: { missing, distinct, min, max } with min/max as display text. */
export function columnStats(col) {
  if (col._stats) return col._stats
  let distinct
  if (col.type === 'category') {
    distinct = col.counts.reduce((a, c) => a + (c > 0 ? 1 : 0), 0)
  } else if (col.type === 'string') {
    const seen = new Set()
    for (let i = 0; i < col.n; i++) if (col.str[i] !== null) seen.add(col.str[i])
    distinct = seen.size
  } else {
    const seen = new Set()
    for (let i = 0; i < col.n; i++) if (!col.isNull[i]) seen.add(col.num[i])
    distinct = seen.size
  }
  let min = null
  let max = null
  if (col.num && col.type !== 'boolean' && col.min !== null) {
    const f = col.type === 'number'
      ? (v) => formatNumber(v, col.digits)
      : col.type === 'date' ? formatDate : (v) => formatDateTime(v, col.zone)
    min = f(col.min)
    max = f(col.max)
  }
  col._stats = { missing: col.nullCount, distinct, min, max }
  return col._stats
}
