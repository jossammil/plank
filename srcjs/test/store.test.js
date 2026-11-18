import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildColumn, cellText, typeTag, sortKey, columnStats, lowerText } from '../src/store.js'

test('numbers: typed storage, integer detection, missing values', () => {
  const ints = buildColumn('a', [3, null, 1, 2])
  assert.equal(ints.type, 'number')
  assert.equal(ints.integer, true)
  assert.equal(typeTag(ints), 'int')
  assert.equal(ints.nullCount, 1)
  assert.equal(cellText(ints, 0), '3')
  assert.equal(cellText(ints, 1), null)
  assert.deepEqual([ints.min, ints.max], [1, 3])

  const dbl = buildColumn('b', [1.5, 2.25])
  assert.equal(typeTag(dbl), 'dbl')
  // the stored type wins over what the values look like
  assert.equal(typeTag(buildColumn('c', [1, 2], { integer: false })), 'dbl')
})

test('64-bit integers: numbers when safe, exact text otherwise', () => {
  const safe = buildColumn('a', [1n, 2n, null])
  assert.equal(safe.type, 'number')
  assert.equal(cellText(safe, 1), '2')
  const big = buildColumn('b', [9007199254740993n, 5n])
  assert.notEqual(big.type, 'number')
  assert.equal(cellText(big, 0), '9007199254740993')
})

test('booleans, dates and datetimes', () => {
  const lgl = buildColumn('l', [true, false, null])
  assert.equal(typeTag(lgl), 'lgl')
  assert.equal(cellText(lgl, 0), 'TRUE')
  assert.equal(cellText(lgl, 1), 'FALSE')

  const day = buildColumn('d', [Date.UTC(2024, 0, 2), null], { kind: 'date' })
  assert.equal(typeTag(day), 'date')
  assert.equal(cellText(day, 0), '2024-01-02')

  const when = buildColumn('t', [Date.UTC(2024, 0, 15, 18)], { kind: 'datetime', tz: 'America/Chicago' })
  assert.equal(typeTag(when), 'dttm')
  assert.equal(cellText(when, 0), '2024-01-15 12:00:00')
})

test('low-cardinality strings become categories; factors keep level order', () => {
  const values = []
  for (let i = 0; i < 40; i++) values.push(['x', 'y', null, 'z'][i % 4])
  const chr = buildColumn('c', values)
  assert.equal(chr.type, 'category')
  assert.equal(typeTag(chr), 'chr')
  assert.deepEqual(chr.levels, ['x', 'y', 'z'])
  assert.deepEqual(chr.counts, [10, 10, 10])
  assert.equal(chr.codes[2], -1)

  const fct = buildColumn('f', ['lo', 'hi', 'lo'], { levels: ['hi', 'lo', 'unused'] })
  assert.equal(typeTag(fct), 'fct')
  assert.deepEqual(fct.levels, ['hi', 'lo', 'unused'])
  assert.deepEqual(Array.from(fct.codes), [1, 0, 1])
  assert.equal(columnStats(fct).distinct, 2)
})

test('high-cardinality strings stay strings with natural sort order', () => {
  const values = []
  for (let i = 1; i <= 120; i++) values.push('id_' + i)
  values.push(null)
  const col = buildColumn('s', values)
  assert.equal(col.type, 'string')
  const key = sortKey(col)
  assert.ok(key[1] < key[9], 'id_2 sorts before id_10')
  assert.ok(Number.isNaN(key[120]))
  assert.equal(lowerText(col)[0], 'id_1')
  assert.equal(columnStats(col).distinct, 120)
  assert.equal(columnStats(col).missing, 1)
})

test('nested values are shown as JSON text', () => {
  const values = []
  for (let i = 0; i < 60; i++) values.push({ a: i, b: [1, 2] })
  const col = buildColumn('n', values)
  assert.equal(cellText(col, 3), '{"a":3,"b":[1,2]}')
})

test('an all-missing column is handled', () => {
  const col = buildColumn('e', [null, undefined, null])
  assert.equal(col.nullCount, 3)
  assert.equal(cellText(col, 0), null)
  assert.equal(columnStats(col).distinct, 0)
})

test('columns with no values take their type from the file', async () => {
  const { buildColumn: build, typeTag: tag } = await import('../src/store.js')
  assert.equal(tag(build('x', [], { base: 'number', integer: true })), 'int')
  assert.equal(tag(build('x', [null, null], { base: 'number' })), 'dbl')
  assert.equal(tag(build('x', [null], { base: 'boolean' })), 'lgl')
  assert.equal(tag(build('x', [null], {})), 'chr')
  assert.equal(build('x', [null, null], { base: 'number' }).nullCount, 2)
})

test('the row panel shows numbers at full precision', async () => {
  const { detailText } = await import('../src/detail.js')
  const col = buildColumn('x', [1 / 3, null, Infinity, 12])
  assert.equal(detailText(col, 0), String(1 / 3))
  assert.equal(detailText(col, 1), null)
  assert.equal(detailText(col, 2), 'Inf')
  assert.equal(detailText(col, 3), '12')
  const day = buildColumn('d', [Date.UTC(2024, 1, 3)], { kind: 'date' })
  assert.equal(detailText(day, 0), '2024-02-03')
})
