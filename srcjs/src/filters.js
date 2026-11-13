// Filtering, global search and sorting over the columnar store.
// Everything here is pure: columns in, a Uint32Array of row indices out.

import { displayText, lowerText, sortKey } from './store.js'

/**
 * Filter spec for one column:
 *   na:            'any' | 'exclude' | 'only'
 *   min, max:      numbers (or epoch ms) for number/date/datetime, null when unset
 *   contains:      text typed for string columns
 *   mode:          'contains' | 'regex' | 'exact' for string columns
 *   caseSensitive: string matching respects case
 *   codes:         Set of allowed level codes for category columns, null when unset
 *   bool:          true | false | null for boolean columns
 *   invert:        keep everything the value filter does NOT match, missing values included
 * minText/maxText hold what the user typed so inputs can be restored.
 */
export function emptySpec() {
  return {
    na: 'any', min: null, max: null, minText: '', maxText: '',
    contains: '', mode: 'contains', caseSensitive: false,
    codes: null, bool: null, invert: false,
  }
}

const regexCache = new Map()

/**
 * Compile a user regex. Returns { re } or { error } with a readable message.
 * Results are cached, so calling this on every keystroke is cheap.
 */
export function compileRegex(pattern, caseSensitive = false) {
  const key = (caseSensitive ? 'c' : 'i') + pattern
  let out = regexCache.get(key)
  if (!out) {
    try {
      out = { re: new RegExp(pattern, caseSensitive ? 'u' : 'iu') }
    } catch (err) {
      out = { error: String((err && err.message) || err).replace(/^Invalid regular expression: /, '') }
    }
    if (regexCache.size > 200) regexCache.clear()
    regexCache.set(key, out)
  }
  return out
}

/** Error message when a string filter's regex does not compile, else null. */
export function textError(spec) {
  if (spec.mode !== 'regex' || spec.contains === '') return null
  return compileRegex(spec.contains, spec.caseSensitive).error || null
}

export function hasValueFilter(col, spec) {
  switch (col.type) {
    case 'number':
    case 'date':
    case 'datetime':
      return spec.min !== null || spec.max !== null
    case 'boolean':
      return spec.bool !== null
    case 'category':
      return spec.codes !== null
    default:
      return spec.contains !== '' && !textError(spec)
  }
}

export function isActive(col, spec) {
  return spec.na !== 'any' || hasValueFilter(col, spec)
}

/** Any option that differs from the default (used to flag the options button). */
export function hasOptions(spec) {
  return spec.na !== 'any' || spec.invert || spec.mode !== 'contains' || spec.caseSensitive
}

/** Write 1 into `m` where the row matches the value filter. Missing never matches. */
function matchValues(m, col, spec) {
  const n = m.length
  switch (col.type) {
    case 'number':
    case 'date':
    case 'datetime': {
      const num = col.num
      const lo = spec.min === null ? -Infinity : spec.min
      const hi = spec.max === null ? Infinity : spec.max
      for (let i = 0; i < n; i++) {
        const v = num[i]
        m[i] = v >= lo && v <= hi ? 1 : 0
      }
      return
    }
    case 'boolean': {
      const num = col.num
      const want = spec.bool ? 1 : 0
      for (let i = 0; i < n; i++) m[i] = num[i] === want ? 1 : 0
      return
    }
    case 'category': {
      const codes = col.codes
      const ok = new Uint8Array(col.levels.length)
      for (const c of spec.codes) ok[c] = 1
      for (let i = 0; i < n; i++) {
        const c = codes[i]
        m[i] = c >= 0 && ok[c] ? 1 : 0
      }
      return
    }
    default: {
      const cs = spec.caseSensitive
      if (spec.mode === 'regex') {
        const re = compileRegex(spec.contains, cs).re
        const text = displayText(col)
        for (let i = 0; i < n; i++) {
          const s = text[i]
          m[i] = s !== null && re.test(s) ? 1 : 0
        }
        return
      }
      const text = cs ? displayText(col) : lowerText(col)
      const q = cs ? spec.contains : spec.contains.toLowerCase()
      if (spec.mode === 'exact') {
        for (let i = 0; i < n; i++) m[i] = text[i] === q ? 1 : 0
      } else {
        for (let i = 0; i < n; i++) {
          const s = text[i]
          m[i] = s !== null && s.includes(q) ? 1 : 0
        }
      }
    }
  }
}

/** Clear `mask` for rows this column's filter removes. */
function applyFilter(mask, col, spec) {
  const n = mask.length
  if (hasValueFilter(col, spec)) {
    const m = new Uint8Array(n)
    matchValues(m, col, spec)
    // Inverted keeps the true complement: non-matching rows, missing values included.
    const keep = spec.invert ? 0 : 1
    for (let i = 0; i < n; i++) if (m[i] !== keep) mask[i] = 0
  }
  const nul = col.isNull
  if (spec.na === 'exclude') {
    for (let i = 0; i < n; i++) if (nul[i]) mask[i] = 0
  } else if (spec.na === 'only') {
    for (let i = 0; i < n; i++) if (!nul[i]) mask[i] = 0
  }
}

const NUMERIC_TERM = /^[0-9eE+\-.:, nainf]*$/

