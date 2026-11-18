// Pure formatting and parsing helpers. Dates and datetimes are epoch milliseconds.

const pad = (n, w = 2) => String(n).padStart(w, '0')

export const DAY_MS = 86400000

export function formatNumber(v, digits = 7) {
  if (v !== v) return 'NaN'
  if (v === Infinity) return 'Inf'
  if (v === -Infinity) return '-Inf'
  if (Number.isInteger(v)) return String(v)
  return String(+v.toPrecision(digits))
}

export function formatDate(ms) {
  const d = new Date(ms)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Format a wall-clock value (wall time stored as if it were UTC). */
function formatWall(ms) {
  const d = new Date(ms)
  let s = `${formatDate(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  const frac = d.getUTCMilliseconds()
  if (frac) s += '.' + pad(frac, 3)
  return s
}

/**
 * Build a time zone helper. `wall(ms)` maps an instant to that zone's wall
 * clock (expressed as UTC ms); `toUtc(wallMs)` is the inverse.
 * Returns null for UTC or an unknown zone, where wall time equals UTC.
 */
export function makeZone(tz) {
  if (!tz || tz === 'UTC' || tz === 'GMT' || tz === 'Etc/UTC') return null
  let fmt
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
  } catch {
    return null
  }
  const wall = (ms) => {
    const whole = Math.floor(ms / 1000) * 1000
    const p = {}
    for (const part of fmt.formatToParts(whole)) p[part.type] = +part.value
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + (ms - whole)
  }
  // The first instant whose wall clock reads wallMs or later. A wall time
  // repeated when clocks go back gives its first occurrence; one skipped when
  // clocks go forward gives the moment of the change. So [toUtc(a),
  // toUtc(b + 1) - 1] covers every instant whose wall time is in [a, b].
  const offset = (ms) => wall(ms) - ms
  const toUtc = (wallMs) => {
    const a = wallMs - offset(wallMs - DAY_MS)
    const b = wallMs - offset(wallMs + DAY_MS)
    const okA = wall(a) === wallMs
    const okB = a === b ? okA : wall(b) === wallMs
    if (okA && okB) return Math.min(a, b)
    if (okA) return a
    if (okB) return b
    // In the gap: find the change between the two candidates.
    let lo = Math.min(a, b)
    let hi = Math.max(a, b)
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (wall(mid) >= wallMs) hi = mid
      else lo = mid
    }
    return hi
  }
  return { tz, wall, toUtc }
}

export function formatDateTime(ms, zone) {
  return formatWall(zone ? zone.wall(ms) : ms)
}

/**
 * Parse a number typed into a range filter. Returns null for blank,
 * NaN for unparseable text.
 */
export function parseNumberInput(text) {
  const t = text.trim().replace(/,/g, '')
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : NaN
}

/**
 * Parse a date typed into a range filter: YYYY, YYYY-MM, YYYY-MM-DD, or
 * YYYY-MM-DD HH:MM[:SS]. An upper bound covers the whole period typed, so
 * "2024-03" as a maximum means through the end of March.
 * Returns wall-clock ms, null for blank, NaN for unparseable text.
 */
export function parseDateInput(text, isMax) {
  const t = text.trim()
  if (!t) return null
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?)?)?$/.exec(t)
  if (!m) return NaN
  const y = +m[1]
  const mo = m[2] ? +m[2] - 1 : 0
  const d = m[3] ? +m[3] : 1
  const hh = m[4] ? +m[4] : 0
  const mi = m[5] ? +m[5] : 0
  const ss = m[6] ? +m[6] : 0
  if (mo > 11 || d > 31 || hh > 23 || mi > 59 || ss > 59) return NaN
  const start = Date.UTC(y, mo, d, hh, mi, ss)
  if (!isMax) return start
  let end
  if (!m[2]) end = Date.UTC(y + 1, 0, 1)
  else if (!m[3]) end = Date.UTC(y, mo + 1, 1)
  else if (!m[4]) end = start + DAY_MS
  else if (!m[6]) end = start + 60000
  else end = start + 1000
  return end - 1
}
