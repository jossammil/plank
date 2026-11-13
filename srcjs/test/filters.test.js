import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildColumn } from '../src/store.js'
import { computeView, emptySpec, isActive, textError, compileRegex, hasOptions } from '../src/filters.js'

const N = 12
const num = buildColumn('num', [5, 3, null, 8, 1, 9, 2, null, 7, 4, 6, 10])
const names = ['apple', 'Banana', 'cherry', null, 'apple pie', 'date', 'elder', 'fig', 'grape', 'kiwi', 'lime', 'mango']
// force a plain string column (12 distinct of 12 would otherwise be a category)
const many = []
for (let i = 0; i < 200; i++) many.push('filler_' + i)
const str = buildColumn('str', names.concat(many))
const cat = buildColumn('cat', ['a', 'b', 'a', 'c', null, 'b', 'a', 'c', 'a', 'b', 'a', 'c'], { levels: ['c', 'b', 'a'] })
const lgl = buildColumn('lgl', [true, false, null, true, false, true, null, false, true, true, false, false])
const day = buildColumn('day', Array.from({ length: N }, (_, i) => Date.UTC(2024, 0, 1 + i)), { kind: 'date' })

const spec = (over) => Object.assign(emptySpec(), over)
const rows = (q) => Array.from(computeView(Object.assign({ n: N }, q)))

