// Export the shown rows and columns as Excel (.xlsx), R data (.rds), parquet
// or tab-separated text for the clipboard. Everything is written in the
// browser; CSV lives in csv.js.

import { parquetWriteBuffer } from 'hyparquet-writer'
import { cellValue, rowColumnName, missingText } from './csv.js'

const DAY_MS = 86400000

/**
 * Columns to export, with an optional leading row-number column (1-based
 * original row) so marks can be joined back to the data.
 */
function exportColumns(cols, rowNumbers) {
  const out = cols.slice()
  if (rowNumbers) {
    out.unshift({ name: rowColumnName(cols.map((c) => c.name)), rowNumber: true, type: 'number', integer: true })
  }
  return out
}

/** Is a number column safely stored as 32-bit integers? */
function int32Column(col, view) {
  if (col.rowNumber) return true
  if (!col.integer) return false
  const num = col.num
  for (let r = 0; r < view.length; r++) {
    const i = view[r]
    if (col.isNull[i]) continue
    const v = num[i]
    if (!(v >= -2147483647 && v <= 2147483647)) return false
  }
  return true
}

// ---- clipboard (tab-separated) ------------------------------------------------

const TSV_QUOTE = /[\t\r\n"]/
const tsvQuote = (s) => (TSV_QUOTE.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s)

/** Tab-separated text with a header row, as spreadsheets expect on paste. */
export function toTSV(cols, view, opts = {}) {
  const ecols = exportColumns(cols, opts.rowNumbers)
  const naCell = tsvQuote(missingText(opts))
  const lines = [ecols.map((c) => tsvQuote(c.name)).join('\t')]
  for (let r = 0; r < view.length; r++) {
    const i = view[r]
    let line = ''
    for (let c = 0; c < ecols.length; c++) {
      if (c) line += '\t'
      const col = ecols[c]
      line += col.rowNumber ? String(i + 1) : col.isNull[i] ? naCell : tsvQuote(cellValue(col, i))
    }
    lines.push(line)
  }
  // Plain newlines: copying through a text box turns \r\n into \n anyway,
  // and every spreadsheet accepts them on paste.
  return lines.join('\n') + '\n'
}

// ---- compression helpers ----------------------------------------------------

async function streamBytes(bytes, format) {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

let crcTable = null
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A zip archive of { name, bytes } entries, deflated when the browser can. */
export async function zip(entries) {
  const parts = []
  const central = []
  let offset = 0
  const enc = new TextEncoder()
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  for (const { name, bytes } of entries) {
    const nameBytes = enc.encode(name)
    const crc = crc32(bytes)
    const deflated = await streamBytes(bytes, 'deflate-raw')
    const method = deflated ? 8 : 0
    const data = deflated || bytes
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(8, method, true)
    local.setUint16(10, dosTime, true)
    local.setUint16(12, dosDate, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, bytes.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, data)
    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint16(8, 0x0800, true)
    cd.setUint16(10, method, true)
    cd.setUint16(12, dosTime, true)
    cd.setUint16(14, dosDate, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, data.length, true)
    cd.setUint32(24, bytes.length, true)
    cd.setUint16(28, nameBytes.length, true)
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  let cdSize = 0
  for (const c of central) cdSize += c.length
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, cdSize, true)
  end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' })
}

// ---- Excel (.xlsx) ----------------------------------------------------------

export const XLSX_MAX_ROWS = 1048575

const xmlEscape = (s) => s
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function colLetter(k) {
  let s = ''
  for (k++; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s
  return s
}

function sheetName(title) {
  const s = String(title || 'data').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31)
  return s || 'data'
}

/**
 * An .xlsx workbook with one sheet: a bold, frozen header row with filter
 * buttons, numbers as numbers, dates and date-times as Excel dates (in the
 * column's time zone), logicals as TRUE/FALSE and missing values as blanks,
 * or as text cells holding opts.na when that is given.
 */
export async function toXLSX(cols, view, opts = {}) {
  if (view.length > XLSX_MAX_ROWS) throw new Error(`Excel sheets hold at most ${XLSX_MAX_ROWS.toLocaleString()} rows.`)
  const ecols = exportColumns(cols, opts.rowNumbers)
  const na = missingText(opts)
  const naXml = xmlEscape(na)
  const enc = new TextEncoder()
  const letters = ecols.map((_, k) => colLetter(k))
  const chunks = []
  let buf = ''
  const flush = () => {
    chunks.push(enc.encode(buf))
    buf = ''
  }
  const lastCell = `${letters[letters.length - 1]}${view.length + 1}`
  const widths = ecols.map((c) => {
    const base = c.type === 'datetime' ? 19 : c.type === 'date' ? 11 : 10
    return Math.min(60, Math.max(base, c.name.length + 3))
  })
  buf += '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="A1:${lastCell}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/><cols>' +
    widths.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1"/>`).join('') +
    '</cols><sheetData><row r="1">' +
    ecols.map((c, k) => `<c r="${letters[k]}1" t="inlineStr" s="3"><is><t xml:space="preserve">${xmlEscape(c.name)}</t></is></c>`).join('') +
    '</row>'
  for (let r = 0; r < view.length; r++) {
    const i = view[r]
    const rn = r + 2
    buf += `<row r="${rn}">`
    for (let k = 0; k < ecols.length; k++) {
      const col = ecols[k]
      const ref = letters[k] + rn
      if (col.rowNumber) {
        buf += `<c r="${ref}"><v>${i + 1}</v></c>`
        continue
      }
      if (col.isNull[i]) {
        if (na) buf += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${naXml}</t></is></c>`
        continue
      }
      switch (col.type) {
        case 'number': {
          const v = col.num[i]
          // Excel has no NaN or infinity; those cells are left blank.
          if (Number.isFinite(v)) buf += `<c r="${ref}"><v>${v}</v></c>`
          break
        }
        case 'date':
          buf += `<c r="${ref}" s="1"><v>${col.num[i] / DAY_MS + 25569}</v></c>`
          break
        case 'datetime': {
          const ms = col.zone ? col.zone.wall(col.num[i]) : col.num[i]
          buf += `<c r="${ref}" s="2"><v>${ms / DAY_MS + 25569}</v></c>`
          break
        }
        case 'boolean':
          buf += `<c r="${ref}" t="b"><v>${col.num[i] ? 1 : 0}</v></c>`
          break
        default: {
          let s = cellValue(col, i)
          if (s.length > 32767) s = s.slice(0, 32767)
          buf += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`
        }
      }
    }
    buf += '</row>'
    if (buf.length > 1 << 20) flush()
  }
  buf += `</sheetData><autoFilter ref="A1:${lastCell}"/>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
  flush()
  const sheetBytes = new Uint8Array(await new Blob(chunks).arrayBuffer())

  const name = sheetName(opts.title)
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets>` +
      `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEscape(name.replace(/'/g, "''"))}'!$A$1:$${letters[letters.length - 1]}$${view.length + 1}</definedName></definedNames>` +
      '</workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'],
  ]
  const entries = files.map(([n, text]) => ({ name: n, bytes: enc.encode(text) }))
  entries.splice(4, 0, { name: 'xl/worksheets/sheet1.xml', bytes: sheetBytes })
  const blob = await zip(entries)
  return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

