import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rNames } from '../src/picker.js'

test('column names are copied as an R vector', () => {
  assert.equal(rNames(['age', 'income', 'home region']), 'c("age", "income", "home region")')
  assert.equal(rNames(['x']), 'c("x")')
  assert.equal(rNames([]), 'c()')
})

test('quotes and backslashes in names are escaped', () => {
  assert.equal(rNames(['say "hi"', 'a\\b']), 'c("say \\"hi\\"", "a\\\\b")')
})

test('the about text names Plank, plank files and the credit', async () => {
  const { ABOUT } = await import('../src/keys.js')
  assert.match(ABOUT.lead, /^Plank is/)
  assert.match(ABOUT.file, /\.plank\.html/)
  assert.equal(ABOUT.credit, 'Frankensteined by MillJS.')
})
