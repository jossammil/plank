import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { unlockPayload, WrongPassword } from '../src/crypto.js'
import { openDataset } from '../src/load.js'
import { cellText } from '../src/store.js'

// Written by R: encrypt_payload(plank(df, title, notes, where)$x, ..., "s3cret pass", iter = 1000)
const x = JSON.parse(readFileSync(new URL('./fixtures/encrypted.json', import.meta.url), 'utf8'))

test('the protected payload shows nothing but its title', () => {
  const text = JSON.stringify(x)
  assert.equal(x.title, 'Secret data')
  for (const leak of ['region', 'West', 'hidden note', 'income']) assert.ok(!text.includes(leak), leak)
})

test('the right password gives back the data and its hidden fields', async () => {
  const { fields, bytes } = await unlockPayload(x, 's3cret pass')
  assert.equal(fields.notes, 'hidden note')
  assert.equal(fields.where, 'income > 20')
  assert.deepEqual(fields.meta.region.levels, ['North', 'South', 'West'])
  const ds = openDataset(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), fields.meta)
  assert.equal(ds.n, 4)
  const region = await ds.column('region')
  assert.equal(cellText(region, 1), 'South')
  const income = await ds.column('income')
  assert.equal(income.isNull[1], 1)
})

test('a wrong password, or changed data, is refused', async () => {
  await assert.rejects(unlockPayload(x, 'wrong'), WrongPassword)
  const bytes = Buffer.from(x.data, 'base64')
  bytes[bytes.length - 1] ^= 1
  await assert.rejects(unlockPayload({ ...x, data: bytes.toString('base64') }, 's3cret pass'), WrongPassword)
})
