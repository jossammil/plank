import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildColumn } from '../src/store.js'
import { computeView, emptySpec } from '../src/filters.js'
import { parseQuery, compileQuery, evaluateQuery } from '../src/query.js'
import { fullQueryParts, formatFullQuery, ident } from '../src/sql.js'

// A small table with every column type, including awkward names and values.
const N = 400
const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647 })()
const pick = (a) => a[Math.floor(rnd() * a.length)]
const maybe = (v, p = 0.1) => (rnd() < p ? null : v)
const cols = [
  buildColumn('age', Array.from({ length: N }, () => maybe(18 + Math.floor(rnd() * 70)))),
  buildColumn('income x', Array.from({ length: N }, () => maybe(Math.round(rnd() * 2e5) / 10))),
  buildColumn('region', Array.from({ length: N }, () => maybe(pick(['West', 'South', "O'Hare", 'Mid west'])))),
  buildColumn('note', Array.from({ length: N }, (_, i) => maybe(pick(['Needs review', 'called 50%', 'left_msg', 'ok']) + ' ' + i, 0.3))),
  buildColumn('flag', Array.from({ length: N }, () => maybe(rnd() < 0.5))),
  buildColumn('day', Array.from({ length: N }, () => maybe(Date.UTC(2023, Math.floor(rnd() * 24), 1 + Math.floor(rnd() * 28)))), { kind: 'date' }),
]
const byName = new Map(cols.map((c) => [c.name, c]))
const spec = (over) => Object.assign(emptySpec(), over)

function viaQuery(parts) {
  const text = parts.join(' AND ')
  if (!text) return Array.from({ length: N }, (_, i) => i)
  const { ast } = parseQuery(text)
  const mask = evaluateQuery(compileQuery(ast, (name) => byName.get(name)), N, false)
  const out = []
  for (let i = 0; i < N; i++) if (mask[i]) out.push(i)
  return out
}

const cases = [
  { name: 'number range', f: { age: spec({ min: 30, max: 50 }) } },
  { name: 'open-ended, inverted with NA', f: { 'income x': spec({ min: 5000, invert: true }) } },
  { name: 'missing only', f: { age: spec({ na: 'only' }) } },
  { name: 'category list with a quote', f: { region: spec({ codes: new Set([0, 2]) }) } },
  { name: 'category inverted, NA hidden', f: { region: spec({ codes: new Set([1]), invert: true, na: 'exclude' }) } },
  { name: 'contains with % and _', f: { note: spec({ contains: '50%' }) } },
  { name: 'contains _', f: { note: spec({ contains: 't_m' }) } },
  { name: 'case-sensitive contains', f: { note: spec({ contains: 'Needs', caseSensitive: true }) } },
  { name: 'regex', f: { note: spec({ contains: '^(needs|ok)', mode: 'regex' }) } },
  { name: 'exact, inverted', f: { note: spec({ contains: cols[3].str.find(Boolean).toUpperCase(), mode: 'exact', invert: true }) } },
  { name: 'logical', f: { flag: spec({ bool: false }) } },
  { name: 'dates by month', f: { day: spec({ min: Date.UTC(2023, 5, 1), minText: '2023-06', max: Date.UTC(2023, 9, 1) - 1, maxText: '2023-09' }) } },
  {
    name: 'OR group with AND',
    f: {
      age: spec({ min: 70, join: 'or' }),
      'income x': spec({ min: 18000, join: 'or' }),
      region: spec({ codes: new Set([0]) }),
    },
  },
  { name: 'search terms', search: 'west 1' },
  { name: 'search NOT', search: 'review', searchInvert: true },
  { name: 'search regex', search: '^o', searchRegex: true },
  { name: 'query, inverted', query: "age > 40 OR region = 'West'", queryInvert: true, f: { flag: spec({ bool: true }) } },
]

for (const c of cases) {
  test(`full query matches the filters: ${c.name}`, () => {
    const filters = Object.entries(c.f || {}).map(([name, s]) => ({ col: byName.get(name), spec: s }))
    let qmask = null
    if (c.query) {
      const { ast } = parseQuery(c.query)
      qmask = evaluateQuery(compileQuery(ast, (name) => byName.get(name)), N, !!c.queryInvert)
    }
    const want = Array.from(computeView({
      n: N, filters, search: c.search || '', searchRegex: !!c.searchRegex, searchInvert: !!c.searchInvert,
      searchCols: cols, queryMask: qmask,
    }))
    const parts = fullQueryParts({
      filters, searchCols: cols, search: c.search || '', searchRegex: !!c.searchRegex,
      searchInvert: !!c.searchInvert, query: c.query || '', queryInvert: !!c.queryInvert,
    })
    assert.ok(parts.length > 0)
    assert.deepEqual(viaQuery(parts), want)
    assert.ok(want.length > 0 && want.length < N, `case should filter something (${want.length})`)
  })
}

test('formatting and quoting', () => {
  assert.equal(formatFullQuery([]), '')
  assert.equal(formatFullQuery(['a = 1', 'b = 2']), 'WHERE a = 1\n  AND b = 2')
  assert.equal(ident('age'), 'age')
  assert.equal(ident('income x'), '"income x"')
  assert.equal(ident('order'), 'order')
  assert.equal(ident('not'), '"not"')
  assert.equal(ident('say "hi"'), '`say "hi"`')
})
