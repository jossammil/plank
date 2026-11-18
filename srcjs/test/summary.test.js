import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildColumn } from '../src/store.js'
import { parseQuery, compileQuery, evaluateQuery } from '../src/query.js'
import { makeMarker, setMarks } from '../src/markers.js'
import {
  groupKey, countGroups, sortGroups, groupCondition, excludeCondition, defaultBin, niceStep, groupTable, formatStat, statDecimals,
} from '../src/summary.js'

// A small random data set with every column type, missing values and
// awkward text (quotes, case, numbers in text).
function rand(seed) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}
const N = 600
const r = rand(7)
const pick = (xs) => xs[Math.floor(r() * xs.length)]
const maybe = (v, p = 0.08) => (r() < p ? null : v)
const raw = {
  region: [], state: [], name: [], age: [], income: [], flag: [], day: [], when: [], odd: [],
}
for (let i = 0; i < N; i++) {
  raw.region.push(maybe(pick(['West', 'South', 'North', 'East'])))
  raw.state.push(maybe(pick(['b', 'a', 'c'])))
  raw.name.push(maybe(pick(["O'Brien", 'obrien', 'OBrien', 'item 2', 'item 10', 'Ñandú', '', 'x"y'].concat(Array.from({ length: 40 }, (_, k) => 'n' + k)))))
  raw.age.push(maybe(18 + Math.floor(r() * 70)))
  raw.income.push(maybe(Math.round(r() * 2e5) / 100 - 50))
  raw.flag.push(maybe(r() < 0.5))
  raw.day.push(maybe(Date.UTC(2023, 0, 1) + Math.floor(r() * 800) * 86400000))
  // around the US daylight saving change on 10 March 2024
  raw.when.push(maybe(Date.UTC(2024, 2, 8) + Math.floor(r() * 5 * 24 * 60) * 60000 + Math.floor(r() * 60000)))
  raw.odd.push(maybe(pick([1.5, -2, 0, 3e-9, 1e21, Infinity, -Infinity, 7])))
}
const cols = {
  region: buildColumn('region', raw.region),
  state: buildColumn('state', raw.state, { levels: ['c', 'a', 'b', 'unused'] }),
  'full name': buildColumn('full name', raw.name),
  age: buildColumn('age', raw.age, { integer: true }),
  income: buildColumn('income', raw.income),
  flag: buildColumn('flag', raw.flag),
  day: buildColumn('day', raw.day, { kind: 'date' }),
  when: buildColumn('when', raw.when, { kind: 'datetime', tz: 'America/Chicago' }),
  odd: buildColumn('odd', raw.odd),
}
const marker = makeMarker('mark', N)
setMarks(marker, Array.from({ length: 200 }, (_, k) => k * 3), 'yes')
setMarks(marker, [1, 4, 7], 'no')
cols.mark = marker

const all = Uint32Array.from({ length: N }, (_, i) => i)
const where = (text) => {
  const { ast } = parseQuery(text)
  const t = compileQuery(ast, (name) => cols[name])
  return evaluateQuery(t, N)
}

// Every group's condition selects exactly its rows, and the exclude
// condition exactly the rest (missing values included).
function checkConditions(keys, view = all) {
  const groups = countGroups(view, keys)
  const total = groups.reduce((a, g) => a + g.count, 0)
  assert.equal(total, view.length)
  for (const g of groups) {
    const inside = where(groupCondition(keys, g))
    const outside = where(excludeCondition(keys, g))
    let n = 0
    for (let i = 0; i < N; i++) {
      const member = keys[0].ids[i] === g.a && (!keys[1] || keys[1].ids[i] === g.b)
      assert.equal(inside[i], member ? 1 : 0, `${groupCondition(keys, g)} at row ${i}`)
      assert.equal(outside[i], member ? 0 : 1, `${excludeCondition(keys, g)} at row ${i}`)
      if (member && view.includes(i)) n++
    }
    assert.equal(g.count, n)
  }
  return groups
}

test('each column type groups by value, and conditions select the group', () => {
  for (const name of ['region', 'state', 'full name', 'age', 'flag', 'day', 'mark', 'odd']) {
    const key = groupKey(cols[name], 'value')
    checkConditions([key])
  }
})