/** Set hit[i] = 1 where some column matches `term` (plain lowercase text). */
function markTerm(hit, mask, cols, term) {
  const n = mask.length
  for (const col of cols) {
    if (col.type === 'category') {
      const ok = new Uint8Array(col.levels.length)
      let any = false
      for (let l = 0; l < ok.length; l++) {
        if (col.levels[l].toLowerCase().includes(term)) {
          ok[l] = 1
          any = true
        }
      }
      if (!any) continue
      const codes = col.codes
      for (let i = 0; i < n; i++) {
        if (mask[i] && !hit[i] && codes[i] >= 0 && ok[codes[i]]) hit[i] = 1
      }
      continue
    }
    if (col.type === 'boolean') {
      const t = 'true'.includes(term)
      const f = 'false'.includes(term)
      if (!t && !f) continue
      const num = col.num
      for (let i = 0; i < n; i++) {
        if (mask[i] && !hit[i] && (num[i] === 1 ? t : num[i] === 0 ? f : false)) hit[i] = 1
      }
      continue
    }
    // A term with letters cannot match formatted numbers or dates.
    if (col.num && !NUMERIC_TERM.test(term)) continue
    const lower = lowerText(col)
    for (let i = 0; i < n; i++) {
      if (mask[i] && !hit[i]) {
        const s = lower[i]
        if (s !== null && s.includes(term)) hit[i] = 1
      }
    }
  }
}

/** Set hit[i] = 1 where some column's display text matches `re`. */
function markRegex(hit, mask, cols, re) {
  const n = mask.length
  for (const col of cols) {
    if (col.type === 'category') {
      const ok = col.levels.map((l) => re.test(l))
      if (!ok.some(Boolean)) continue
      const codes = col.codes
      for (let i = 0; i < n; i++) {
        if (mask[i] && !hit[i] && codes[i] >= 0 && ok[codes[i]]) hit[i] = 1
      }
      continue
    }
    const text = displayText(col)
    for (let i = 0; i < n; i++) {
      if (mask[i] && !hit[i]) {
        const s = text[i]
        if (s !== null && re.test(s)) hit[i] = 1
      }
    }
  }
}

/**
 * Global search. Plain mode: every whitespace-separated term must appear in
 * at least one column. Regex mode: the whole text is one case-insensitive
 * pattern. Inverted keeps the rows that do not match.
 */
function applySearch(mask, cols, search, regex, invert) {
  const n = mask.length
  let all
  if (regex) {
    const { re } = compileRegex(search.trim(), false)
    if (!re) return
    all = new Uint8Array(n)
    markRegex(all, mask, cols, re)
  } else {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return
    all = Uint8Array.from(mask)
    for (const term of terms) {
      const hit = new Uint8Array(n)
      markTerm(hit, all, cols, term)
      for (let i = 0; i < n; i++) if (all[i] && !hit[i]) all[i] = 0
    }
  }
  const keep = invert ? 0 : 1
  for (let i = 0; i < n; i++) if (mask[i] && all[i] !== keep) mask[i] = 0
}

/** Stable multi-key sort of row indices; missing values always sort last. */
export function sortView(view, sort) {
  if (!sort.length) return view
  const keys = sort.map((s) => sortKey(s.col))
  const dirs = sort.map((s) => (s.dir === 'desc' ? -1 : 1))
  const k = keys.length
  if (k === 1) {
    const key = keys[0]
    const dir = dirs[0]
    return view.sort((a, b) => {
      const x = key[a]
      const y = key[b]
      if (x !== x) return y !== y ? a - b : 1
      if (y !== y) return -1
      if (x < y) return -dir
      if (x > y) return dir
      return a - b
    })
  }
  return view.sort((a, b) => {
    for (let j = 0; j < k; j++) {
      const x = keys[j][a]
      const y = keys[j][b]
      if (x !== x) {
        if (y !== y) continue
        return 1
      }
      if (y !== y) return -1
      if (x < y) return -dirs[j]
      if (x > y) return dirs[j]
    }
    return a - b
  })
}

/**
 * @param {object} q
 * @param {number} q.n total rows
 * @param {{col: object, spec: object}[]} [q.filters]
 * @param {string} [q.search] global search text
 * @param {boolean} [q.searchRegex] treat the search text as a regular expression
 * @param {boolean} [q.searchInvert] keep rows that do not match the search
 * @param {object[]} [q.searchCols] columns the search looks in
 * @param {Uint8Array|null} [q.queryMask] rows kept by the WHERE query (1 = keep)
 * @param {{col: object, dir: 'asc'|'desc'}[]} [q.sort]
 * @returns {Uint32Array} matching row indices in display order
 */
export function computeView({
  n, filters = [], search = '', searchRegex = false, searchInvert = false,
  searchCols = [], queryMask = null, sort = [],
}) {
  const mask = queryMask ? Uint8Array.from(queryMask) : new Uint8Array(n).fill(1)
  for (const { col, spec } of filters) {
    if (isActive(col, spec)) applyFilter(mask, col, spec)
  }
  if (search.trim()) applySearch(mask, searchCols, search, searchRegex, searchInvert)
  let count = 0
  for (let i = 0; i < n; i++) count += mask[i]
  const view = new Uint32Array(count)
  for (let i = 0, j = 0; i < n; i++) if (mask[i]) view[j++] = i
  return sortView(view, sort)
}
