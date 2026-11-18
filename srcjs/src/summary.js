// Group counts for the Counts panel: rows per value (or range, or period) of
// one or two columns over the filtered rows, with an optional statistic of a
// number column. Everything here is pure: columns and a view in, groups out.

import { formatNumber, formatDate, formatDateTime, DAY_MS } from './format.js'
import { sortKey } from './store.js'
import { ident, str } from './sql.js'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const HOUR_MS = 3600000

/** How each column type can be grouped: [key, label]. The first is the default unless defaultBin says otherwise. */
export const BINS = {
  number: [['value', 'Each value'], ['range', 'Ranges']],
  date: [['value', 'Day'], ['month', 'Month'], ['year', 'Year']],
  datetime: [['day', 'Day'], ['hour', 'Hour'], ['month', 'Month'], ['year', 'Year'], ['value', 'Second']],
}

export const STATS = [
  ['mean', 'Mean'], ['median', 'Median'], ['sum', 'Sum'], ['min', 'Min'], ['max', 'Max'],
]

/** The grouping a column gets unless one is chosen: ranges for numbers with many values. */
export function defaultBin(col) {
  const bins = BINS[col.type]
  if (!bins) return 'value'
  if (col.type === 'number') return distinctUpTo(col, 30) ? 'value' : 'range'
  return bins[0][0]
}

/** True when the column has at most `limit` distinct non-missing values. */
function distinctUpTo(col, limit) {
  if (col._stats) return col._stats.distinct <= limit
  const seen = new Set()
  for (let i = 0; i < col.n; i++) {
    if (col.isNull[i]) continue
    seen.add(col.num[i])
    if (seen.size > limit) return false
  }
  return true
}

/** A "nice" step near span / target: 1, 2 or 5 times a power of ten. */
export function niceStep(span, target, integer = false) {
  if (!(span > 0)) return 1
  const raw = span / target
  const p = 10 ** Math.floor(Math.log10(raw))
  const f = raw / p
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p
  return integer ? Math.max(1, Math.round(step)) : step
}

const round12 = (v) => +v.toPrecision(12)