test('dates and date-times group by period in the column time zone', () => {
  for (const bin of ['value', 'month', 'year']) checkConditions([groupKey(cols.day, bin)])
  for (const bin of ['day', 'hour', 'month', 'year', 'value']) checkConditions([groupKey(cols.when, bin)])
  // Local days: 05:00 UTC on 10 March is 9 March in Chicago.
  const one = buildColumn('t', [Date.UTC(2024, 2, 10, 5), Date.UTC(2024, 2, 10, 7)], { kind: 'datetime', tz: 'America/Chicago' })
  const key = groupKey(one, 'day')
  assert.deepEqual([key.label(key.ids[0]), key.label(key.ids[1])], ['2024-03-09', '2024-03-10'])
  const hours = groupKey(one, 'hour')
  assert.deepEqual([hours.label(hours.ids[0]), hours.label(hours.ids[1])], ['2024-03-09 23:00', '2024-03-10 01:00'])
})

test('number ranges have round edges and cover infinities', () => {
  checkConditions([groupKey(cols.income, 'range')])
  checkConditions([groupKey(cols.odd, 'range')])
  checkConditions([groupKey(cols.age, 'range')])
  const key = groupKey(cols.income, 'range')
  assert.ok(key.k >= 5 && key.k <= 20, `${key.k} ranges`)
  assert.equal(key.label(0), '[-200, 0)')
  assert.equal(niceStep(2050, 10), 200)
  assert.equal(niceStep(7, 10, true), 1)
  assert.equal(niceStep(0.025, 10), 0.002)
  assert.equal(defaultBin(cols.age), 'range')
  assert.equal(defaultBin(buildColumn('k', [1, 2, 2, 3])), 'value')
  assert.equal(defaultBin(cols.when), 'day')
})

test('two keys count every combination present, over a filtered view', () => {
  const view = Uint32Array.from(all.filter((i) => i % 3 !== 0))
  const keys = [groupKey(cols.region), groupKey(cols.flag)]
  const groups = checkConditions(keys, view)
  assert.ok(groups.length <= 15)
  checkConditions([groupKey(cols.day, 'month'), groupKey(cols['full name'])], view)
  checkConditions([groupKey(cols.mark), groupKey(cols.state)])
})

test('statistics per group match a direct calculation', () => {
  const keys = [groupKey(cols.region)]
  for (const stat of ['mean', 'median', 'sum', 'min', 'max']) {
    const groups = countGroups(all, keys, cols.income, stat)
    for (const g of groups) {
      const vals = []
      for (let i = 0; i < N; i++) {
        if (keys[0].ids[i] === g.a && raw.income[i] !== null) vals.push(raw.income[i])
      }
      vals.sort((a, b) => a - b)
      const want = !vals.length ? null
        : stat === 'mean' ? vals.reduce((a, b) => a + b, 0) / vals.length
          : stat === 'sum' ? vals.reduce((a, b) => a + b, 0)
            : stat === 'min' ? vals[0]
              : stat === 'max' ? vals[vals.length - 1]
                : vals.length % 2 ? vals[vals.length >> 1] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
      assert.equal(g.valid, vals.length)
      if (want === null) assert.equal(g.value, null)
      else assert.ok(Math.abs(g.value - want) < 1e-6, `${stat} ${g.value} vs ${want}`)
    }
  }
  const share = countGroups(all, keys, cols.flag, 'mean')
  for (const g of share) assert.ok(g.value === null || (g.value >= 0 && g.value <= 1))
  assert.equal(formatStat(0.25, cols.flag, 'mean'), '25.0%')
  assert.equal(formatStat(null, cols.income, 'mean'), 'NA')
})