// ---- R data (.rds) -----------------------------------------------------------
// R's serialization format, version 3, big-endian (XDR). See R Internals,
// "Serialization Formats".

const SXP = { NIL: 254, SYM: 1, LIST: 2, CHAR: 9, LGL: 10, INT: 13, REAL: 14, STR: 16, VEC: 19 }
const IS_OBJECT = 1 << 8
const HAS_ATTR = 1 << 9
const HAS_TAG = 1 << 10
const UTF8_LEVEL = 8 << 12
const ASCII_LEVEL = 64 << 12
const NA_INT = -2147483648

class XdrWriter {
  constructor() {
    this.chunks = []
    this.buf = new DataView(new ArrayBuffer(1 << 16))
    this.pos = 0
  }
  ensure(n) {
    if (this.pos + n <= this.buf.byteLength) return
    this.chunks.push(new Uint8Array(this.buf.buffer, 0, this.pos))
    this.buf = new DataView(new ArrayBuffer(Math.max(1 << 16, n)))
    this.pos = 0
  }
  int(v) {
    this.ensure(4)
    this.buf.setInt32(this.pos, v)
    this.pos += 4
  }
  double(v) {
    this.ensure(8)
    this.buf.setFloat64(this.pos, v)
    this.pos += 8
  }
  naReal() {
    // R's NA_real_: a NaN with low word 1954
    this.ensure(8)
    this.buf.setUint32(this.pos, 0x7ff00000)
    this.buf.setUint32(this.pos + 4, 1954)
    this.pos += 8
  }
  bytes(b) {
    this.ensure(b.length)
    new Uint8Array(this.buf.buffer, this.pos, b.length).set(b)
    this.pos += b.length
  }
  result() {
    this.chunks.push(new Uint8Array(this.buf.buffer, 0, this.pos))
    return this.chunks
  }
}

