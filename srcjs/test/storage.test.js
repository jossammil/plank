import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateKeys } from '../src/storage.js'

const fake = (init) => {
  const m = new Map(Object.entries(init))
  return {
    get length() { return m.size },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  }
}

test('old pqview keys are copied to plank keys once', () => {
  const s = fake({ 'pqview.theme': 'dark', 'pqview.views.abc': '[1]', 'plank.font': 'sans', 'pqview.font': 'serif', other: 'x' })
  assert.equal(migrateKeys(s), 2)
  assert.equal(s.getItem('plank.theme'), 'dark')
  assert.equal(s.getItem('plank.views.abc'), '[1]')
  assert.equal(s.getItem('plank.font'), 'sans', 'a newer choice is kept')
  assert.equal(s.getItem('pqview.theme'), 'dark', 'old keys are left alone')
  s.setItem('pqview.theme', 'vintage')
  assert.equal(migrateKeys(s), 0, 'only once')
  assert.equal(s.getItem('plank.theme'), 'dark')
})

test('missing or blocked storage is fine', () => {
  assert.equal(migrateKeys(null), 0)
  assert.equal(migrateKeys({ getItem: () => { throw new Error('blocked') } }), 0)
})
