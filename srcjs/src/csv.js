// RFC 4180 CSV export of the current view.

import { formatDate, formatDateTime } from './format.js'

const NEEDS_QUOTE = /[",\r\n]/

function quote(s) {
  return NEEDS_QUOTE.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function rawNumber(v) {
  if (v !== v) return 'NaN'
  if (v === Infinity) return 'Inf'
  if (v === -Infinity) return '-Inf'
  return String(v)
}

/** Value text for CSV: full numeric precision, empty string when missing. */
function csvCell(col, i) {
  if (col.isNull[i]) return ''
  switch (col.type) {
    case 'number': return rawNumber(col.num[i])
    case 'date': return formatDate(col.num[i])
    case 'datetime': return formatDateTime(col.num[i], col.zone)
    case 'boolean': return col.num[i] ? 'TRUE' : 'FALSE'
    case 'category': return quote(col.levels[col.codes[i]])
    default: return quote(col.str[i])
  }
}

/**
 * @param {object[]} cols columns to write, in order
 * @param {Uint32Array} view row indices to write, in order
 * @param {object} [opts] { rowNumbers: add a leading column with the 1-based original row number }
 * @returns {string[]} chunks of CSV text (pass straight to a Blob)
 */
export function toCSV(cols, view, opts = {}) {
  const rowNumbers = !!opts.rowNumbers
  const names = cols.map((c) => c.name)
  let rowName = 'row'
  while (names.includes(rowName)) rowName = '.' + rowName
  const parts = [(rowNumbers ? [rowName, ...names] : names).map(quote).join(',') + '\r\n']
  const k = cols.length
  const CHUNK = 5000
  let buf = []
  for (let r = 0; r < view.length; r++) {
    const i = view[r]
    let line = rowNumbers ? String(i + 1) : ''
    for (let c = 0; c < k; c++) {
      if (c || rowNumbers) line += ','
      line += csvCell(cols[c], i)
    }
    buf.push(line)
    if (buf.length === CHUNK) {
      parts.push(buf.join('\r\n') + '\r\n')
      buf = []
    }
  }
  if (buf.length) parts.push(buf.join('\r\n') + '\r\n')
  return parts
}