const utf8 = new TextEncoder()
// eslint-disable-next-line no-control-regex
const ASCII = /^[\x00-\x7f]*$/

function writeChar(w, s) {
  if (s === null) {
    w.int(SXP.CHAR)
    w.int(-1)
    return
  }
  const b = utf8.encode(s)
  w.int(SXP.CHAR | (ASCII.test(s) ? ASCII_LEVEL : UTF8_LEVEL))
  w.int(b.length)
  w.bytes(b)
}

function writeStrings(w, list, flags = 0) {
  w.int(SXP.STR | flags)
  w.int(list.length)
  for (const s of list) writeChar(w, s)
}

/** Attribute pairlist: [[name, writeValue], ...]. */
function writeAttrs(w, attrs) {
  for (const [name, value] of attrs) {
    w.int(SXP.LIST | HAS_TAG)
    w.int(SXP.SYM)
    writeChar(w, name)
    value()
  }
  w.int(SXP.NIL)
}

function writeColumn(w, col, view) {
  const n = view.length
  const attrs = []
  let flags = 0
  if (col.label && !col.marker) attrs.push(['label', () => writeStrings(w, [col.label])])

  if (col.rowNumber || (col.type === 'number' && int32Column(col, view))) {
    w.int(SXP.INT | (attrs.length ? HAS_ATTR : 0))
    w.int(n)
    for (let r = 0; r < n; r++) {
      const i = view[r]
      w.int(col.rowNumber ? i + 1 : col.isNull[i] ? NA_INT : col.num[i])
    }
  } else if (col.type === 'number' || col.type === 'date' || col.type === 'datetime') {
    const scale = col.type === 'date' ? DAY_MS : col.type === 'datetime' ? 1000 : 1
    if (col.type === 'date') {
      attrs.push(['class', () => writeStrings(w, ['Date'])])
      flags = IS_OBJECT
    } else if (col.type === 'datetime') {
      attrs.push(['class', () => writeStrings(w, ['POSIXct', 'POSIXt'])])
      attrs.push(['tzone', () => writeStrings(w, [col.tz || 'UTC'])])
      flags = IS_OBJECT
    }
    w.int(SXP.REAL | flags | (attrs.length ? HAS_ATTR : 0))
    w.int(n)
    for (let r = 0; r < n; r++) {
      const i = view[r]
      if (col.isNull[i]) w.naReal()
      else w.double(col.num[i] / scale)
    }
  } else if (col.type === 'boolean') {
    w.int(SXP.LGL | (attrs.length ? HAS_ATTR : 0))
    w.int(n)
    for (let r = 0; r < n; r++) {
      const i = view[r]
      w.int(col.isNull[i] ? NA_INT : col.num[i] ? 1 : 0)
    }
  } else if (col.type === 'category' && col.factor) {
    attrs.unshift(['levels', () => writeStrings(w, col.levels)])
    attrs.push(['class', () => writeStrings(w, ['factor'])])
    w.int(SXP.INT | IS_OBJECT | HAS_ATTR)
    w.int(n)
    for (let r = 0; r < n; r++) {
      const c = col.codes[view[r]]
      w.int(c < 0 ? NA_INT : c + 1)
    }
  } else {
    w.int(SXP.STR | (attrs.length ? HAS_ATTR : 0))
    w.int(n)
    for (let r = 0; r < n; r++) {
      const i = view[r]
      writeChar(w, col.isNull[i] ? null : cellValue(col, i))
    }
  }
  if (attrs.length) writeAttrs(w, attrs)
}

