import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sniffDelimiter, parseDelimited, inferColumn, rowsToColumns, cleanNames, readXlsx, readFile } from '../src/import.js'
import { buildColumn } from '../src/store.js'
import { toXLSX } from '../src/export.js'
import { cellText } from '../src/store.js'

test('the delimiter is the one that splits lines evenly', () => {
  assert.equal(sniffDelimiter('a,b,c\n1,2,3\n4,5,6\n'), ',')
  assert.equal(sniffDelimiter('a\tb\n1\t2\n'), '\t')
  assert.equal(sniffDelimiter('a;b;c\n1,5;2;3\n'), ';')
  assert.equal(sniffDelimiter('name|note\nx|"a, b, c"\n'), '|')
})

test('quoting, embedded delimiters and newlines, CRLF and a byte-order mark', async () => {
  const text = '﻿id,note\r\n1,"a, ""quoted"" note"\r\n2,"two\nlines"\r\n3,\r\n'
  const rows = await parseDelimited(text, ',')
  assert.deepEqual(rows, [['id', 'note'], ['1', 'a, "quoted" note'], ['2', 'two\nlines'], ['3', '']])
  assert.deepEqual(await parseDelimited('a,b\n1,2', ','), [['a', 'b'], ['1', '2']])
})

test('names are made unique and never empty', () => {
  assert.deepEqual(cleanNames(['x', '', 'x', ' y ', 'x']), ['x', 'V2', 'x_2', 'y', 'x_3'])
})

test('column types are guessed from the text', () => {
  const t = (cells) => inferColumn('v', cells)
  assert.deepEqual(t(['1', '2', 'NA', '']).info, { base: 'number', integer: true })
  assert.deepEqual(t(['1', '2', 'NA', '']).values, [1, 2, null, null])
  assert.deepEqual(t(['1.5', '-2e3', 'Inf']).values, [1.5, -2000, Infinity])
  assert.deepEqual(t(['007', '12']).info, {}) // leading zeros stay text
  assert.deepEqual(t(['12345678901234567890']).info, {}) // too many digits for a double
  assert.deepEqual(t(['TRUE', 'false', 'NA']).values, [true, false, null])
  const d = t(['2024-03-01', '2024-02-29', ''])
  assert.equal(d.info.kind, 'date')
  assert.equal(d.values[1], Date.UTC(2024, 1, 29))
  assert.deepEqual(t(['2023-02-29']).info, {}) // not a real date
  const dt = t(['2024-03-10 01:30:00', '2024-03-10T02:00:00Z', '2024-03-10T03:00:00+01:00'])
  assert.equal(dt.info.kind, 'datetime')
  assert.deepEqual(dt.values, [Date.UTC(2024, 2, 10, 1, 30), Date.UTC(2024, 2, 10, 2), Date.UTC(2024, 2, 10, 2)])
  assert.deepEqual(t(['a', '1']).values, ['a', '1'])
  assert.deepEqual(t(['NA', '']).values, [null, null])
})

test('short rows are padded with missing values', () => {
  const cols = rowsToColumns([['a', 'b'], ['1'], ['2', 'x']])
  assert.deepEqual(cols.map((c) => c.values), [[1, 2], [null, 'x']])
})

test('an Excel workbook written by the viewer reads back with its types', async () => {
  const n = 4
  const cols = [
    buildColumn('id', [1, 2, 3, null], { base: 'number', integer: true }),
    buildColumn('score', [1.5, -2.25, null, 1e6]),
    buildColumn('name', ['a', 'b & c', null, '<x>']),
    buildColumn('ok', [true, false, null, true]),
    buildColumn('day', [Date.UTC(2024, 0, 31), null, Date.UTC(2000, 1, 29), Date.UTC(1999, 11, 31)], { kind: 'date' }),
  ]
  const view = Uint32Array.from({ length: n }, (_, i) => i)
  const blob = await toXLSX(cols, view, {})
  const { columns } = readXlsx(new Uint8Array(await blob.arrayBuffer()))
  assert.deepEqual(columns.map((c) => c.name), ['id', 'score', 'name', 'ok', 'day'])
  assert.deepEqual(columns[0].values, [1, 2, 3, null])
  assert.deepEqual(columns[1].values, [1.5, -2.25, null, 1e6])
  assert.deepEqual(columns[2].values, ['a', 'b & c', null, '<x>'])
  assert.deepEqual(columns[3].values, [true, false, null, true])
  assert.equal(columns[4].info.kind, 'date')
  assert.deepEqual(columns[4].values, [Date.UTC(2024, 0, 31), null, Date.UTC(2000, 1, 29), Date.UTC(1999, 11, 31)])
})

test('readFile: CSV to a dataset whose columns decode', async () => {
  const file = new File(['region,income,day\nWest,100.5,2024-01-02\nSouth,NA,2024-01-03\n'], 'small.csv')
  const out = await readFile(file)
  assert.equal(out.ds.n, 2)
  assert.deepEqual(out.ds.fields.map((f) => `${f.name}:${f.tag}`), ['region:chr', 'income:dbl', 'day:date'])
  const income = await out.ds.column('income')
  assert.equal(income.isNull[1], 1)
  const day = await out.ds.column('day')
  assert.equal(cellText(day, 0), '2024-01-02')
  await assert.rejects(readFile(new File([new Uint8Array([0, 1, 2, 0])], 'x.bin')), /not text, Excel or parquet/)
  await assert.rejects(readFile(new File(['x'], 'old.xls')), /\.xls/)
})

test('readFile: zstd parquet (polars and DuckDB write it) opens and decodes', async () => {
  const { readFileSync } = await import('node:fs')
  const bytes = readFileSync(new URL('./fixtures/zstd.parquet', import.meta.url))
  const out = await readFile(new File([bytes], 'zstd.parquet'))
  assert.equal(out.ds.n, 5)
  const x = await out.ds.column('x')
  assert.equal(x.error, null)
  assert.deepEqual(Array.from(x.num).map((v) => (Number.isNaN(v) ? null : v)), [1.5, null, 3, 4.25, 5])
  const s = await out.ds.column('s')
  assert.equal(cellText(s, 3), 'd')
})
