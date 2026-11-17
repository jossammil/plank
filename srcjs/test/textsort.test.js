import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textSortKey } from '../src/textsort.js'

// Reference: ranks from a plain collator sort.
function naive(str, collator) {
  const idx = []
  for (let i = 0; i < str.length; i++) if (str[i] !== null) idx.push(i)
  idx.sort((a, b) => collator.compare(str[a], str[b]))
  const key = new Float64Array(str.length).fill(NaN)
  let rank = -1
  for (let k = 0; k < idx.length; k++) {
    if (k === 0 || collator.compare(str[idx[k - 1]], str[idx[k]]) !== 0) rank++
    key[idx[k]] = rank
  }
  return key
}

function same(a, b) {
  assert.equal(a.length, b.length)
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!(x === y || (x !== x && y !== y))) assert.fail(`row ${i}: ${x} vs ${y}`)
  }
}

let seed = 7
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const pick = (a) => a[Math.floor(rnd() * a.length)]

function mixed(n) {
  const parts = ['a', 'A', 'b', 'z', 'Z', 'é', 'E', 'ß', 'ss', 'st', 'æ', 'ae', 'ø', 'o', 'å', 'ä', 'ö', 'ch', 'c', 'h',
    'i', 'y', 'ı', 'ł', 'l', 'ñ', 'n', ' ', '-', '_', '.', ',', '/', '#', '$', '0', '00', '1', '2', '9', '10', '007',
    '123456789012345678901234567890123456789', '²', '½', '­', '́', 'Ж', 'ж', 'α', '東', '京', '😀', '\t', '']
  return Array.from({ length: n }, () => {
    if (rnd() < 0.05) return null
    let s = ''
    const k = Math.floor(rnd() * 6)
    for (let j = 0; j < k; j++) s += pick(parts)
    return s
  })
}

test('matches a plain collator sort on mixed text, in several locales', () => {
  const data = mixed(4000)
  for (const loc of [undefined, 'en', 'de', 'sv', 'da', 'cs', 'lt', 'tr', 'es', 'hu', 'ja', 'ru']) {
    const collator = new Intl.Collator(loc, { numeric: true, sensitivity: 'base' })
    same(textSortKey(data, collator), naive(data, collator))
  }
})

test('handles numbers, repeats, long shared prefixes and empty input', () => {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const ids = Array.from({ length: 3000 }, (_, i) => 'R' + String(3000 - i).padStart(6, '0'))
  same(textSortKey(ids, collator), naive(ids, collator))
  const files = ['file10', 'file9', 'file09', 'File1', 'file1.5', 'file1.10', 'file', '10', '9', 'x2y10', 'x2y9', 'x10y1']
  const keys = textSortKey(files, collator)
  same(keys, naive(files, collator))
  assert.ok(keys[1] < keys[0]) // file9 before file10
  const repeated = Array.from({ length: 5000 }, () => pick(['follow up', 'no issues', 'needs review']) + ' ' + Math.floor(rnd() * 3000))
  same(textSortKey(repeated, collator), naive(repeated, collator))
  const prefix = Array.from({ length: 2000 }, () => 'the same long opening words then ' + Math.floor(rnd() * 1e6).toString(36))
  same(textSortKey(prefix, collator), naive(prefix, collator))
  same(textSortKey([], collator), new Float64Array(0))
  same(textSortKey([null, null], collator), naive([null, null], collator))
  same(textSortKey(['', null, ''], collator), naive(['', null, ''], collator))
})

test('mostly non-Latin text still sorts correctly', () => {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const cyr = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'
  const data = Array.from({ length: 3000 }, () => {
    let s = ''
    for (let j = 0; j < 1 + Math.floor(rnd() * 6); j++) s += cyr[Math.floor(rnd() * cyr.length)]
    return rnd() < 0.5 ? s.toUpperCase() : s
  })
  same(textSortKey(data, collator), naive(data, collator))
  const cjk = Array.from({ length: 3000 }, () => String.fromCharCode(0x4e00 + Math.floor(rnd() * 400)) + String.fromCharCode(0x4e00 + Math.floor(rnd() * 400)))
  same(textSortKey(cjk, collator), naive(cjk, collator))
})

test('long values that tie on their first chunks, with numbers across chunk edges', () => {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const heads = ['https://example.com/a/', 'https://example.com/a/b', 'HTTPS://EXAMPLE.COM/A/', 'abcdefghijklmn', 'abcdefghijklmno', 'abcdefghijklmnop']
  const data = Array.from({ length: 6000 }, () => {
    let s = pick(heads)
    const k = Math.floor(rnd() * 4)
    for (let j = 0; j < k; j++) s += pick(['0', '00', '7', '12', '0012', '99999', 'x', '-', '/', 'é', '­', 'ß', ' '])
    return rnd() < 0.3 ? s : s + Math.floor(rnd() * 1e7)
  })
  for (const loc of [undefined, 'sv', 'cs']) {
    const c = new Intl.Collator(loc, { numeric: true, sensitivity: 'base' })
    same(textSortKey(data, c), naive(data, c))
  }
  const deduped = Array.from(new Set(data))
  same(textSortKey(deduped, collator), naive(deduped, collator))
})