/** A data frame in R's .rds format (gzip-compressed when the browser can). */
export async function toRDS(cols, view, opts = {}) {
  const ecols = exportColumns(cols, opts.rowNumbers)
  const w = new XdrWriter()
  w.bytes(utf8.encode('X\n'))
  w.int(3) // format version
  w.int((4 << 16) | (2 << 8)) // written as by R 4.2.0
  w.int((3 << 16) | (5 << 8)) // readable by R >= 3.5.0
  w.int(5)
  w.bytes(utf8.encode('UTF-8'))
  w.int(SXP.VEC | IS_OBJECT | HAS_ATTR)
  w.int(ecols.length)
  for (const col of ecols) writeColumn(w, col, view)
  writeAttrs(w, [
    ['names', () => writeStrings(w, ecols.map((c) => c.name))],
    ['class', () => writeStrings(w, ['data.frame'])],
    ['row.names', () => {
      w.int(SXP.INT)
      w.int(2)
      w.int(NA_INT)
      w.int(-view.length)
    }],
  ])
  const raw = new Uint8Array(await new Blob(w.result()).arrayBuffer())
  const gz = await streamBytes(raw, 'gzip')
  return new Blob([gz || raw], { type: 'application/octet-stream' })
}

// ---- parquet ------------------------------------------------------------------

/** A snappy-compressed parquet file keeping numbers, logicals, dates and date-times typed. */
export function toParquet(cols, view, opts = {}) {
  const ecols = exportColumns(cols, opts.rowNumbers)
  const n = view.length
  const columnData = ecols.map((col) => {
    if (col.rowNumber) return { name: col.name, data: Array.from(view, (i) => i + 1), type: 'INT32', nullable: false }
    const data = new Array(n)
    let type
    if (col.type === 'number') {
      type = int32Column(col, view) ? 'INT32' : 'DOUBLE'
      for (let r = 0; r < n; r++) data[r] = col.isNull[view[r]] ? null : col.num[view[r]]
    } else if (col.type === 'date') {
      for (let r = 0; r < n; r++) data[r] = col.isNull[view[r]] ? null : Math.round(col.num[view[r]] / DAY_MS)
      return { name: col.name, data, columnSchema: { name: col.name, type: 'INT32', converted_type: 'DATE', repetition_type: 'OPTIONAL' } }
    } else if (col.type === 'datetime') {
      type = 'TIMESTAMP'
      for (let r = 0; r < n; r++) data[r] = col.isNull[view[r]] ? null : BigInt(Math.round(col.num[view[r]]))
    } else if (col.type === 'boolean') {
      type = 'BOOLEAN'
      for (let r = 0; r < n; r++) data[r] = col.isNull[view[r]] ? null : col.num[view[r]] === 1
    } else {
      type = 'STRING'
      for (let r = 0; r < n; r++) data[r] = col.isNull[view[r]] ? null : cellValue(col, view[r])
    }
    return { name: col.name, data, type }
  })
  const schema = [{ name: 'root', num_children: columnData.length }]
  for (const c of columnData) {
    if (c.columnSchema) schema.push(c.columnSchema)
    else if (c.type === 'INT32') schema.push({ name: c.name, type: 'INT32', repetition_type: c.nullable === false ? 'REQUIRED' : 'OPTIONAL' })
    else if (c.type === 'DOUBLE') schema.push({ name: c.name, type: 'DOUBLE', repetition_type: 'OPTIONAL' })
    else if (c.type === 'BOOLEAN') schema.push({ name: c.name, type: 'BOOLEAN', repetition_type: 'OPTIONAL' })
    else if (c.type === 'TIMESTAMP') schema.push({ name: c.name, type: 'INT64', converted_type: 'TIMESTAMP_MILLIS', repetition_type: 'OPTIONAL' })
    else schema.push({ name: c.name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' })
  }
  const buffer = parquetWriteBuffer({
    columnData: columnData.map(({ name, data }) => ({ name, data })),
    schema,
    statistics: false,
  })
  return new Blob([buffer], { type: 'application/vnd.apache.parquet' })
}
