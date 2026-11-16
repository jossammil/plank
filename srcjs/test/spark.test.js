import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildColumn } from '../src/store.js'
import { distribution, overlayCounts, chartSVG } from '../src/spark.js'

const sum = (a) => a.reduce((x, y) => x + y, 0)

test('numbers get equal-width bins plus a missing count', () => {
  const vals = []
  for (let i = 0; i < 1000; i++) vals.push(i % 50 === 0 ? null : i / 10)
  const col = buildColumn('x', vals)
  const d = distribution(col)
  assert.equal(d.kind, 'range')
  assert.equal(d.bins.length, 24)
  assert.equal(d.missing, 20)
  assert.equal(sum(d.bins.map((b) => b.count)) + d.missing, 1000)
})

test('small integer ranges get one bin per value; infinities do not break bins', () => {
  const col = buildColumn('k', [1, 2, 2, 3, 3, 3, null], { integer: true })
  const d = distribution(col)
  assert.deepEqual(d.bins.map((b) => [b.label, b.count]), [['1', 1], ['2', 2], ['3', 3]])
  const inf = buildColumn('i', [1, 2, Infinity, -Infinity, NaN, 3.5])
  const di = distribution(inf)
  assert.equal(sum(di.bins.map((b) => b.count)) + di.missing, 6)
  assert.equal(di.missing, 1)
})

test('categories keep the top 8 levels and pool the rest', () => {
  const vals = []
  for (let k = 0; k < 12; k++) for (let j = 0; j <= k; j++) vals.push('v' + k)
  vals.push(null)
  const col = buildColumn('c', vals, { levels: Array.from({ length: 12 }, (_, k) => 'v' + k) })
  const d = distribution(col)
  assert.equal(d.kind, 'levels')
  assert.equal(d.bins.length, 9)
  assert.equal(d.bins[0].label, 'v11')
  assert.match(d.bins[8].label, /4 other values/)
  assert.equal(sum(d.bins.map((b) => b.count)) + d.missing, vals.length)
})

test('logicals, dates and free text', () => {
  const l = distribution(buildColumn('l', [true, false, true, null]))
  assert.deepEqual(l.bins.map((b) => b.count), [2, 1])
  assert.equal(l.missing, 1)
  const day = buildColumn('d', [Date.UTC(2024, 0, 1), Date.UTC(2024, 5, 1), null], { kind: 'date' })
  assert.match(distribution(day).bins[0].label, /^2024-01-01 to /)
  const many = Array.from({ length: 300 }, (_, i) => (i === 7 ? null : 'text ' + i))
  const s = distribution(buildColumn('s', many))
  assert.equal(s.kind, 'presence')
  assert.deepEqual([s.bins[0].count, s.missing], [299, 1])
})

test('overlay counts add up to the view and show in the SVG', () => {
  const col = buildColumn('x', [1, 2, 3, null, 5, 6, 7, 8, 9, 10])
  const view = Uint32Array.from([0, 3, 4, 9])
  const on = overlayCounts(col, view)
  assert.equal(sum(Array.from(on)), 4)
  assert.equal(on[on.length - 1], 1)
  const svg = chartSVG(col, on)
  assert.match(svg, /data-on="4"/)
  assert.match(svg, /class="pqv-spk-on"/)
  assert.doesNotMatch(chartSVG(col, null), /data-on/)
  assert.match(chartSVG(buildColumn('<b>', [1, 2])), /Distribution of &lt;b&gt;/)
})
