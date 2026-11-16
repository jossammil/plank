// Small distribution charts for the column list: the whole column in a light
// tone, with the rows left by the current filters drawn darker on top.

import { formatNumber, formatDate, formatDateTime } from './format.js'

const NUM_BINS = 24
const TOP_LEVELS = 8
const MISSING = 255
const W = 120
const H = 22

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function valueFormatter(col) {
  if (col.type === 'date') return formatDate
  if (col.type === 'datetime') return (v) => formatDateTime(v, col.zone)
  return (v) => formatNumber(v, 4)
}

/**
 * Bins for a column, cached on it:
 *   { kind: 'range'|'levels'|'presence', bins: [{ label, count }], missing, binOf }
 * binOf[i] is the bin index of row i, or 255 when the value is missing (or NaN).
 */
export function distribution(col) {
  if (col._dist) return col._dist
  const n = col.n
  const binOf = new Uint8Array(n)
  let kind
  let bins

  if (col.type === 'number' || col.type === 'date' || col.type === 'datetime') {
    kind = 'range'
    const num = col.num
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < n; i++) {
      const v = num[i]
      if (v > -Infinity && v < Infinity) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    const fmt = valueFormatter(col)
    if (lo > hi) {
      bins = []
      binOf.fill(MISSING)
    } else {
      // Whole numbers get whole-number bins, so labels read "18 to 21".
      const ints = col.type === 'number' && col.integer
      const span = hi - lo + 1
      const width = ints ? Math.max(1, Math.ceil(span / NUM_BINS)) : lo === hi ? 1 : (hi - lo) / NUM_BINS
      const k = ints ? Math.ceil(span / width) : lo === hi ? 1 : NUM_BINS
      bins = []
      for (let b = 0; b < k; b++) {
        const a = lo + b * width
        let label
        if (ints) label = width === 1 ? fmt(a) : `${fmt(a)} to ${fmt(Math.min(hi, a + width - 1))}`
        else label = k === 1 ? fmt(a) : `${fmt(a)} to ${fmt(b === k - 1 ? hi : a + width)}`
        bins.push({ label, count: 0 })
      }
      for (let i = 0; i < n; i++) {
        const v = num[i]
        if (col.isNull[i] || v !== v) {
          binOf[i] = MISSING
          continue
        }
        let b = width > 0 ? Math.floor((v - lo) / width) : 0
        if (b < 0) b = 0
        else if (b >= k) b = k - 1
        binOf[i] = b
        bins[b].count++
      }
    }
  } else if (col.type === 'category') {
    kind = 'levels'
    const order = []
    for (let c = 0; c < col.levels.length; c++) if (col.counts[c] > 0) order.push(c)
    order.sort((a, b) => col.counts[b] - col.counts[a] || a - b)
    const slot = new Int16Array(col.levels.length).fill(-1)
    bins = []
    order.slice(0, TOP_LEVELS).forEach((c, b) => {
      slot[c] = b
      bins.push({ label: col.levels[c] === '' ? '(empty)' : col.levels[c], count: 0 })
    })
    if (order.length > TOP_LEVELS) {
      bins.push({ label: `${(order.length - TOP_LEVELS).toLocaleString()} other values`, count: 0 })
    }
    const other = bins.length - 1
    for (let i = 0; i < n; i++) {
      const c = col.codes[i]
      if (c < 0) {
        binOf[i] = MISSING
        continue
      }
      const b = slot[c] >= 0 ? slot[c] : other
      binOf[i] = b
      bins[b].count++
    }
  } else if (col.type === 'boolean') {
    kind = 'levels'
    bins = [{ label: 'TRUE', count: 0 }, { label: 'FALSE', count: 0 }]
    for (let i = 0; i < n; i++) {
      if (col.isNull[i]) {
        binOf[i] = MISSING
        continue
      }
      const b = col.num[i] ? 0 : 1
      binOf[i] = b
      bins[b].count++
    }
  } else {
    kind = 'presence'
    bins = [{ label: 'has a value', count: 0 }]
    for (let i = 0; i < n; i++) {
      if (col.isNull[i]) binOf[i] = MISSING
      else bins[0].count++
    }
  }

  let missing = 0
  for (let i = 0; i < n; i++) if (binOf[i] === MISSING) missing++
  col._dist = { kind, bins, missing, binOf }
  return col._dist
}

/** Count the rows of `view` per bin; the last slot counts missing values. */
export function overlayCounts(col, view) {
  const d = distribution(col)
  const k = d.bins.length
  const out = new Uint32Array(k + 1)
  const binOf = d.binOf
  for (let r = 0; r < view.length; r++) {
    const b = binOf[view[r]]
    out[b === MISSING ? k : b]++
  }
  return out
}

/**
 * SVG markup for a column's chart. `on` (from overlayCounts) draws the
 * filtered rows on top; pass null when no filter is active.
 */