test('no filters returns every row in order', () => {
  assert.deepEqual(rows({}), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(isActive(num, emptySpec()), false)
})

test('numeric range is inclusive and drops missing values', () => {
  assert.deepEqual(rows({ filters: [{ col: num, spec: spec({ min: 3, max: 6 }) }] }), [0, 1, 9, 10])
  assert.deepEqual(rows({ filters: [{ col: num, spec: spec({ min: 9 }) }] }), [5, 11])
  assert.deepEqual(rows({ filters: [{ col: num, spec: spec({ max: 1 }) }] }), [4])
})

test('missing-value toggle', () => {
  assert.deepEqual(rows({ filters: [{ col: num, spec: spec({ na: 'only' }) }] }), [2, 7])
  assert.equal(rows({ filters: [{ col: num, spec: spec({ na: 'exclude' }) }] }).length, 10)
  assert.equal(isActive(num, spec({ na: 'exclude' })), true)
})

test('text contains is case-insensitive', () => {
  const view = Array.from(computeView({ n: str.n, filters: [{ col: str, spec: spec({ contains: 'APPLE' }) }] }))
  assert.deepEqual(view, [0, 4])
})

test('category membership', () => {
  const a = cat.levels.indexOf('a')
  const c = cat.levels.indexOf('c')
  assert.deepEqual(rows({ filters: [{ col: cat, spec: spec({ codes: new Set([c]) }) }] }), [3, 7, 11])
  assert.equal(rows({ filters: [{ col: cat, spec: spec({ codes: new Set([a, c]) }) }] }).length, 8)
  assert.deepEqual(rows({ filters: [{ col: cat, spec: spec({ codes: new Set() }) }] }), [])
})

test('boolean and date filters', () => {
  assert.deepEqual(rows({ filters: [{ col: lgl, spec: spec({ bool: true }) }] }), [0, 3, 5, 8, 9])
  assert.deepEqual(rows({ filters: [{ col: lgl, spec: spec({ bool: false }) }] }), [1, 4, 7, 10, 11])
  const range = spec({ min: Date.UTC(2024, 0, 3), max: Date.UTC(2024, 0, 5) })
  assert.deepEqual(rows({ filters: [{ col: day, spec: range }] }), [2, 3, 4])
})

test('filters on several columns are combined with AND', () => {
  const a = cat.levels.indexOf('a')
  assert.deepEqual(rows({
    filters: [
      { col: num, spec: spec({ min: 5 }) },
      { col: cat, spec: spec({ codes: new Set([a]) }) },
    ],
  }), [0, 8, 10])
})

test('global search: every term must appear in some column', () => {
  const cols = [num, cat, lgl, day]
  assert.deepEqual(rows({ search: '2024-01-03', searchCols: cols }), [2])
  assert.deepEqual(rows({ search: 'true c', searchCols: cols }), [3])
  assert.deepEqual(rows({ search: '10', searchCols: [num] }), [11])
  assert.deepEqual(rows({ search: 'zzz', searchCols: cols }), [])
  assert.equal(rows({ search: '   ', searchCols: cols }).length, N)
})

test('sorting: missing last in both directions, stable, multi-key', () => {
  assert.deepEqual(rows({ sort: [{ col: num, dir: 'asc' }] }), [4, 6, 1, 9, 0, 10, 8, 3, 5, 11, 2, 7])
  assert.deepEqual(rows({ sort: [{ col: num, dir: 'desc' }] }), [11, 5, 3, 8, 10, 0, 9, 1, 6, 4, 2, 7])
  // factor level order is c, b, a
  assert.deepEqual(rows({ sort: [{ col: cat, dir: 'asc' }] }), [3, 7, 11, 1, 5, 9, 0, 2, 6, 8, 10, 4])
  assert.deepEqual(
    rows({ sort: [{ col: cat, dir: 'asc' }, { col: num, dir: 'desc' }] }),
    [11, 3, 7, 5, 9, 1, 8, 10, 0, 6, 2, 4],
  )
})

test('inverted filters keep the true complement, missing values included', () => {
  const normal = rows({ filters: [{ col: num, spec: spec({ min: 3, max: 6 }) }] })
  const inverted = rows({ filters: [{ col: num, spec: spec({ min: 3, max: 6, invert: true }) }] })
  assert.deepEqual(inverted, [2, 3, 4, 5, 6, 7, 8, 11])
  assert.equal(normal.length + inverted.length, N)
  // the missing option still applies on top
  const noNA = rows({ filters: [{ col: num, spec: spec({ min: 3, max: 6, invert: true, na: 'exclude' }) }] })
  assert.deepEqual(noNA, [3, 4, 5, 6, 8, 11])

  const c = cat.levels.indexOf('c')
  assert.deepEqual(rows({ filters: [{ col: cat, spec: spec({ codes: new Set([c]), invert: true }) }] }), [0, 1, 2, 4, 5, 6, 8, 9, 10])
  assert.deepEqual(rows({ filters: [{ col: lgl, spec: spec({ bool: true, invert: true }) }] }), [1, 2, 4, 6, 7, 10, 11])
  // invert without a value filter does nothing
  assert.equal(rows({ filters: [{ col: num, spec: spec({ invert: true }) }] }).length, N)
})

test('text match modes: contains, exact, regex, case sensitivity', () => {
  const m = (over) => Array.from(computeView({ n: str.n, filters: [{ col: str, spec: spec(over) }] }))
  assert.deepEqual(m({ contains: 'APPLE' }), [0, 4])
  assert.deepEqual(m({ contains: 'APPLE', caseSensitive: true }), [])
  assert.deepEqual(m({ contains: 'apple', mode: 'exact' }), [0])
  assert.deepEqual(m({ contains: 'banana', mode: 'exact' }), [1])
  assert.deepEqual(m({ contains: 'banana', mode: 'exact', caseSensitive: true }), [])
  assert.deepEqual(m({ contains: '^(apple|date)$', mode: 'regex' }), [0, 5])
  assert.deepEqual(m({ contains: '^b', mode: 'regex', caseSensitive: true }), [])
  assert.deepEqual(m({ contains: '^B', mode: 'regex', caseSensitive: true }), [1])
  const inverted = m({ contains: '^filler_', mode: 'regex', invert: true })
  assert.deepEqual(inverted, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})

test('an invalid regex is reported and ignored instead of hiding rows', () => {
  const s = spec({ contains: '(unclosed', mode: 'regex' })
  assert.match(textError(s), /Unterminated group|missing \)/i)
  assert.equal(isActive(str, s), false)
  assert.equal(computeView({ n: str.n, filters: [{ col: str, spec: s }] }).length, str.n)
  assert.equal(textError(spec({ contains: '(unclosed' })), null)
  assert.equal(compileRegex('a+').re.test('AAA'), true)
  assert.equal(compileRegex('a+', true).re.test('AAA'), false)
})

test('global search: regex mode and NOT', () => {
  const cols = [num, cat, lgl, day]
  assert.deepEqual(rows({ search: '^c$', searchRegex: true, searchCols: [cat] }), [3, 7, 11])
  assert.deepEqual(rows({ search: '2024-01-0[1-3]', searchRegex: true, searchCols: cols }), [0, 1, 2])
  const hits = rows({ search: 'true c', searchCols: cols })
  const misses = rows({ search: 'true c', searchInvert: true, searchCols: cols })
  assert.deepEqual(hits, [3])
  assert.equal(hits.length + misses.length, N)
  assert.deepEqual(rows({ search: '^c$', searchRegex: true, searchInvert: true, searchCols: [cat] }), [0, 1, 2, 4, 5, 6, 8, 9, 10])
  // a broken pattern leaves every row in place
  assert.equal(rows({ search: '[', searchRegex: true, searchCols: cols }).length, N)
})

test('a query mask combines with the column filters', () => {
  const queryMask = Uint8Array.from([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(rows({ queryMask, filters: [{ col: num, spec: spec({ min: 4 }) }] }), [0, 3, 5])
  assert.equal(hasOptions(emptySpec()), false)
  assert.equal(hasOptions(spec({ invert: true })), true)
})
