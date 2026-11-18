import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTheme, readAppearance, defaultAppearance, isDarkTheme, effectiveFont, rowHeight,
} from '../src/appearance.js'

const store = (saved) => (key) => (key in saved ? saved[key] : null)

test('theme names: light is Classic, unknown names are refused', () => {
  assert.equal(normalizeTheme('light'), 'classic')
  for (const t of ['auto', 'classic', 'modern', 'dark', 'vintage', 'terminal']) assert.equal(normalizeTheme(t), t)
  assert.equal(normalizeTheme('neon'), null)
  assert.equal(normalizeTheme(null), null)
})

test('defaults come from R, then the built-in ones', () => {
  assert.deepEqual(defaultAppearance({}), { theme: 'auto', accent: '', font: 'mono', size: 'normal', density: 'normal' })
  assert.deepEqual(defaultAppearance({ theme: 'vintage', font: 'serif' }),
    { theme: 'vintage', accent: '', font: 'serif', size: 'normal', density: 'normal' })
  assert.equal(defaultAppearance({ theme: 'light' }).theme, 'classic')
  assert.equal(defaultAppearance({ theme: 'bogus', font: 'comic' }).theme, 'auto')
  assert.equal(defaultAppearance({ font: 'comic' }).font, 'mono')
})

test('saved choices win over R', () => {
  const a = readAppearance(store({ theme: 'terminal', accent: 'teal', font: 'sans', size: 'large', density: 'roomy' }),
    { theme: 'dark', font: 'serif' })
  assert.deepEqual(a, { theme: 'terminal', accent: 'teal', font: 'sans', size: 'large', density: 'roomy' })
})

test('older saved preferences are migrated', () => {
  assert.equal(readAppearance(store({ theme: 'light' })).theme, 'classic')
  assert.equal(readAppearance(store({ mono: '0' }), { font: 'mono' }).font, 'sans')
  assert.equal(readAppearance(store({ mono: '1' }), { font: 'sans' }).font, 'mono')
  // a saved font beats the old Mono switch
  assert.equal(readAppearance(store({ mono: '0', font: 'serif' })).font, 'serif')
})

test('invalid saved values fall back', () => {
  const a = readAppearance(store({ theme: 'x', accent: 'chartreuse', font: 'x', size: 'huge', density: 'x' }), { theme: 'modern' })
  assert.deepEqual(a, { theme: 'modern', accent: '', font: 'mono', size: 'normal', density: 'normal' })
})

test('dark themes, Terminal font and row heights', () => {
  assert.equal(isDarkTheme('dark', false), true)
  assert.equal(isDarkTheme('terminal', false), true)
  assert.equal(isDarkTheme('auto', true), true)
  assert.equal(isDarkTheme('auto', false), false)
  assert.equal(isDarkTheme('vintage', true), false)
  assert.equal(effectiveFont({ theme: 'terminal', font: 'serif' }), 'mono')
  assert.equal(effectiveFont({ theme: 'classic', font: 'serif' }), 'serif')
  assert.equal(rowHeight({ density: 'compact' }), 22)
  assert.equal(rowHeight({ density: 'normal' }), 26)
  assert.equal(rowHeight({ density: 'roomy' }), 32)
})
