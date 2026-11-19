// Opening files in the browser: CSV and TSV text, Excel workbooks (.xlsx) and
// parquet. Nothing is uploaded; the file is read from the reader's disk.

import { unzipSync, strFromU8 } from 'fflate'
import { parquetMetadata } from 'hyparquet'
import { openDataset, datasetFromColumns } from './load.js'

const READABLE_CODECS = new Set(['UNCOMPRESSED', 'SNAPPY', 'GZIP', 'ZSTD'])
const NA_STRINGS = new Set(['', 'NA', 'N/A', 'NULL', 'null', '#N/A'])
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const SPECIAL_NUMBER = { Inf: Infinity, '+Inf': Infinity, '-Inf': -Infinity, NaN: NaN }
const LOGICAL = { TRUE: true, FALSE: false, true: true, false: false, True: true, False: false }
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0))

// ---- delimited text -----------------------------------------------------------

/** The most likely delimiter: the one splitting the first lines most evenly. */
export function sniffDelimiter(text) {
  const lines = []
  let start = 0
  let quoted = false
  for (let i = 0; i < text.length && lines.length < 30 && i < 1 << 20; i++) {
    const ch = text[i]
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (i > start) lines.push(text.slice(start, i))
      start = i + 1
    }
  }
  if (lines.length < 30 && start < text.length) lines.push(text.slice(start, Math.min(text.length, start + 65536)))
  let best = ','
  let bestScore = -1
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => {
      let k = 0
      let q = false
      for (const ch of l) {
        if (ch === '"') q = !q
        else if (!q && ch === d) k++
      }
      return k
    })
    const first = counts[0] || 0
    if (!first) continue
    const same = counts.filter((k) => k === first).length
    const score = same * 1000 + first
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/**
 * Parses delimited text (RFC 4180 quoting) into rows of strings. Yields to the
 * page now and then so a large file does not freeze it.
 * @returns {Promise<string[][]>}
 */
export async function parseDelimited(text, delimiter = ',', onProgress = null) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows = []
  const n = text.length
  const d = delimiter.charCodeAt(0)
  let i = 0
  let row = []
  let field = ''
  let next = 50000
  while (i < n) {
    let c = text.charCodeAt(i)
    if (c === 34 && field === '') {
      // quoted field
      let j = i + 1
      let out = ''
      for (;;) {
        const k = text.indexOf('"', j)
        if (k < 0) {
          out += text.slice(j)
          j = n
          break
        }
        out += text.slice(j, k)
        if (text.charCodeAt(k + 1) === 34) {
          out += '"'
          j = k + 2
        } else {
          j = k + 1
          break
        }
      }
      field = out
      i = j
      // anything up to the delimiter or line end belongs to this field
      while (i < n) {
        c = text.charCodeAt(i)
        if (c === d || c === 10 || c === 13) break
        field += text[i]
        i++
      }
      continue
    }
    if (c === d) {
      row.push(field)
      field = ''
      i++
    } else if (c === 10 || c === 13) {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1
      if (rows.length >= next) {
        next += 50000
        if (onProgress) onProgress(i / n)
        await yieldNow()
      }
    } else {
      // plain characters up to the next delimiter or line end
      let j = i + 1
      while (j < n) {
        const cj = text.charCodeAt(j)
        if (cj === d || cj === 10 || cj === 13) break
        j++
      }
      field += text.slice(i, j)
      i = j
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Unique, non-empty column names. */
export function cleanNames(names) {
  const seen = new Map()
  return names.map((raw, k) => {
    let name = String(raw == null ? '' : raw).trim() || `V${k + 1}`
    if (seen.has(name)) {
      let m = seen.get(name) + 1
      while (seen.has(`${name}_${m}`)) m++
      seen.set(name, m)
      name = `${name}_${m}`
    }
    seen.set(name, 1)
    return name
  })
}

const utcMs = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)

function validDate(m) {
  const t = utcMs(m[1], m[2], m[3])
  const dt = new Date(t)
  return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3] ? t : null
}

