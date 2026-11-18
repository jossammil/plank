import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildColumn } from '../src/store.js'
import { emptySpec } from '../src/filters.js'
import {
  isDefaultSpec, specToView, specFromView, makeView, normalizeView, viewSignature, parseSaved, serializeSaved,
  describeView, viewToR,
} from '../src/views.js'

const region = buildColumn('region', ['West', 'South', 'West', 'North', null])
const cols = { region, age: buildColumn('age', [20, 30, 40, 50, null]) }

const state = (over = {}) => {
  const age = { ...emptySpec(), min: 30, minText: '30' }
  const reg = { ...emptySpec(), codes: new Set([region.levels.indexOf('West')]), join: 'or' }
  return {
    columns: ['age', 'region'],
    specs: [['age', age], ['region', reg], ['hidden', { ...emptySpec(), contains: 'x' }]],
    colOf: (name) => cols[name],
    search: 'abc',
    searchRegex: false,
    searchInvert: true,
    where: '  income > 3 ',
    whereInvert: false,
    sort: [{ name: 'age', dir: 'desc' }],
    counts: null,
    ...over,
  }
}

test('untouched filter specs are left out of views', () => {
  assert.ok(isDefaultSpec(emptySpec()))
  assert.ok(isDefaultSpec({ ...emptySpec(), paused: true }))
  assert.ok(!isDefaultSpec({ ...emptySpec(), na: 'exclude' }))
  assert.ok(!isDefaultSpec({ ...emptySpec(), codes: new Set() }))
  const v = makeView('v', state({ specs: [['age', emptySpec()]] }))
  assert.deepEqual(v.filters, [])
})

test('category filters are stored as level text and matched back', () => {
  const stored = specToView({ ...emptySpec(), codes: new Set([region.levels.indexOf('West'), region.levels.indexOf('North')]) }, region)
  assert.deepEqual(stored.values.slice().sort(), ['North', 'West'])
  // Levels in a different order (for example a rebuilt marker column)
  const other = buildColumn('region', ['North', 'East', 'West'])
  const spec = specFromView(stored, other, emptySpec)
  assert.deepEqual(Array.from(spec.codes).map((c) => other.levels[c]).sort(), ['North', 'West'])
  const lost = specFromView({ ...stored, values: ['Gone'] }, other, emptySpec)
  assert.equal(lost.codes.size, 0)
})

test('views keep shown columns, filters, search, query and sort', () => {
  const v = makeView('Mine', state())
  assert.equal(v.name, 'Mine')
  assert.deepEqual(v.columns, ['age', 'region'])
  assert.deepEqual(v.filters.map(([n]) => n), ['age', 'region'])
  assert.equal(v.filters[1][1].join, 'or')
  assert.equal(v.where, 'income > 3')
  assert.equal(v.searchInvert, true)
  assert.deepEqual(v.sort, [{ name: 'age', dir: 'desc' }])
  assert.match(describeView(v), /2 columns · 2 filters · search · WHERE · sorted by age ↓/)
})

test('signatures ignore names and the counts panel but see every filter change', () => {
  const a = makeView('a', state())
  const b = makeView('b', state({ counts: { by: ['region'] } }))
  assert.equal(viewSignature(a), viewSignature(b))
  const c = makeView('c', state({ sort: [{ name: 'age', dir: 'asc' }] }))
  assert.notEqual(viewSignature(a), viewSignature(c))
  const s = state()
  s.specs[0][1].paused = true
  assert.notEqual(viewSignature(a), viewSignature(makeView('d', s)))
})

test('saved views round-trip through JSON and bad entries are dropped', () => {
  const v = makeView('One', state({ counts: { by: ['region', 'age'], bins: [null, 'range'], value: 'age', stat: 'median' } }))
  const text = serializeSaved([v, { name: '' }, { nope: 1 }, makeView('One', state())])
  const back = parseSaved(text)
  assert.equal(back.length, 1)
  assert.equal(viewSignature(back[0]), viewSignature(v))
  assert.deepEqual(back[0].counts, { by: ['region', 'age'], bins: [null, 'range'], value: 'age', stat: 'median' })
  assert.deepEqual(parseSaved('not json'), [])
  assert.deepEqual(parseSaved('null'), [])
})

test('views from R: missing parts get defaults; scalars become lists', () => {
  const v = normalizeView({ name: ' West ', where: "region = 'West'", sort: { name: 'age', dir: 'desc' }, counts: 'region' })
  assert.equal(v.name, 'West')
  assert.equal(v.columns, null)
  assert.deepEqual(v.filters, [])
  assert.deepEqual(v.sort, [{ name: 'age', dir: 'desc' }])
  assert.deepEqual(v.counts.by, ['region'])
  assert.equal(normalizeView({ columns: ['a'] }), null)
  assert.deepEqual(normalizeView({ name: 'x', columns: 'a' }).columns, ['a'])
})

test('R code for a view', () => {
  const v = makeView('', state({ counts: { by: ['region'] } }))
  const code = viewToR(v, 'age >= 30 AND "odd \\\\ name" = \'x\'', 'My "view"')
  assert.equal(code, [
    '"My \\"view\\"" = pqview_view(',
    '  columns = c("age", "region"),',
    '  where = "age >= 30 AND \\"odd \\\\\\\\ name\\" = \'x\'",',
    '  sort = "-age",',
    '  counts = "region"',
    ')',
  ].join('\n'))
  const bare = viewToR(makeView('', state({ columns: [], sort: [] })), '')
  assert.equal(bare, 'pqview_view(\n  columns = character(0)\n)')
})

test('pinned columns are part of a view', () => {
  const v = makeView('p', state({ pinned: ['region', 'gone'] }))
  assert.deepEqual(v.pinned, ['region'])
  assert.notEqual(viewSignature(v), viewSignature(makeView('p', state())))
  assert.match(describeView(v), /1 pinned/)
  assert.match(viewToR(v, ''), /pin = "region"/)
  assert.deepEqual(normalizeView({ name: 'x', pinned: 'a' }).pinned, ['a'])
  assert.deepEqual(parseSaved(serializeSaved([v]))[0].pinned, ['region'])
})
