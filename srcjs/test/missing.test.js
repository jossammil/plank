import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { buildColumn } from '../src/store.js'
import { makeMarker, setMarks } from '../src/markers.js'
import { toCSV, csvMissing } from '../src/csv.js'
import { toTSV, toXLSX, toRDS, toParquet } from '../src/export.js'
import { parquetReadObjects } from 'hyparquet'

// Row 0 has a value in every column, row 1 is missing everywhere. The text
// column has many distinct values so it stays plain text, and its row 0
// reads "NA" to check that real text is never taken for a missing value.
const N = 60
const pad = (a) => a.concat(new Array(N - a.length).fill(null))
const words = ['NA', null]
for (let i = 2; i < N; i++) words.push('word ' + i)
const mark = makeMarker('mark', N)
setMarks(mark, [0], 'yes')
const cols = [
  buildColumn('num', pad([1.5, null, 2])),
  buildColumn('text', words),
  buildColumn('fct', pad(['lo', null]), { levels: ['hi', 'lo'] }),
  buildColumn('flag', pad([true, null, false])),
  buildColumn('day', pad([Date.UTC(2024, 1, 29), null, 0]), { kind: 'date' }),
  buildColumn('when', pad([Date.UTC(2024, 0, 15, 18), null, 0]), { kind: 'datetime', tz: 'America/Chicago' }),
  mark,
]
const view = Uint32Array.from([0, 1])
const head = 'num,text,fct,flag,day,when,mark'
const row0 = ['1.5', 'NA', 'lo', 'TRUE', '2024-02-29', '2024-01-15 12:00:00', 'yes']

test('the test columns cover every column type', () => {
  assert.deepEqual(cols.map((c) => c.type), ['number', 'string', 'category', 'boolean', 'date', 'datetime', 'category'])
  assert.ok(cols[2].levels, 'factor kept as levels')
  assert.ok(cols.every((c) => c.isNull[1] === 1))
})

const csvLines = (na) => toCSV(cols, view, na === undefined ? {} : { na }).join('').split('\r\n')

test('CSV: missing values are blank by default and with Empty', () => {
  for (const lines of [csvLines(), csvLines('')]) {
    assert.equal(lines[0], head)
    assert.equal(lines[1], row0.join(','))
    assert.equal(lines[2], ',,,,,,')
  }
})

test('CSV: NA and NULL are written unquoted in every column type', () => {
  const na = csvLines('NA')
  assert.equal(na[2], 'NA,NA,NA,NA,NA,NA,NA')
  // real text "NA" is quoted so it can be told apart from a missing value
  assert.equal(na[1], '1.5,"NA",lo,TRUE,2024-02-29,2024-01-15 12:00:00,yes')
  const nul = csvLines('NULL')
  assert.equal(nul[2], 'NULL,NULL,NULL,NULL,NULL,NULL,NULL')
  assert.equal(nul[1], row0.join(','))
})

test('CSV: custom text follows the quoting rules', () => {
  assert.equal(csvMissing('n/a'), 'n/a')
  assert.equal(csvMissing('a,b'), '"a,b"')
  assert.equal(csvMissing('say "x"'), '"say ""x"""')
  assert.equal(csvMissing('two\nlines'), '"two\nlines"')
  assert.equal(csvMissing(' pad'), '" pad"')
  assert.equal(csvMissing('pad '), '"pad "')
  assert.equal(csvMissing(''), '')
  assert.equal(csvLines('n/a, missing')[2], new Array(7).fill('"n/a, missing"').join(','))
  // non-missing values are untouched by a custom text that does not match them
  assert.equal(csvLines('?')[1], row0.join(','))
  // a level equal to the custom text is quoted too
  assert.equal(csvLines('lo')[1], '1.5,NA,"lo",TRUE,2024-02-29,2024-01-15 12:00:00,yes')
  assert.equal(csvLines('lo')[2], 'lo,lo,lo,lo,lo,lo,lo')
})

test('CSV: row numbers are never missing', () => {
  const lines = toCSV([mark], view, { rowNumbers: true, na: 'NA' }).join('').split('\r\n')
  assert.deepEqual(lines.slice(0, 3), ['row,mark', '1,yes', '2,NA'])
})

test('clipboard text writes the chosen missing-value text', () => {
  const lines = (na) => toTSV(cols, view, { na }).split('\n')
  assert.equal(toTSV(cols, view).split('\n')[2], '\t\t\t\t\t\t')
  assert.equal(lines('')[2], '\t\t\t\t\t\t')
  assert.equal(lines('NA')[2], 'NA\tNA\tNA\tNA\tNA\tNA\tNA')
  assert.equal(lines('NULL')[2], 'NULL\tNULL\tNULL\tNULL\tNULL\tNULL\tNULL')
  assert.equal(lines('a\tb')[2], new Array(7).fill('"a\tb"').join('\t'))
  assert.equal(lines('NA')[1], row0.join('\t'))
})

const sheetXml = async (na) => {
  const bytes = Buffer.from(await (await toXLSX(cols, view, na === undefined ? {} : { na })).arrayBuffer())
  let p = 0
  while (bytes.readUInt32LE(p) === 0x04034b50) {
    const method = bytes.readUInt16LE(p + 8)
    const size = bytes.readUInt32LE(p + 18)
    const nlen = bytes.readUInt16LE(p + 26)
    const name = bytes.subarray(p + 30, p + 30 + nlen).toString()
    const data = bytes.subarray(p + 30 + nlen, p + 30 + nlen + size)
    if (name === 'xl/worksheets/sheet1.xml') return (method === 8 ? inflateRawSync(data) : data).toString()
    p += 30 + nlen + size
  }
  throw new Error('no sheet')
}
const row3 = (xml) => /<row r="3">(.*?)<\/row>/.exec(xml)[1]

test('Excel: Empty leaves missing cells out', async () => {
  assert.equal(row3(await sheetXml()), '')
  assert.equal(row3(await sheetXml('')), '')
})

test('Excel: missing values become text cells with the chosen text', async () => {
  for (const [na, xml] of [['NA', 'NA'], ['NULL', 'NULL'], ['<none> & "x"', '&lt;none&gt; &amp; &quot;x&quot;']]) {
    const cells = row3(await sheetXml(na)).match(/<c [^>]*>.*?<\/c>/g)
    assert.equal(cells.length, 7)
    'ABCDEFG'.split('').forEach((letter, k) => {
      assert.equal(cells[k], `<c r="${letter}3" t="inlineStr"><is><t xml:space="preserve">${xml}</t></is></c>`)
    })
  }
  // values keep their types
  const xml = await sheetXml('NA')
  assert.match(xml, /<c r="A2"><v>1.5<\/v><\/c>/)
  assert.match(xml, /<c r="D2" t="b"><v>1<\/v><\/c>/)
  assert.match(xml, /<c r="E2" s="1"><v>/)
})

test('R data and parquet keep real missing values whatever the setting', async () => {
  const plain = new Uint8Array(await (await toRDS(cols, view)).arrayBuffer())
  const withNA = new Uint8Array(await (await toRDS(cols, view, { na: 'NA' })).arrayBuffer())
  assert.equal(plain.length, withNA.length)
  const rows = await parquetReadObjects({ file: await toParquet(cols, view, { na: 'NA' }).arrayBuffer() })
  assert.deepEqual(Object.values(rows[1]), [null, null, null, null, null, null, null])
  assert.equal(rows[0].text, 'NA')
})