// Maps instants to the column's wall clock. Offsets are cached per quarter
// hour, since time zone changes happen on quarter-hour boundaries.
function wallClock(zone) {
  if (!zone) return (ms) => ms
  const cache = new Map()
  return (ms) => {
    const b = Math.floor(ms / 900000)
    let off = cache.get(b)
    if (off === undefined) {
      const s = b * 900000
      off = zone.wall(s) - s
      cache.set(b, off)
    }
    return ms + off
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0')

// Year * 12 + month (0-11) and year for a day number, cached per day.
function calendar() {
  const cache = new Map()
  return (day) => {
    let v = cache.get(day)
    if (v === undefined) {
      const d = new Date(day * DAY_MS)
      v = d.getUTCFullYear() * 12 + d.getUTCMonth()
      cache.set(day, v)
    }
    return v
  }
}

/**
 * Builds group ids from per-row bin values: equal values share an id.
 * `bin(i)` returns a number (or null for missing). Returns ids, the bin value
 * of each id, and their count.
 */
function idsFromValues(n, isNull, bin) {
  const ids = new Int32Array(n)
  const index = new Map()
  const values = []
  for (let i = 0; i < n; i++) {
    if (isNull[i]) {
      ids[i] = -1
      continue
    }
    const v = bin(i)
    let id = index.get(v)
    if (id === undefined) {
      id = values.length
      values.push(v)
      index.set(v, id)
    }
    ids[i] = id
  }
  return { ids, values }
}

/** Rank of each id when its values are sorted numerically. */
function numericRank(values) {
  const order = values.map((_, id) => id).sort((a, b) => values[a] - values[b])
  const rank = new Float64Array(values.length)
  order.forEach((id, r) => { rank[id] = r })
  return rank
}

/**
 * How one column splits rows into groups.
 *
 * Returns { col, bin, ids: Int32Array (-1 = missing), k, label(id), rank: Float64Array,
 *   cond(id), notCond(id) } where cond and notCond are WHERE conditions in
 * pqview's query syntax that select (or leave out) the group's rows.
 * Keys for parquet columns are cached on the column; marker columns change,
 * so theirs are built each time (they are cheap).
 */
export function groupKey(col, bin = defaultBin(col)) {
  if (col.type !== 'category') {
    const cache = col._groups || (col._groups = new Map())
    let key = cache.get(bin)
    if (!key) {
      key = buildKey(col, bin)
      cache.set(bin, key)
    }
    return key
  }
  return buildKey(col, bin)
}

function buildKey(col, bin) {
  const c = ident(col.name)
  const n = col.n
  const nullable = () => col.nullCount > 0
  const eqKey = (lit, label, rank, ids, k) => ({
    col, bin, ids, k, rank,
    label: (id) => (id < 0 ? 'NA' : label(id)),
    cond: (id) => (id < 0 ? `${c} IS NULL` : `${c} = ${lit(id)}`),
    notCond: (id) => (id < 0 ? `${c} IS NOT NULL`
      : nullable() ? `(${c} != ${lit(id)} OR ${c} IS NULL)` : `${c} != ${lit(id)}`),
  })

  switch (col.type) {
    case 'category': {
      const { levels } = col
      let rank
      if (col.factor && !col.marker) rank = Float64Array.from(levels, (_, i) => i)
      else {
        const order = levels.map((_, i) => i).sort((a, b) => collator.compare(levels[a], levels[b]) || (levels[a] < levels[b] ? -1 : 1))
        rank = new Float64Array(levels.length)
        order.forEach((id, r) => { rank[id] = r })
      }
      return eqKey((id) => str(levels[id]), (id) => levels[id], rank, col.codes, levels.length)
    }
    case 'boolean': {
      const ids = new Int32Array(n)
      for (let i = 0; i < n; i++) ids[i] = col.isNull[i] ? -1 : col.num[i] ? 1 : 0
      return eqKey((id) => (id ? 'TRUE' : 'FALSE'), (id) => (id ? 'TRUE' : 'FALSE'), Float64Array.of(0, 1), ids, 2)
    }
    case 'string': {
      const ids = new Int32Array(n)
      const index = new Map()
      const values = []
      const first = []
      for (let i = 0; i < n; i++) {
        const s = col.str[i]
        if (s === null) {
          ids[i] = -1
          continue
        }
        let id = index.get(s)
        if (id === undefined) {
          id = values.length
          values.push(s)
          first.push(i)
          index.set(s, id)
        }
        ids[i] = id
      }
      // The sort key ranks text in natural order; exact ties go by code point.
      const key = sortKey(col)
      const order = values.map((_, id) => id).sort((a, b) => (key[first[a]] - key[first[b]]) ||
        (values[a] < values[b] ? -1 : values[a] > values[b] ? 1 : 0))
      const rank = new Float64Array(values.length)
      order.forEach((id, r) => { rank[id] = r })
      return eqKey((id) => str(values[id]), (id) => values[id], rank, ids, values.length)
    }
    case 'number':
      if (bin === 'range') return rangeKey(col)
      return valueKey(col, (i) => col.num[i], (v) => String(v === Infinity ? '9e999' : v === -Infinity ? '-9e999' : v),
        (v) => formatNumber(v, col.digits), eqKey)
    case 'date': {
      if (bin === 'month' || bin === 'year') return periodKey(col, bin, (i) => Math.floor(col.num[i] / DAY_MS), eqKey)
      return valueKey(col, (i) => col.num[i], (v) => str(formatDate(v)), formatDate, eqKey)
    }
    case 'datetime': {
      const wall = wallClock(col.zone)
      if (bin === 'value') {
        // Whole seconds of wall-clock time: the finest a WHERE condition can name.
        const { ids, values } = idsFromValues(n, col.isNull, (i) => Math.floor(wall(col.num[i]) / 1000))
        const text = (id) => formatDateTime(values[id] * 1000, null)
        return eqKey((id) => str(text(id)), text, numericRank(values), ids, values.length)
      }
      if (bin === 'month' || bin === 'year') return periodKey(col, bin, (i) => Math.floor(wall(col.num[i]) / DAY_MS), eqKey)
      if (bin === 'hour') {
        const { ids, values } = idsFromValues(n, col.isNull, (i) => Math.floor(wall(col.num[i]) / HOUR_MS))
        const text = (id) => {
          const ms = values[id] * HOUR_MS
          return `${formatDate(ms)} ${pad(new Date(ms).getUTCHours())}`
        }
        const between = (id) => `${c} BETWEEN ${str(text(id) + ':00')} AND ${str(text(id) + ':59')}`
        return {
          col, bin, ids, k: values.length, rank: numericRank(values),
          label: (id) => (id < 0 ? 'NA' : text(id) + ':00'),
          cond: (id) => (id < 0 ? `${c} IS NULL` : between(id)),
          notCond: (id) => (id < 0 ? `${c} IS NOT NULL`
            : nullable() ? `(${between(id).replace(' BETWEEN ', ' NOT BETWEEN ')} OR ${c} IS NULL)`
              : between(id).replace(' BETWEEN ', ' NOT BETWEEN ')),
        }
      }
      // day
      const { ids, values } = idsFromValues(n, col.isNull, (i) => Math.floor(wall(col.num[i]) / DAY_MS))
      const day = (id) => formatDate(values[id] * DAY_MS)
      return eqKey((id) => str(day(id)), day, numericRank(values), ids, values.length)
    }
    default:
      throw new Error(`Cannot group by a column of type ${col.type}`)
  }
}

function valueKey(col, get, lit, label, eqKey) {
  const { ids, values } = idsFromValues(col.n, col.isNull, get)
  return eqKey((id) => lit(values[id]), (id) => label(values[id]), numericRank(values), ids, values.length)
}

// Months or years, from a per-row day number.
function periodKey(col, bin, dayOf, eqKey) {
  const cal = calendar()
  const get = bin === 'year' ? (i) => Math.floor(cal(dayOf(i)) / 12) : (i) => cal(dayOf(i))
  const { ids, values } = idsFromValues(col.n, col.isNull, get)
  const text = bin === 'year'
    ? (id) => pad(values[id], 4)
    : (id) => `${pad(Math.floor(values[id] / 12), 4)}-${pad((values[id] % 12) + 1)}`
  return eqKey((id) => str(text(id)), text, numericRank(values), ids, values.length)
}

// About ten equal ranges with round edges, over the whole column's range,
// so the ranges stay the same while filters change.
function rangeKey(col) {
  const c = ident(col.name)
  const n = col.n
  let lo = Infinity
  let hi = -Infinity
  let openLow = false
  let openHigh = false
  for (let i = 0; i < n; i++) {
    if (col.isNull[i]) continue
    const v = col.num[i]
    if (v === -Infinity) openLow = true
    else if (v === Infinity) openHigh = true
    else {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (lo > hi) lo = hi = 0
  const step = niceStep(hi - lo, 10, col.integer)
  const start = Math.floor(lo / step) * step
  const nb = Math.max(1, Math.floor((hi - start) / step) + 1)
  const edges = new Float64Array(nb + 1)
  for (let j = 0; j <= nb; j++) edges[j] = round12(start + j * step)
  const ids = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    if (col.isNull[i]) {
      ids[i] = -1
      continue
    }
    const v = col.num[i]
    let id = v === -Infinity ? 0 : v === Infinity ? nb - 1 : Math.floor((v - start) / step)
    if (id < 0) id = 0
    if (id > nb - 1) id = nb - 1
    while (id > 0 && v < edges[id]) id--
    while (id < nb - 1 && v >= edges[id + 1]) id++
    ids[i] = id
  }
  const fmt = (v) => formatNumber(v, Math.max(col.digits, 12))
  // The first and last ranges are open when the column has infinite values.
  const low = (id) => (id === 0 && openLow ? null : edges[id])
  const high = (id) => (id === nb - 1 && openHigh ? null : edges[id + 1])
  const inRange = (id) => {
    const a = low(id)
    const b = high(id)
    if (a === null && b === null) return `${c} IS NOT NULL`
    if (a === null) return `${c} < ${b}`
    if (b === null) return `${c} >= ${a}`
    return `${c} >= ${a} AND ${c} < ${b}`
  }
  const outRange = (id) => {
    const a = low(id)
    const b = high(id)
    const parts = []
    if (a !== null) parts.push(`${c} < ${a}`)
    if (b !== null) parts.push(`${c} >= ${b}`)
    if (col.nullCount > 0) parts.push(`${c} IS NULL`)
    if (!parts.length) return 'FALSE'
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`
  }
  return {
    col, bin: 'range', ids, k: nb, rank: Float64Array.from(edges.subarray(0, nb)),
    label: (id) => {
      if (id < 0) return 'NA'
      const a = low(id)
      const b = high(id)
      return `[${a === null ? '-Inf' : fmt(a)}, ${b === null ? 'Inf]' : fmt(b) + ')'}`
    },
    cond: (id) => (id < 0 ? `${c} IS NULL` : inRange(id)),
    notCond: (id) => (id < 0 ? `${c} IS NOT NULL` : outRange(id)),
  }
}

/**
 * Counts the rows of `view` in each group of one or two keys, with an
 * optional statistic of a number (or logical) column per group.
 *
 * @param {Uint32Array} view row indices
 * @param {object[]} keys one or two group keys from groupKey()
 * @param {object|null} [valueCol] number or boolean column
 * @param {string} [stat] one of STATS
 * @returns {{a: number, b: number, count: number, value: number|null, valid: number}[]}
 *   a and b are group ids (-1 = missing; b is -1 with one key); value is
 *   null when the group has no non-missing values.
 */
export function countGroups(view, keys, valueCol = null, stat = 'mean') {
  const m = view.length
  const ka = keys[0]
  const kb = keys[1] || null
  const A = ka.k + 1
  const B = kb ? kb.k + 1 : 1
  const cells = A * B
  const slot = new Int32Array(m)
  const groups = []
  const idsA = ka.ids
  const idsB = kb ? kb.ids : null
  // Group slots are dense when the grid of combinations is small, else hashed.
  if (cells <= 4194304) {
    const index = new Int32Array(cells).fill(-1)
    for (let j = 0; j < m; j++) {
      const i = view[j]
      const cell = (idsA[i] + 1) * B + (idsB ? idsB[i] + 1 : 0)
      let g = index[cell]
      if (g < 0) {
        g = groups.length
        index[cell] = g
        groups.push({ a: idsA[i], b: idsB ? idsB[i] : -1, count: 0, value: null, valid: 0 })
      }
      groups[g].count++
      slot[j] = g
    }
  } else {
    const index = new Map()
    for (let j = 0; j < m; j++) {
      const i = view[j]
      const cell = (idsA[i] + 1) * B + (idsB ? idsB[i] + 1 : 0)
      let g = index.get(cell)
      if (g === undefined) {
        g = groups.length
        index.set(cell, g)
        groups.push({ a: idsA[i], b: idsB ? idsB[i] : -1, count: 0, value: null, valid: 0 })
      }
      groups[g].count++
      slot[j] = g
    }
  }
  if (valueCol) groupStat(view, slot, groups, valueCol, stat)
  return groups
}

function groupStat(view, slot, groups, col, stat) {
  const k = groups.length
  const m = view.length
  const num = col.num
  const nul = col.isNull
  const valid = new Int32Array(k)
  for (let j = 0; j < m; j++) if (!nul[view[j]]) valid[slot[j]]++
  for (let g = 0; g < k; g++) groups[g].valid = valid[g]
  if (stat === 'median') {
    const start = new Int32Array(k + 1)
    for (let g = 0; g < k; g++) start[g + 1] = start[g] + valid[g]
    const fill = start.slice(0, k)
    const vals = new Float64Array(start[k])
    for (let j = 0; j < m; j++) {
      const i = view[j]
      if (!nul[i]) vals[fill[slot[j]]++] = num[i]
    }
    for (let g = 0; g < k; g++) {
      const a = start[g]
      const b = start[g + 1]
      if (a === b) continue
      const part = vals.subarray(a, b).sort()
      const h = part.length >> 1
      groups[g].value = part.length & 1 ? part[h] : (part[h - 1] + part[h]) / 2
    }
    return
  }
  const acc = new Float64Array(k).fill(stat === 'min' ? Infinity : stat === 'max' ? -Infinity : 0)
  for (let j = 0; j < m; j++) {
    const i = view[j]
    if (nul[i]) continue
    const g = slot[j]
    const v = num[i]
    if (stat === 'min') { if (v < acc[g]) acc[g] = v } else if (stat === 'max') { if (v > acc[g]) acc[g] = v } else acc[g] += v
  }
  for (let g = 0; g < k; g++) {
    if (!valid[g]) continue
    groups[g].value = stat === 'mean' ? acc[g] / valid[g] : acc[g]
  }
}

/**
 * Sorts groups in place. by: 'count' | 'key' | 'value'. Missing group values
 * (NA) sort last within a key; ties fall back to the keys in ascending order.
 */
export function sortGroups(groups, keys, by = 'count', dir = 'desc') {
  const ka = keys[0]
  const kb = keys[1] || null
  const rk = (key, id) => (id < 0 ? Infinity : key.rank[id])
  const byKey = (x, y) => {
    const d = rk(ka, x.a) - rk(ka, y.a)
    if (d || !kb) return d || 0
    return rk(kb, x.b) - rk(kb, y.b) || 0
  }
  const sign = dir === 'asc' ? 1 : -1
  let cmp
  if (by === 'key') {
    // NA stays last in either direction.
    cmp = (x, y) => {
      const na = (x.a < 0) - (y.a < 0)
      if (na) return na
      const d = rk(ka, x.a) - rk(ka, y.a)
      if (d) return sign * d
      if (!kb) return 0
      const nb = (x.b < 0) - (y.b < 0)
      return nb || sign * (rk(kb, x.b) - rk(kb, y.b)) || 0
    }
  } else if (by === 'value') {
    cmp = (x, y) => {
      if (x.value === null || y.value === null) return (x.value === null) - (y.value === null) || byKey(x, y)
      return sign * (x.value - y.value) || byKey(x, y)
    }
  } else {
    cmp = (x, y) => sign * (x.count - y.count) || byKey(x, y)
  }
  return groups.sort(cmp)
}

/** WHERE condition selecting one group's rows. */
export function groupCondition(keys, g) {
  const parts = [keys[0].cond(g.a)]
  if (keys[1]) parts.push(keys[1].cond(g.b))
  return parts.join(' AND ')
}

/** WHERE condition leaving one group's rows out (missing values kept). */
export function excludeCondition(keys, g) {
  if (!keys[1]) return keys[0].notCond(g.a)
  return `(${groupCondition(keys, g)}) IS NOT TRUE`
}

/** Display text for a statistic. */
export function formatStat(v, col, stat) {
  if (v === null) return 'NA'
  if (col.type === 'boolean' && stat === 'mean') return (v * 100).toFixed(1) + '%'
  return formatNumber(v, col.digits || 7)
}

/** The groups as rows of text (header first), for copying or CSV. */
export function groupTable(groups, keys, total, valueCol = null, stat = 'mean') {
  const head = keys.map((k) => k.col.name).concat(['rows', 'percent'])
  if (valueCol) head.push(`${stat}_${valueCol.name}`)
  const out = [head]
  for (const g of groups) {
    const row = [keys[0].label(g.a)]
    if (keys[1]) row.push(keys[1].label(g.b))
    row.push(String(g.count), total ? (+(g.count / total * 100).toFixed(4)).toString() : '0')
    if (valueCol) row.push(g.value === null ? 'NA' : String(g.value))
    out.push(row)
  }
  return out
}
