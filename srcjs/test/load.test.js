import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeBase64, openDataset } from '../src/load.js'
import { cellText, typeTag } from '../src/store.js'

const file = readFileSync(new URL('./fixtures/sample.parquet', import.meta.url))
const buffer = () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)

test('base64 round trip', () => {
  const bytes = decodeBase64(file.toString('base64'))
  assert.equal(bytes.length, file.length)
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x41, 0x52, 0x31])
})

test('columns are listed from the footer before any data is decoded', () => {
  const ds = openDataset(buffer(), { group: { levels: ['b', 'a', 'c'] } })
  assert.equal(ds.n, 100)
  assert.deepEqual(ds.fields.map((f) => f.name), ['id', 'value', 'name', 'group', 'flag', 'day', 'when'])
  assert.deepEqual(ds.fields.map((f) => f.tag), ['int', 'dbl', 'chr', 'fct', 'lgl', 'date', 'dttm'])
  assert.equal(ds.peek('id'), null)
})

test('columns decode across row groups with the right types', async () => {
  const ds = openDataset(buffer(), {
    group: { levels: ['b', 'a', 'c'] },
    when: { tz: 'America/Chicago' },
  })
  const id = await ds.column('id')
  assert.equal(id.n, 100)
  assert.deepEqual([id.num[0], id.num[39], id.num[40], id.num[99]], [1, 40, 41, 100])
  assert.equal(ds.peek('id'), id)

  assert.equal(typeTag(id), 'int')

  const value = await ds.column('value')
  assert.equal(typeTag(value), 'dbl')
  assert.equal(value.isNull[0], 1)
  assert.equal(value.num[99], 49.5)

  const name = await ds.column('name')
  assert.equal(cellText(name, 98), 'item_99')
  assert.equal(cellText(name, 99), null)

  const group = await ds.column('group')
  assert.equal(typeTag(group), 'fct')
  assert.deepEqual(group.levels, ['b', 'a', 'c'])
  assert.deepEqual([cellText(group, 0), cellText(group, 1), cellText(group, 3)], ['b', 'a', null])

  const flag = await ds.column('flag')
  assert.deepEqual([cellText(flag, 0), cellText(flag, 1), cellText(flag, 2)], ['TRUE', 'FALSE', null])

  const day = await ds.column('day')
  assert.equal(cellText(day, 0), '2024-01-01')
  assert.equal(cellText(day, 99), '2024-04-09')

  const when = await ds.column('when')
  // 12:00 UTC on 9 March 2024 is 06:00 in Chicago; DST starts the next morning
  assert.equal(cellText(when, 0), '2024-03-09 06:00:00')
  assert.equal(cellText(when, 24), '2024-03-10 07:00:00')
})

test('footer statistics give missing counts and ranges without decoding', () => {
  const ds = openDataset(buffer(), { group: { levels: ['b', 'a', 'c'] } })
  assert.deepEqual(ds.footerStats('id'), { nulls: 0, min: 1, max: 100 })
  assert.deepEqual(ds.footerStats('value'), { nulls: 1, min: 0.5, max: 49.5 })
  assert.equal(ds.footerStats('flag').nulls, 33)
  assert.deepEqual(ds.footerStats('day'), { nulls: 0, min: Date.UTC(2024, 0, 1), max: Date.UTC(2024, 3, 9) })
  assert.equal(ds.footerStats('nope'), null)
  assert.equal(ds.peek('id'), null) // still not decoded
})

test('gzip-compressed files decode the same as snappy ones', async () => {
  const gz = readFileSync(new URL('./fixtures/sample-gzip.parquet', import.meta.url))
  const a = openDataset(buffer())
  const b = openDataset(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength))
  assert.deepEqual(b.fields.map((f) => f.tag), a.fields.map((f) => f.tag))
  for (const f of a.fields) {
    const x = await a.column(f.name)
    const y = await b.column(f.name)
    assert.equal(y.error, null, f.name)
    for (let i = 0; i < x.n; i++) assert.equal(cellText(y, i), cellText(x, i), `${f.name} row ${i}`)
  }
})
