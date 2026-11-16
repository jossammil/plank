import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeMarker, setMarks, usedValues, serializeMarkers, deserializeMarkers, fingerprint,
} from '../src/markers.js'
import { cellText, sortKey, columnStats, typeTag } from '../src/store.js'
import { computeView, emptySpec } from '../src/filters.js'
import { distribution } from '../src/spark.js'
import { toCSV } from '../src/csv.js'

test('marking rows in bulk and one at a time', () => {
  const col = makeMarker('flag', 6)
  assert.equal(typeTag(col), 'mark')
  assert.equal(col.nullCount, 6)
  assert.equal(setMarks(col, Uint32Array.from([0, 2, 4]), 'yes'), 3)
  assert.equal(setMarks(col, [2], 'no'), 1)
  assert.equal(setMarks(col, [0], 'yes'), 0)
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => cellText(col, i)), ['yes', null, 'no', null, 'yes', null])
  assert.deepEqual(col.counts, [2, 1])
  assert.equal(col.nullCount, 3)
  assert.deepEqual(usedValues(col), ['yes', 'no'])
  setMarks(col, [0, 4], null)
  assert.equal(col.nullCount, 5)
  assert.deepEqual(usedValues(col), ['no'])
})

test('caches are dropped when marks change', () => {
  const col = makeMarker('m', 4)
  setMarks(col, [1, 3], 'b')
  assert.equal(columnStats(col).distinct, 1)
  assert.equal(distribution(col).bins.length, 1)
  setMarks(col, [0], 'a')
  assert.equal(columnStats(col).distinct, 2)
  assert.equal(distribution(col).bins.length, 2)
  // sorted by text, not by the order values were added
  const key = sortKey(col)
  assert.ok(key[0] < key[1])
  assert.ok(Number.isNaN(key[2]))
})

test('marker columns filter like categories and export with row numbers', () => {
  const col = makeMarker('flag', 5)
  setMarks(col, [1, 3], 'yes')
  const spec = Object.assign(emptySpec(), { codes: new Set([0]) })
  const view = computeView({ n: 5, filters: [{ col, spec }] })
  assert.deepEqual(Array.from(view), [1, 3])
  const csv = toCSV([col], view, { rowNumbers: true }).join('')
  assert.equal(csv, 'row,flag\r\n2,yes\r\n4,yes\r\n')
  const clash = Object.assign(makeMarker('row', 2), {})
  assert.match(toCSV([clash], Uint32Array.from([0]), { rowNumbers: true }).join(''), /^\.row,row\r\n1,\r\n$/)
})

test('serialized marks round-trip and drop unused values', () => {
  const a = makeMarker('a', 1000)
  setMarks(a, [0, 10, 999], 'x')
  setMarks(a, [5], 'gone')
  setMarks(a, [5], null)
  const b = makeMarker('b', 1000)
  const many = []
  for (let i = 0; i < 300; i++) many.push(i)
  for (const i of many) setMarks(b, [i], 'v' + i)
  const text = JSON.stringify(serializeMarkers([a, b]))
  const back = deserializeMarkers(JSON.parse(text), 1000)
  assert.equal(back.length, 2)
  assert.deepEqual(back[0].levels, ['x'])
  assert.deepEqual([0, 5, 10, 999].map((i) => cellText(back[0], i)), ['x', null, 'x', 'x'])
  assert.equal(back[0].nullCount, 997)
  assert.equal(cellText(back[1], 299), 'v299')
  assert.equal(back[1].nullCount, 700)
  assert.deepEqual(deserializeMarkers(JSON.parse(text), 999), [])
  assert.deepEqual(deserializeMarkers(null, 10), [])
  assert.deepEqual(deserializeMarkers({ v: 1, cols: [{ name: 'z', levels: [], codes: '!!' }] }, 10), [])
})

test('fingerprint depends on the data', () => {
  const f = fingerprint(10, ['a', 'b'], 'QUJD')
  assert.match(f, /^[0-9a-f]{8}$/)
  assert.equal(f, fingerprint(10, ['a', 'b'], 'QUJD'))
  assert.notEqual(f, fingerprint(10, ['a', 'c'], 'QUJD'))
  assert.notEqual(f, fingerprint(11, ['a', 'b'], 'QUJD'))
  assert.notEqual(f, fingerprint(10, ['a', 'b'], 'QUJE'))
})
