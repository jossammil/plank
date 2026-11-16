import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildColumn } from '../src/store.js'
import { parseQuery, compileQuery, evaluateQuery, resolveColumn, QueryError } from '../src/query.js'

const many = (k) => Array.from({ length: k }, (_, i) => 'pad_' + i)
const N = 8
const cols = {
  age: buildColumn('age', [25, 35, null, 45, 30, 40, 18, 60]),
  income: buildColumn('income', [10.5, 20, 30, null, 50, 60, 70, 80]),
  region: buildColumn('region', ['West', 'South', 'West', 'North', null, 'East', 'South', 'West']),
  comment: buildColumn('comment', ['needs review', 'called', null, 'Review later', '50% done', 'a_b', 'ok', 'call back'].concat(many(100))),
  flag: buildColumn('flag', [true, false, null, true, false, true, null, false]),
  day: buildColumn('day', [0, 1, 2, 3, 4, 5, 6, null].map((d) => (d === null ? null : Date.UTC(2024, 2, 9 + d))), { kind: 'date' }),
  // 05:00 UTC on 10 March is still 9 March (23:00) in Chicago
  when: buildColumn('when', [Date.UTC(2024, 2, 10, 5), Date.UTC(2024, 2, 10, 7), null, Date.UTC(2024, 2, 11, 12), 0, 0, 0, 0], { kind: 'datetime', tz: 'America/Chicago' }),
  'Sepal.Length': buildColumn('Sepal.Length', [1, 2, 3, 4, 5, 6, 7, 8]),
  'odd name': buildColumn('odd name', [1, 0, 1, 0, 1, 0, 1, 0]),
}
const names = Object.keys(cols)

function rows(text, invert = false) {
  const { ast, columns } = parseQuery(text)
  for (const c of columns) {
    const name = resolveColumn(c.name, names)
    if (!name) throw new QueryError(`Unknown column '${c.name}'`, c.pos)
    c.resolved = name
  }
  const map = new Map(columns.map((c) => [c.name, c.resolved]))
  const test = compileQuery(ast, (name) => cols[map.get(name) || name])
  const mask = evaluateQuery(test, N, invert)
  const out = []
  for (let i = 0; i < N; i++) if (mask[i]) out.push(i)
  return out
}

test('blank query parses to nothing', () => {
  assert.equal(parseQuery('   ').ast, null)
})

test('comparisons and NULL never match', () => {
  assert.deepEqual(rows('age > 30'), [1, 3, 5, 7])
  assert.deepEqual(rows('age >= 30 AND age <= 40'), [1, 4, 5])
  assert.deepEqual(rows('age = 35'), [1])
  assert.deepEqual(rows('age <> 35'), [0, 3, 4, 5, 6, 7])
  assert.deepEqual(rows('age == 35 OR age != 35'), [0, 1, 3, 4, 5, 6, 7])
  assert.deepEqual(rows('30 < age'), [1, 3, 5, 7])
  assert.deepEqual(rows('age = NULL'), [])
})

test('precedence: AND binds tighter than OR; parentheses and NOT', () => {
  assert.deepEqual(rows("region = 'West' OR region = 'South' AND age > 30"), [0, 1, 2, 7])
  assert.deepEqual(rows("(region = 'West' OR region = 'South') AND age > 30"), [1, 7])
  assert.deepEqual(rows('NOT age > 30'), [0, 4, 6])
  // row 6: age 18 but flag missing, so NOT (FALSE OR NULL) is NULL and the row is dropped
  assert.deepEqual(rows('NOT (age > 30 OR flag)'), [4])
})

test('three-valued logic: unknown OR true is true, unknown AND false is false', () => {
  // row 2 has missing age and missing flag
  assert.ok(rows('age > 30 OR TRUE').includes(2))
  assert.ok(rows('NOT (age > 30 AND FALSE)').includes(2))
  assert.ok(!rows('NOT (age > 30)').includes(2))
})

test('IN, NOT IN, BETWEEN', () => {
  assert.deepEqual(rows("region IN ('West', 'East')"), [0, 2, 5, 7])
  assert.deepEqual(rows("region NOT IN ('West', 'East')"), [1, 3, 6])
  assert.deepEqual(rows('age IN (18, 60)'), [6, 7])
  assert.deepEqual(rows('age BETWEEN 30 AND 45'), [1, 3, 4, 5])
  assert.deepEqual(rows('age NOT BETWEEN 30 AND 45'), [0, 6, 7])
})

test('LIKE is case-insensitive with % and _ wildcards and escapes', () => {
  assert.deepEqual(rows("comment LIKE '%review%'"), [0, 3])
  assert.deepEqual(rows("comment ILIKE 'call%'"), [1, 7])
  assert.deepEqual(rows("comment LIKE 'a_b'"), [5])
  assert.deepEqual(rows("comment LIKE 'a\\_b'"), [5])
  assert.deepEqual(rows("comment LIKE '50!%%' ESCAPE '!'"), [4])
  assert.deepEqual(rows("comment NOT LIKE '%review%'"), [1, 4, 5, 6, 7])
})