/**
 * Types one column of text cells: logical, number, date, date-time or text.
 * Text that would lose information as a number (leading zeros, more than 15
 * digits) stays text.
 */
export function inferColumn(name, cells) {
  const n = cells.length
  let logical = true
  let number = true
  let integer = true
  let date = true
  let datetime = true
  let seen = 0
  for (let i = 0; i < n; i++) {
    const s = cells[i]
    if (s == null || NA_STRINGS.has(s)) continue
    seen++
    if (logical && !(s in LOGICAL)) logical = false
    if (number) {
      const t = s.trim()
      if (t in SPECIAL_NUMBER) integer = false
      else if (!NUMBER.test(t) || /^[+-]?0\d/.test(t) || t.replace(/[^\d]/g, '').length > 15) number = false
      else if (integer && !/^[+-]?\d+$/.test(t)) integer = false
    }
    if (date && !(DATE.test(s) && validDate(DATE.exec(s)) !== null)) date = false
    if (datetime && !DATETIME.test(s)) datetime = false
    if (!logical && !number && !date && !datetime) break
  }
  const values = new Array(n)
  const missing = (s) => s == null || NA_STRINGS.has(s)
  if (!seen) {
    for (let i = 0; i < n; i++) values[i] = null
    return { name, values, info: {} }
  }
  if (logical) {
    for (let i = 0; i < n; i++) values[i] = missing(cells[i]) ? null : LOGICAL[cells[i]]
    return { name, values, info: { base: 'boolean' } }
  }
  if (number) {
    for (let i = 0; i < n; i++) {
      const s = cells[i]
      if (missing(s)) values[i] = null
      else {
        const t = s.trim()
        values[i] = t in SPECIAL_NUMBER ? SPECIAL_NUMBER[t] : Number(t)
      }
    }
    return { name, values, info: { base: 'number', integer } }
  }
  if (date) {
    for (let i = 0; i < n; i++) values[i] = missing(cells[i]) ? null : validDate(DATE.exec(cells[i]))
    return { name, values, info: { kind: 'date' } }
  }
  if (datetime) {
    for (let i = 0; i < n; i++) {
      const s = cells[i]
      if (missing(s)) {
        values[i] = null
        continue
      }
      const m = DATETIME.exec(s)
      // no zone written: read as UTC, which is how it is then shown
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${m[7] || ''}${m[8] ? m[8].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z'}`)
      values[i] = Number.isNaN(t) ? null : t
    }
    return { name, values, info: { kind: 'datetime' } }
  }
  for (let i = 0; i < n; i++) values[i] = missing(cells[i]) ? null : cells[i]
  return { name, values, info: {} }
}

/** Rows of text (header first) to typed columns. */
export function rowsToColumns(rows) {
  if (!rows.length) throw new Error('The file is empty.')
  const names = cleanNames(rows[0])
  const k = names.length
  const n = rows.length - 1
  const cells = names.map(() => new Array(n))
  for (let r = 0; r < n; r++) {
    const row = rows[r + 1]
    for (let c = 0; c < k; c++) cells[c][r] = c < row.length ? row[c] : null
  }
  return names.map((name, c) => inferColumn(name, cells[c]))
}

// ---- Excel (.xlsx) ----------------------------------------------------------------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
  return XML_ENTITIES[e] ?? m
})
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? unescapeXml(m[1]) : null
}
const textOf = (xml) => {
  let out = ''
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g
  let m
  while ((m = re.exec(xml))) out += m[1] ? unescapeXml(m[1]) : ''
  return out
}
const colNumber = (ref) => {
  let k = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) break
    k = k * 26 + (c - 64)
  }
  return k - 1
}