export function chartSVG(col, on, n = col.n) {
  const d = distribution(col)
  const k = d.bins.length
  const bars = d.bins.map((b, j) => ({ label: b.label, count: b.count, on: on ? on[j] : null }))
  if (d.missing) bars.push({ label: 'NA', count: d.missing, on: on ? on[k] : null, na: true })
  if (!bars.length) return ''
  let max = 0
  for (const b of bars) if (b.count > max) max = b.count
  const gap = bars.length > 30 ? 0.5 : 1
  const bw = (W - gap * (bars.length - 1)) / bars.length
  const pct = (c) => {
    const p = (c / n) * 100
    return p === 0 ? '0%' : p < 0.1 ? '<0.1%' : p >= 10 ? p.toFixed(0) + '%' : p.toFixed(1) + '%'
  }
  const hgt = (c) => (c ? Math.max(1, (c / max) * (H - 1)) : 0)
  let body = ''
  let totalOn = 0
  bars.forEach((b, j) => {
    const x = (j * (bw + gap)).toFixed(2)
    const w = Math.max(0.5, bw).toFixed(2)
    const hAll = hgt(b.count)
    let tip = `${b.label}: ${b.count.toLocaleString()} rows (${pct(b.count)})`
    if (b.on !== null) {
      tip += ` · ${b.on.toLocaleString()} after filters`
      totalOn += b.on
    }
    body += `<g data-tip="${esc(tip)}">` +
      `<rect class="pqv-spk-hit" x="${x}" y="0" width="${w}" height="${H}"/>` +
      `<rect class="${b.na ? 'pqv-spk-na' : 'pqv-spk-all'}" x="${x}" y="${(H - hAll).toFixed(2)}" width="${w}" height="${hAll.toFixed(2)}"/>`
    if (b.on !== null && b.on > 0) {
      const hOn = hgt(b.on)
      body += `<rect class="pqv-spk-on" x="${x}" y="${(H - hOn).toFixed(2)}" width="${w}" height="${hOn.toFixed(2)}"/>`
    }
    body += '</g>'
  })
  const attrs = on ? ` data-on="${totalOn}"` : ''
  return `<svg class="pqv-spk" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" role="img" aria-label="Distribution of ${esc(col.name)}"${attrs}>${body}</svg>`
}

/** min, quartiles, mean and max of a number/date column (finite values), cached. */
export function numericSummary(col) {
  if (col._summary !== undefined) return col._summary
  const vals = []
  const num = col.num
  let sum = 0
  for (let i = 0; i < col.n; i++) {
    const v = num[i]
    if (!col.isNull[i] && v > -Infinity && v < Infinity) {
      vals.push(v)
      sum += v
    }
  }
  if (!vals.length) {
    col._summary = null
    return null
  }
  const a = Float64Array.from(vals).sort()
  const q = (p) => {
    const x = (a.length - 1) * p
    const lo = Math.floor(x)
    return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (x - lo)
  }
  col._summary = { min: a[0], q1: q(0.25), median: q(0.5), mean: sum / a.length, q3: q(0.75), max: a[a.length - 1] }
  return col._summary
}

/** The most common values of a text column, cached: [{ value, count }]. */
export function topValues(col, k = 10) {
  if (col._top) return col._top
  const counts = new Map()
  for (let i = 0; i < col.n; i++) {
    const s = col.str[i]
    if (s !== null) counts.set(s, (counts.get(s) || 0) + 1)
  }
  col._top = Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((x, y) => y.count - x.count)
    .slice(0, k)
  return col._top
}

/**
 * Detail view for a column in the list: a larger chart, a summary for
 * numbers and dates, and a table of the chart's bars (or the most common
 * values for free text). `on` is from overlayCounts, or null.
 */
export function detailHTML(col, on, n = col.n) {
  const d = distribution(col)
  const pct = (c) => {
    const p = (c / n) * 100
    return p === 0 ? '0%' : p < 0.1 ? '<0.1%' : p >= 10 ? p.toFixed(0) + '%' : p.toFixed(1) + '%'
  }
  let html = chartSVG(col, on, n).replace('class="pqv-spk"', 'class="pqv-spk pqv-spk-big"')
  if (d.kind === 'range') {
    const s = numericSummary(col)
    if (s) {
      const fmt = valueFormatter(col)
      const mean = col.type === 'number' ? formatNumber(s.mean, 4) : fmt(s.mean)
      html += '<dl class="pqv-dsum">' +
        [['min', fmt(s.min)], ['25%', fmt(s.q1)], ['median', fmt(s.median)], ['mean', mean], ['75%', fmt(s.q3)], ['max', fmt(s.max)]]
          .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('') +
        '</dl>'
    }
  }
  const head = `<tr><th>${d.kind === 'range' ? 'Range' : 'Value'}</th><th>Rows</th><th>%</th>${on ? '<th title="Rows left by the current filters">Kept</th>' : ''}</tr>`
  let rows
  if (d.kind === 'presence' && col.str) {
    html += '<div class="pqv-dnote">Mostly unique text. Most common values:</div>'
    rows = topValues(col).map((t) => ({ label: t.value, count: t.count, on: null }))
  } else {
    rows = d.bins.map((b, j) => ({ label: b.label, count: b.count, on: on ? on[j] : null }))
    // Empty ranges add nothing to the table (the chart still shows the gaps).
    if (d.kind === 'range') rows = rows.filter((r) => r.count > 0)
  }
  if (d.missing) rows.push({ label: 'NA', count: d.missing, on: on ? on[d.bins.length] : null, na: true })
  html += '<table class="pqv-dtable"><thead>' + head + '</thead><tbody>' +
    rows.map((r) => `<tr${r.na ? ' class="pqv-dna"' : ''}><td title="${esc(r.label)}">${esc(r.label === '' ? '(empty)' : r.label)}</td>` +
      `<td>${r.count.toLocaleString()}</td><td>${pct(r.count)}</td>` +
      (on ? `<td>${r.on === null ? '' : r.on.toLocaleString()}</td>` : '') + '</tr>').join('') +
    '</tbody></table>'
  return html
}
