import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatNumber, formatDate, formatDateTime, makeZone, parseNumberInput, parseDateInput,
} from '../src/format.js'

test('formatNumber', () => {
  assert.equal(formatNumber(3), '3')
  assert.equal(formatNumber(0.18364332422208224), '0.1836433')
  assert.equal(formatNumber(1234.5, 3), '1230')
  assert.equal(formatNumber(NaN), 'NaN')
  assert.equal(formatNumber(-Infinity), '-Inf')
})

test('dates format in UTC', () => {
  assert.equal(formatDate(Date.UTC(2024, 0, 5)), '2024-01-05')
  assert.equal(formatDateTime(Date.UTC(2024, 0, 5, 7, 8, 9)), '2024-01-05 07:08:09')
  assert.equal(formatDateTime(Date.UTC(2024, 0, 5, 7, 8, 9, 250)), '2024-01-05 07:08:09.250')
})

test('time zones convert both ways, across daylight saving', () => {
  assert.equal(makeZone('UTC'), null)
  assert.equal(makeZone('Not/AZone'), null)
  const chicago = makeZone('America/Chicago')
  const winter = Date.UTC(2024, 0, 15, 18, 0, 0)
  const summer = Date.UTC(2024, 6, 15, 18, 0, 0)
  assert.equal(formatDateTime(winter, chicago), '2024-01-15 12:00:00')
  assert.equal(formatDateTime(summer, chicago), '2024-07-15 13:00:00')
  assert.equal(chicago.toUtc(chicago.wall(winter)), winter)
  assert.equal(chicago.toUtc(chicago.wall(summer)), summer)
})

test('wall times skipped or repeated by a clock change map to the right instants', () => {
  const chicago = makeZone('America/Chicago')
  const H = 3600000
  // 10 March 2024: 02:00 CST jumps to 03:00 CDT (08:00 UTC).
  assert.equal(chicago.toUtc(Date.UTC(2024, 2, 10, 1, 30)), Date.UTC(2024, 2, 10, 7, 30))
  assert.equal(chicago.toUtc(Date.UTC(2024, 2, 10, 2, 30)), Date.UTC(2024, 2, 10, 8))
  assert.equal(chicago.toUtc(Date.UTC(2024, 2, 10, 3)), Date.UTC(2024, 2, 10, 8))
  // so 01:00-01:59 is a whole hour
  const lo = chicago.toUtc(Date.UTC(2024, 2, 10, 1))
  const hi = chicago.toUtc(Date.UTC(2024, 2, 10, 2)) - 1
  assert.equal(hi - lo + 1, H)
  // 3 November 2024: 01:00-01:59 happens twice (CDT, then CST).
  assert.equal(chicago.toUtc(Date.UTC(2024, 10, 3, 1, 30)), Date.UTC(2024, 10, 3, 6, 30))
  const lo2 = chicago.toUtc(Date.UTC(2024, 10, 3, 1))
  const hi2 = chicago.toUtc(Date.UTC(2024, 10, 3, 2)) - 1
  assert.equal(hi2 - lo2 + 1, 2 * H)
  // Every wall time maps to an instant with that wall time, or the change after it.
  for (let m = 0; m < 48 * 60; m += 7) {
    const w = Date.UTC(2024, 2, 9) + m * 60000
    const t = chicago.toUtc(w)
    assert.ok(chicago.wall(t) >= w && chicago.wall(t - 1) < w, `wall ${new Date(w).toISOString()}`)
  }
})

test('parseNumberInput', () => {
  assert.equal(parseNumberInput('  '), null)
  assert.equal(parseNumberInput('1,234.5'), 1234.5)
  assert.equal(parseNumberInput('-2e3'), -2000)
  assert.ok(Number.isNaN(parseNumberInput('abc')))
})

test('parseDateInput covers the whole period for an upper bound', () => {
  assert.equal(parseDateInput('', false), null)
  assert.ok(Number.isNaN(parseDateInput('yesterday', false)))
  assert.ok(Number.isNaN(parseDateInput('2024-13', false)))
  assert.equal(parseDateInput('2024', false), Date.UTC(2024, 0, 1))
  assert.equal(parseDateInput('2024', true), Date.UTC(2025, 0, 1) - 1)
  assert.equal(parseDateInput('2024-02', true), Date.UTC(2024, 2, 1) - 1)
  assert.equal(parseDateInput('2024-02-10', false), Date.UTC(2024, 1, 10))
  assert.equal(parseDateInput('2024-02-10', true), Date.UTC(2024, 1, 11) - 1)
  assert.equal(parseDateInput('2024-02-10 08:30', true), Date.UTC(2024, 1, 10, 8, 31) - 1)
  assert.equal(parseDateInput('2024-02-10T08:30:15', false), Date.UTC(2024, 1, 10, 8, 30, 15))
})