/** Which number formats (by style index) show dates, and whether with a time. */
function dateStyles(stylesXml) {
  const custom = new Map()
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    custom.set(+attr(m[0], 'numFmtId'), attr(m[0], 'formatCode') || '')
  }
  const kindOf = (id) => {
    if ((id >= 14 && id <= 17) || id === 30) return 'date'
    if (id === 22) return 'datetime'
    if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return 'time'
    const code = custom.get(id)
    if (!code) return null
    const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
    const hasTime = /[hs]/i.test(bare)
    // "m" is a month next to days or years, or with no hours or seconds about
    const hasDate = /[dy]/i.test(bare) || (/m/i.test(bare) && !hasTime)
    return hasDate ? (hasTime ? 'datetime' : 'date') : hasTime ? 'time' : null
  }
  const cellXfs = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(stylesXml)
  const out = []
  if (cellXfs) for (const m of cellXfs[0].matchAll(/<xf\b[^>]*>/g)) out.push(kindOf(+attr(m[0], 'numFmtId')))
  return out
}

/**
 * Reads the first sheet of an .xlsx workbook into typed columns: numbers,
 * logicals, dates (from the cells' number formats) and text.
 */
export function readXlsx(bytes) {
  let files
  try {
    files = unzipSync(bytes, { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(f.name) })
  } catch {
    throw new Error('This is not a readable Excel workbook (.xlsx).')
  }
  const read = (name) => (files[name] ? strFromU8(files[name]) : '')
  const workbook = read('xl/workbook.xml')
  if (!workbook) throw new Error('This is not a readable Excel workbook (.xlsx).')
  const sheetTag = /<sheet\b[^>]*>/.exec(workbook)
  if (!sheetTag) throw new Error('The workbook has no sheets.')
  const sheetName = attr(sheetTag[0], 'name')
  const rid = attr(sheetTag[0], 'r:id')
  let target = 'worksheets/sheet1.xml'
  for (const m of read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    if (attr(m[0], 'Id') === rid) target = attr(m[0], 'Target').replace(/^\/?xl\//, '')
  }
  const sheet = read('xl/' + target.replace(/^\//, ''))
  if (!sheet) throw new Error(`Sheet '${sheetName}' could not be found in the workbook.`)
  const epoch = /date1904="(1|true)"/.test(workbook) ? 24107 : 25569
  const shared = []
  for (const m of read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]))
  const styles = dateStyles(read('xl/styles.xml'))

  // cells[r][c] = { v, t, k } with k the date kind of the cell's style
  const rows = []
  let width = 0
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rAttr = rm[1] || rm[3] || ''
    const r = (+attr(' ' + rAttr, 'r') || rows.length + 1) - 1
    const row = []
    let next = 0
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = ' ' + cm[1]
      const ref = attr(tag, 'r')
      const c = ref ? colNumber(ref) : next
      next = c + 1
      const t = attr(tag, 't') || 'n'
      const body = cm[2] || ''
      const vm = /<v>([\s\S]*?)<\/v>/.exec(body)
      let v = null
      if (t === 's') v = vm ? shared[+vm[1]] ?? null : null
      else if (t === 'inlineStr') v = textOf(body)
      else if (t === 'str') v = vm ? unescapeXml(vm[1]) : null
      else if (t === 'b') v = vm ? vm[1] === '1' : null
      else if (t === 'e') v = null
      else v = vm ? Number(vm[1]) : null
      const s = attr(tag, 's')
      row[c] = { v, t, k: s !== null ? styles[+s] || null : null }
      if (c + 1 > width) width = c + 1
    }
    rows[r] = row
  }
  if (!rows.length) throw new Error(`Sheet '${sheetName}' is empty.`)
  const header = rows[0] || []
  const names = cleanNames(Array.from({ length: width }, (_, c) => (header[c] && header[c].v != null ? String(header[c].v) : '')))
  const n = Math.max(0, rows.length - 1)
  const columns = names.map((name, c) => {
    const cells = new Array(n)
    let nums = 0
    let bools = 0
    let texts = 0
    let dates = 0
    let times = 0
    for (let r = 0; r < n; r++) {
      const cell = rows[r + 1] && rows[r + 1][c]
      cells[r] = cell || null
      if (!cell || cell.v === null || cell.v === '') continue
      if (typeof cell.v === 'number') {
        nums++
        if (cell.k === 'date' || cell.k === 'datetime') dates++
        if (cell.k === 'datetime') times++
      } else if (typeof cell.v === 'boolean') bools++
      else texts++
    }
    const values = new Array(n)
    if (texts || (nums && bools)) {
      // mixed or text: everything as text, then the usual guessing
      const strs = cells.map((cell) => (!cell || cell.v === null ? null : String(cell.v)))
      return inferColumn(name, strs)
    }
    if (bools) {
      for (let r = 0; r < n; r++) values[r] = cells[r] && cells[r].v !== null ? cells[r].v : null
      return { name, values, info: { base: 'boolean' } }
    }
    if (nums && dates === nums) {
      for (let r = 0; r < n; r++) {
        const v = cells[r] && cells[r].v
        values[r] = typeof v === 'number' ? Math.round((v - epoch) * 86400000) : null
      }
      return { name, values, info: { kind: times ? 'datetime' : 'date' } }
    }
    let integer = true
    for (let r = 0; r < n; r++) {
      const v = cells[r] && cells[r].v
      values[r] = typeof v === 'number' ? v : null
      if (integer && typeof v === 'number' && !Number.isInteger(v)) integer = false
    }
    return { name, values, info: nums ? { base: 'number', integer } : {} }
  })
  return { columns, sheetName }
}