test('REGEXP is case-sensitive; IREGEXP and ~* are not', () => {
  assert.deepEqual(rows("comment REGEXP 'review|call'"), [0, 1, 7])
  assert.deepEqual(rows("comment IREGEXP '^review'"), [3])
  assert.deepEqual(rows("comment ~* 'REVIEW'"), [0, 3])
  assert.deepEqual(rows("comment !~ 'e'"), [5, 6, 7])
  assert.deepEqual(rows("region RLIKE '^(W|E)'"), [0, 2, 5, 7])
  assert.throws(() => rows("comment REGEXP '('"), /Invalid regular expression/)
})

test('IS NULL and IS NOT NULL', () => {
  assert.deepEqual(rows('age IS NULL'), [2])
  assert.deepEqual(rows('region IS NOT NULL AND flag IS NULL'), [2, 6])
})

test('logical columns can be used directly', () => {
  assert.deepEqual(rows('flag'), [0, 3, 5])
  assert.deepEqual(rows('NOT flag'), [1, 4, 7])
  assert.deepEqual(rows('flag = TRUE'), [0, 3, 5])
})

test('dates compare against whole periods', () => {
  assert.deepEqual(rows("day = '2024-03-10'"), [1])
  assert.deepEqual(rows("day BETWEEN '2024-03-10' AND '2024-03-12'"), [1, 2, 3])
  assert.deepEqual(rows("day >= '2024-03-14'"), [5, 6])
  assert.deepEqual(rows("day < '2024-03-10'"), [0])
  assert.deepEqual(rows("day = '2024-03'"), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(rows("YEAR(day) = 2024 AND DAY(day) > 13"), [5, 6])
  assert.throws(() => rows("day = 'soon'"), /is not a date/)
})

test('date-times use the column time zone', () => {
  assert.deepEqual(rows("when = '2024-03-09'").filter((i) => i < 4), [0])
  assert.deepEqual(rows("when = '2024-03-10'"), [1])
  assert.deepEqual(rows("DAY(when) = 10"), [1])
})

test('arithmetic and functions', () => {
  assert.deepEqual(rows('income / 10 > 5'), [5, 6, 7])
  assert.deepEqual(rows('age * 2 + 1 = 71'), [1])
  assert.deepEqual(rows('-age < -50'), [7])
  assert.deepEqual(rows("LOWER(region) = 'west'"), [0, 2, 7])
  assert.deepEqual(rows("UPPER(comment) LIKE 'CALL%'"), [1, 7])
  assert.deepEqual(rows('LENGTH(comment) = 2'), [6])
  assert.deepEqual(rows('ABS(age - 40) <= 5'), [1, 3, 5])
})

test('quoted and dotted column names; case-insensitive resolution', () => {
  assert.deepEqual(rows('Sepal.Length > 6'), [6, 7])
  assert.deepEqual(rows('"odd name" = 1 AND `Sepal.Length` < 4'), [0, 2])
  assert.deepEqual(rows('AGE > 50'), [7])
})

test('inverted query keeps everything that is not true, NULLs included', () => {
  const normal = rows('age > 30')
  const inverted = rows('age > 30', true)
  assert.deepEqual(inverted, [0, 2, 4, 6])
  assert.equal(normal.length + inverted.length, N)
})

test('errors name the problem and position', () => {
  const err = (text) => {
    try {
      rows(text)
    } catch (e) {
      return e
    }
    return null
  }
  assert.match(err('agee > 3').message, /Unknown column 'agee' \(at character 1\)/)
  assert.match(err('age > ').message, /Unexpected end of query/)
  assert.match(err("region = 'West").message, /Unclosed text/)
  assert.match(err('age > 3 age').message, /Unexpected 'age' \(at character 9\)/)
  assert.match(err('age BETWEEN 1 OR 2').message, /Expected AND/)
  assert.match(err('region + 1 > 2').message, /needs numbers, but 'region' is text/)
  assert.match(err("age > 'abc'").message, /Cannot compare a number column \('age'\) with text 'abc'/)
  assert.match(err('age').message, /not a logical column/)
  assert.match(err('foo(age) > 1').message, /Unknown function foo\(\)/)
  assert.match(err('age > 3 #').message, /Unexpected character '#'/)
})

test('IS [NOT] TRUE / FALSE never returns unknown', () => {
  const age = buildColumn('age', [20, 40, null, 60])
  const flag = buildColumn('flag', [true, null, false, true])
  const get = (name) => ({ age, flag })[name]
  const rows = (q) => Array.from(evaluateQuery(compileQuery(parseQuery(q).ast, get), 4, false))
  assert.deepEqual(rows('(age > 30) IS TRUE'), [0, 1, 0, 1])
  assert.deepEqual(rows('(age > 30) IS NOT TRUE'), [1, 0, 1, 0])
  assert.deepEqual(rows('(age > 30) IS FALSE'), [1, 0, 0, 0])
  assert.deepEqual(rows('flag IS NOT FALSE'), [1, 1, 0, 1])
  assert.throws(() => rows('age IS TRUE'), /needs a condition/)
})