test('statistics share one number of decimals so their points line up', () => {
  assert.equal(statDecimals([0.4523, 0.07, 12.3]), 4)
  assert.equal(statDecimals([62625.4, 62711.03, null, 62359.36]), 2)
  assert.equal(statDecimals([3, 120, -7, null]), 0)
  assert.equal(statDecimals([]), 0)
  assert.equal(statDecimals([Infinity, 2, NaN]), 0)
  // tiny statistics keep their own significant digits instead of rounding to zero
  assert.equal(statDecimals([0.0000012345, 0.5]), null)
  assert.equal(statDecimals([0.000123, 0.5]), 6)
  // the smallest value keeps its significant digits, up to the cap
  assert.equal(statDecimals([1 / 3, 1234.5678912]), 6)
  assert.equal(statDecimals([1 / 3, 1234.5678912], 3), 3)
  assert.equal(statDecimals([0.000012345], 7, 8), 8)
  assert.equal(statDecimals([2.5, 1e-12]), null)
  // significant digits limit large values: 1234567.891 has no decimals at 7 digits
  assert.equal(statDecimals([1234567.891]), 0)

  const num = { type: 'number', digits: 7 }
  const shown = [0.4523, 0.07, 12.3].map((v) => formatStat(v, num, 'mean', null, 4))
  assert.deepEqual(shown, ['0.4523', '0.0700', '12.3000'])
  assert.equal(formatStat(-0.00001, num, 'mean', null, 2), '0.00')
  assert.equal(formatStat(1234.5, num, 'sum', { decimals: null, big: true }, 2), '1,234.50')
  // a format's own decimals win
  assert.equal(formatStat(1234.5, num, 'sum', { decimals: 0, big: true }, 2), '1,235')
  assert.equal(formatStat(null, num, 'mean', null, 2), 'NA')
  assert.equal(formatStat(0.25, { type: 'boolean', digits: 7 }, 'mean', null, 2), '25.0%')
})

test('sorting by count, key and value; missing groups go last by key', () => {
  const keys = [groupKey(cols.state)]
  const groups = countGroups(all, keys)
  sortGroups(groups, keys, 'count', 'desc')
  for (let j = 1; j < groups.length; j++) assert.ok(groups[j - 1].count >= groups[j].count)
  sortGroups(groups, keys, 'key', 'asc')
  // factor level order: c, a, b, then NA
  assert.deepEqual(groups.map((g) => keys[0].label(g.a)), ['c', 'a', 'b', 'NA'])
  sortGroups(groups, keys, 'key', 'desc')
  assert.deepEqual(groups.map((g) => keys[0].label(g.a)), ['b', 'a', 'c', 'NA'])

  const names = [groupKey(cols['full name'])]
  const ng = sortGroups(countGroups(all, names), names, 'key', 'asc').map((g) => names[0].label(g.a))
  // natural order: item 2 before item 10
  assert.ok(ng.indexOf('item 2') < ng.indexOf('item 10'))
  assert.equal(ng[ng.length - 1], 'NA')

  const vg = countGroups(all, keys, cols.income, 'mean')
  sortGroups(vg, keys, 'value', 'asc')
  const vals = vg.map((g) => g.value).filter((v) => v !== null)
  for (let j = 1; j < vals.length; j++) assert.ok(vals[j - 1] <= vals[j])
})

test('large combinations of groups use a hash instead of a grid', () => {
  const n = 5000
  const a = buildColumn('a', Array.from({ length: n }, (_, i) => 'a' + i))
  const b = buildColumn('b', Array.from({ length: n }, (_, i) => 'b' + (i * 7919 % n)))
  const view = Uint32Array.from({ length: n }, (_, i) => i)
  const groups = countGroups(view, [groupKey(a), groupKey(b)])
  assert.equal(groups.length, n)
  assert.ok(groups.every((g) => g.count === 1))
})

test('the table for copying has a header and one line per group', () => {
  const keys = [groupKey(cols.region), groupKey(cols.flag)]
  const groups = sortGroups(countGroups(all, keys, cols.income, 'sum'), keys, 'key', 'asc')
  const t = groupTable(groups, keys, N, cols.income, 'sum')
  assert.deepEqual(t[0], ['region', 'flag', 'rows', 'percent', 'sum_income'])
  assert.equal(t.length, groups.length + 1)
  const total = t.slice(1).reduce((x, row) => x + +row[2], 0)
  assert.equal(total, N)
})

test('marker keys follow the marks as they change', () => {
  const m = makeMarker('m', 5)
  setMarks(m, [0, 1], 'b')
  setMarks(m, [2], 'a')
  let key = groupKey(m)
  let groups = sortGroups(countGroups(Uint32Array.of(0, 1, 2, 3, 4), [key]), [key], 'key', 'asc')
  assert.deepEqual(groups.map((g) => [key.label(g.a), g.count]), [['a', 1], ['b', 2], ['NA', 2]])
  setMarks(m, [3], 'a')
  key = groupKey(m)
  groups = sortGroups(countGroups(Uint32Array.of(0, 1, 2, 3, 4), [key]), [key], 'key', 'asc')
  assert.deepEqual(groups.map((g) => [key.label(g.a), g.count]), [['a', 2], ['b', 2], ['NA', 1]])
})
