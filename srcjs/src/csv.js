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

/** Plain value text for export: full numeric precision, '' when missing. */
export function cellValue(col, i) {
  if (col.isNull[i]) return ''
  switch (col.type) {
    case 'number': return rawNumber(col.num[i])
    case 'date': return formatDate(col.num[i])
    case 'datetime': return formatDateTime(col.num[i], col.zone)
    case 'boolean': return col.num[i] ? 'TRUE' : 'FALSE'
    case 'category': return col.levels[col.codes[i]]
    default: return col.str[i]
  }
}

// Missing-value text is quoted like any other text, and also when it has
// leading or trailing spaces, which some readers would otherwise trim.
const EDGE_SPACE = /^\s|\s$/

/** CSV cell for missing values written as `na` ('' for a blank cell). */
export function csvMissing(na) {
  return NEEDS_QUOTE.test(na) || EDGE_SPACE.test(na) ? '"' + na.replace(/"/g, '""') + '"' : na
}

/** The text a missing value is written as: opts.na, or '' (a blank cell). */
export function missingText(opts = {}) {
  return typeof opts.na === 'string' ? opts.na : ''
}

function csvCell(col, i, na, naCell) {
  if (col.isNull[i]) return naCell
  const v = cellValue(col, i)
  if (col.type !== 'category' && col.type !== 'string') return v
  // Text that reads the same as the missing-value text is quoted, so readers
  // that honour quotes can tell it from a missing value.
  return na !== '' && v === na ? '"' + v.replace(/"/g, '""') + '"' : quote(v)
}

/** Name for the leading row-number column that does not clash with `names`. */
export function rowColumnName(names) {
  let name = 'row'
  while (names.includes(name)) name = '.' + name
  return name
}

/**
 * @param {object[]} cols columns to write, in order
 * @param {Uint32Array} view row indices to write, in order
 * @param {object} [opts] { rowNumbers: add a leading column with the 1-based original row number,
 *   na: text written for missing values (default '', a blank cell) }
 * @returns {string[]} chunks of CSV text (pass straight to a Blob)
 */
export function toCSV(cols, view, opts = {}) {
  const rowNumbers = !!opts.rowNumbers
  const na = missingText(opts)
  const naCell = csvMissing(na)
  const names = cols.map((c) => c.name)
  const rowName = rowColumnName(names)
  const parts = [(rowNumbers ? [rowName, ...names] : names).map(quote).join(',') + '\r\n']
  const k = cols.length
  const CHUNK = 5000
  let buf = []
  for (let r = 0; r < view.length; r++) {
    const i = view[r]
    let line = rowNumbers ? String(i + 1) : ''
    for (let c = 0; c < k; c++) {
      if (c || rowNumbers) line += ','
      line += csvCell(cols[c], i, na, naCell)
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
