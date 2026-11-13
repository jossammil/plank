import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildColumn } from '../src/store.js'
import { toCSV } from '../src/csv.js'

test('CSV export quotes, keeps precision and leaves missing values empty', () => {
  const many = []
  for (let i = 0; i < 80; i++) many.push('row ' + i)
  const text = ['plain', 'has,comma', 'say "hi"', 'two\nlines', null].concat(many)
  const n = text.length
  const pad = (a) => a.concat(new Array(n - a.length).fill(null))
  const cols = [
    buildColumn('text, quoted', text),
    buildColumn('num', pad([0.1 + 0.2, 2, null, NaN, 5])),
    buildColumn('flag', pad([true, false, null, true, false])),
    buildColumn('day', pad([Date.UTC(2024, 1, 29), null]), { kind: 'date' }),
  ]
  const csv = toCSV(cols, Uint32Array.from([4, 0, 1, 2, 3])).join('')
  assert.equal(csv, [
    '"text, quoted",num,flag,day',
    ',5,FALSE,',
    'plain,0.30000000000000004,TRUE,2024-02-29',
    '"has,comma",2,FALSE,',
    '"say ""hi""",,,',
    '"two\nlines",NaN,TRUE,',
    '',
  ].join('\r\n'))
})

test('CSV export with no rows still writes the header', () => {
  const col = buildColumn('a', [1, 2])
  assert.equal(toCSV([col], new Uint32Array(0)).join(''), 'a\r\n')
})