// ---- files ------------------------------------------------------------------------

const isParquet = (b) => b.length >= 8 && b[0] === 0x50 && b[1] === 0x41 && b[2] === 0x52 && b[3] === 0x31
const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

/** Text standing in for the file in a fingerprint: its size, name and some bytes. */
function fingerprintText(file, bytes) {
  let s = `${file.name}|${bytes.length}|`
  const take = (a, b) => {
    for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i])
  }
  take(0, Math.min(bytes.length, 3072))
  take(Math.max(3072, bytes.length - 1024), bytes.length)
  return s
}

/**
 * Reads a file chosen or dropped by the reader into a dataset.
 * @param {File} file
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Promise<{ds: object, size: number, name: string, fp: string, sheet?: string}>}
 */
export async function readFile(file, onProgress = null) {
  const name = file.name || 'data'
  const ext = (/\.([^.]+)$/.exec(name) || [])[1]
  const lower = ext ? ext.toLowerCase() : ''
  const bytes = new Uint8Array(await file.arrayBuffer())
  const out = { name, size: bytes.length, fp: fingerprintText(file, bytes) }
  if (isParquet(bytes) || lower === 'parquet') {
    if (!isParquet(bytes)) throw new Error('This file does not look like parquet.')
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const meta = parquetMetadata(buffer)
    const bad = new Set()
    for (const rg of meta.row_groups) {
      for (const c of rg.columns) if (c.meta_data && !READABLE_CODECS.has(c.meta_data.codec)) bad.add(c.meta_data.codec)
    }
    if (bad.size) {
      throw new Error(`This parquet file uses ${Array.from(bad).join(' and ')} compression, which the viewer cannot read; ` +
        'save it again with snappy, gzip or zstd.')
    }
    out.ds = openDataset(buffer, {})
    return out
  }
  if (lower === 'xls') throw new Error('Old Excel files (.xls) cannot be read; save the sheet as .xlsx or CSV.')
  if (isZip(bytes) || lower === 'xlsx' || lower === 'xlsm') {
    const { columns, sheetName } = readXlsx(bytes)
    out.ds = datasetFromColumns(columns)
    out.sheet = sheetName
    return out
  }
  const text = new TextDecoder('utf-8').decode(bytes)
  if (text.includes('\u0000')) throw new Error('This file is not text, Excel or parquet.')
  const delimiter = lower === 'tsv' || lower === 'tab' ? '\t' : sniffDelimiter(text)
  const rows = await parseDelimited(text, delimiter, onProgress)
  out.ds = datasetFromColumns(rowsToColumns(rows))
  return out
}

export const OPEN_ACCEPT = '.csv,.tsv,.tab,.txt,.xlsx,.xlsm,.parquet'
