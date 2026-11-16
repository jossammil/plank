import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { buildColumn } from '../src/store.js'
import { makeMarker, setMarks } from '../src/markers.js'
import { toTSV, toRDS, toXLSX, toParquet } from '../src/export.js'
import { parquetReadObjects } from 'hyparquet'

const cols = [
  buildColumn('n', [1, null, 3], { integer: true }),
  buildColumn('s', ['a\tb', 'say "hi"', null]),
  buildColumn('d', [Date.UTC(2024, 0, 2), null, 0], { kind: 'date' }),
]
const view = Uint32Array.from([2, 0])

test('clipboard text is tab-separated with quoting', () => {
  assert.equal(toTSV(cols, view), 'n\ts\td\r\n3\t\t1970-01-01\r\n1\t"a\tb"\t2024-01-02\r\n')
  const m = makeMarker('mark', 3)
  setMarks(m, [0], '1')
  assert.equal(toTSV([m], view, { rowNumbers: true }), 'row\tmark\r\n3\t\r\n1\t1\r\n')
})

test('rds is R serialization version 3, gzip-compressed', async () => {
  const bytes = new Uint8Array(await (await toRDS(cols, view)).arrayBuffer())
  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b])
  const raw = gunzipSync(bytes)
  assert.equal(raw.subarray(0, 2).toString(), 'X\n')
  assert.equal(raw.readInt32BE(2), 3)
  assert.equal(raw.subarray(18, 23).toString(), 'UTF-8')
  assert.equal(raw.readInt32BE(23), 19 | (1 << 8) | (1 << 9)) // data.frame list with attributes
  assert.equal(raw.readInt32BE(27), 3)
})

test('xlsx is a zip with the workbook parts and typed cells', async () => {
  const bytes = Buffer.from(await (await toXLSX(cols, view, { title: 'My: data' })).arrayBuffer())
  const names = []
  const files = {}
  let p = 0
  while (bytes.readUInt32LE(p) === 0x04034b50) {
    const method = bytes.readUInt16LE(p + 8)
    const size = bytes.readUInt32LE(p + 18)
    const nlen = bytes.readUInt16LE(p + 26)
    const name = bytes.subarray(p + 30, p + 30 + nlen).toString()
    const data = bytes.subarray(p + 30 + nlen, p + 30 + nlen + size)
    files[name] = (method === 8 ? inflateRawSync(data) : data).toString()
    names.push(name)
    p += 30 + nlen + size
  }
  assert.deepEqual(names.sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'])
  const sheet = files['xl/worksheets/sheet1.xml']
  assert.match(sheet, /<c r="A2"><v>3<\/v><\/c>/)
  assert.match(sheet, /<c r="C2" s="1"><v>25569<\/v><\/c>/)
  assert.match(sheet, /<c r="B3" t="inlineStr"><is><t xml:space="preserve">a\tb<\/t><\/is><\/c>/)
  assert.doesNotMatch(sheet, /r="B2"/) // missing value: no cell
  assert.match(files['xl/workbook.xml'], /<sheet name="My  data"/)
})

test('parquet keeps types and missing values', async () => {
  const buf = await toParquet(cols, view, { rowNumbers: true }).arrayBuffer()
  const rows = await parquetReadObjects({ file: buf })
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows[0]), ['row', 'n', 's', 'd'])
  assert.deepEqual([rows[0].row, rows[0].n, rows[0].s], [3, 3, null])
  assert.equal(rows[1].s, 'a\tb')
  assert.equal(new Date(rows[1].d).toISOString().slice(0, 10), '2024-01-02')
})
