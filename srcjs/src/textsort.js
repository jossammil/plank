// Natural-order ranks for a text column, much faster than sorting with
// Intl.Collator.compare alone.
//
// Sorting a million strings with the collator needs about 20 comparisons per
// string, and each comparison is slow. Instead every string gets a short
// binary key built from a character weight table that is itself taken from
// the collator (so it follows the reader's locale). The keys are
// radix-sorted; strings whose keys tie are compared on the next stretch of
// characters, and the collator then checks each pair of neighbours once.
// When a check finds two neighbours out of order (a rule the table cannot
// see, such as a two-letter contraction in some languages), everything is
// sorted again with the collator, which TimSort does quickly on nearly sorted
// input. The ranks therefore always match a plain collator sort.

const WORDS = 6 // 32-bit words per key chunk
const SKIP = -1 // weight of a character the collator ignores
const FINISHED = -1 // the whole string is in the key
const STOPPED = -2 // the key ends at a character the table cannot place

const isDigit = (c) => c >= 48 && c <= 57

/**
 * Character weights from the collator for the characters in `chars` (a
 * Uint8Array flag per UTF-16 code unit) plus printable ASCII:
 * { weight, second, stop, band, bandStart, bits }. weight[c] is 0 for a
 * character not in the table and SKIP for one the collator ignores;
 * second[c] is the second weight of a character that sorts as two letters
 * (such as "ß", sorted as "ss"). Returns null when the table is too large.
 */
function weightTable(chars, collator) {
  for (let c = 32; c < 127; c++) chars[c] = 1
  const weight = new Int32Array(65536)
  const second = new Int32Array(65536)
  const real = []
  for (let c = 0; c < 65536; c++) {
    if (!chars[c] || isDigit(c) || (c >= 0xd800 && c <= 0xdfff)) continue
    const s = String.fromCharCode(c)
    if (collator.compare(s, '') === 0) weight[c] = SKIP
    else real.push(s)
  }
  real.sort(collator.compare)

  // Equal characters (such as "a", "A" and "á" at base sensitivity) share a
  // group. Numbers are written as whole numbers, in a band of weights placed
  // where the digits sort. Characters that sort among the digits (such as
  // "²") end the key, and so do characters that sort as two letters unless
  // the two letters are found.
  const groups = []
  const before = []
  const odd = []
  const pairs = []
  const last = real.length ? real[real.length - 1] : ''
  let prev = null
  for (const s of real) {
    if (collator.compare(s, '0') >= 0 && collator.compare(s, '9') <= 0) {
      odd.push(s)
      continue
    }
    if (prev !== null && collator.compare(prev, s) === 0) {
      groups[groups.length - 1].push(s)
      continue
    }
    if (prev !== null && collator.compare(s, prev + last) < 0) {
      pairs.push([s, prev])
      continue
    }
    groups.push([s])
    before.push(collator.compare(s, '0') < 0)
    prev = s
  }
  const small = groups.length + 34 <= 254
  const bits = small ? 8 : 16
  const band = small ? 32 : 64
  const stop = small ? 255 : 65535
  if (groups.length + band + 2 > stop) return null
  let w = 1
  let bandStart = 0
  let placed = false
  groups.forEach((g, k) => {
    if (!placed && !before[k]) {
      bandStart = w
      w += band
      placed = true
    }
    for (const s of g) weight[s.charCodeAt(0)] = w
    w++
  })
  if (!placed) bandStart = w
  for (const s of odd) weight[s.charCodeAt(0)] = stop
  for (const [s, x] of pairs) {
    const c = s.charCodeAt(0)
    weight[c] = stop
    for (const g of groups) {
      if (collator.compare(s, x + g[0]) === 0) {
        weight[c] = weight[x.charCodeAt(0)]
        second[c] = weight[g[0].charCodeAt(0)]
        break
      }
    }
  }
  return { weight, second, stop, band, bandStart, bits }
}

/**
 * Returns write(s, from, at): writes one key chunk (WORDS words) for string
 * `s` into keys[at..], starting from `from` (0 for the first chunk). Returns
 * where the next chunk starts (character index times two, plus one when that
 * is inside a number), FINISHED or STOPPED. Characters missing from the
 * table are added to `missing`.
 */
function keyWriter(table, keys, missing) {
  const { weight, second, stop, band, bandStart, bits } = table
  const per = 32 / bits
  const total = WORDS * per
  const buf = new Int32Array(total + 2)

  const pack = (at, p) => {
    for (let w = 0, q = 0; w < WORDS; w++) {
      let word = 0
      for (let k = 0; k < per; k++, q++) word = word * (1 << bits) + (q < p ? buf[q] : 0)
      keys[at + w] = word
    }
  }

  return function write(s, from, at) {
    const n = s.length
    let p = 0
    let i = from >> 1
    if (from & 1) {
      // This chunk starts inside a number: the rest of its digits.
      while (i < n && p < total && isDigit(s.charCodeAt(i))) buf[p++] = s.charCodeAt(i++) - 47
      if (i < n && isDigit(s.charCodeAt(i))) {
        pack(at, p)
        return (i << 1) | 1
      }
    }
    let result = FINISHED
    while (i < n) {
      if (p >= total) {
        result = i << 1
        break
      }
      const c = s.charCodeAt(i)
      if (isDigit(c)) {
        // A whole number: its length (leading zeros dropped), then its digits.
        let j = i
        while (j < n && s.charCodeAt(j) === 48) j++
        let k = j
        while (k < n && isDigit(s.charCodeAt(k))) k++
        const len = k - j
        if (len >= band - 1) {
          buf[p++] = bandStart + band - 1
          result = STOPPED
          break
        }
        buf[p++] = bandStart + len
        i = j
        while (i < k && p < total) buf[p++] = s.charCodeAt(i++) - 47
        if (i < k) {
          result = (i << 1) | 1
          break
        }
        continue
      }
      const x = weight[c]
      if (x === SKIP) {
        i++
        continue
      }
      if (x === 0 || x === stop) {
        if (x === 0) missing.add(c)
        buf[p++] = stop
        result = STOPPED
        break
      }
      const y = second[c]
      if (y) {
        // Both letters of a two-letter character go in the same chunk.
        if (p + 2 > total) {
          result = i << 1
          break
        }
        buf[p++] = x
        buf[p++] = y
      } else buf[p++] = x
      i++
    }
    if (result === (i << 1)) {
      // Ignorable characters at the end need no further chunk.
      let e = i
      while (e < n && weight[s.charCodeAt(e)] === SKIP) e++
      if (e === n) result = FINISHED
    }
    pack(at, p)
    return result
  }
}

/**
 * Sort `items` (item indices, a typed array view) by key word `w`, in place
 * and stably: insertion sort for small groups, else an LSD radix sort that
 * carries each item's word along so memory is read in order.
 */
function sortByWord(items, keys, w) {
  const m = items.length
  if (m <= 48) {
    for (let i = 1; i < m; i++) {
      const x = items[i]
      const kx = keys[x * WORDS + w]
      let j = i - 1
      while (j >= 0 && keys[items[j] * WORDS + w] > kx) {
        items[j + 1] = items[j]
        j--
      }
      items[j + 1] = x
    }
    return
  }
  let word = new Uint32Array(m)
  for (let i = 0; i < m; i++) word[i] = keys[items[i] * WORDS + w]
  const bits = m > 50000 ? 16 : 8
  const size = 1 << bits
  const mask = size - 1
  const count = new Int32Array(size)
  let from = items
  let to = new Int32Array(m)
  let wordTo = new Uint32Array(m)
  for (let shift = 0; shift < 32; shift += bits) {
    count.fill(0)
    for (let i = 0; i < m; i++) count[(word[i] >>> shift) & mask]++
    if (count[(word[0] >>> shift) & mask] === m) continue // all the same
    let sum = 0
    for (let d = 0; d < size; d++) {
      const c = count[d]
      count[d] = sum
      sum += c
    }
    for (let i = 0; i < m; i++) {
      const x = word[i]
      const at = count[(x >>> shift) & mask]++
      to[at] = from[i]
      wordTo[at] = x
    }
    let t = from
    from = to
    to = t
    t = word
    word = wordTo
    wordTo = t
  }
  if (from !== items) items.set(from)
}

/** Item order by key, or null when the collator's characters do not fit a table. */
function keyOrder(vals, collator) {
  const m = vals.length
  // The table comes from the characters of a sample of the values; when a
  // character the sample missed turns up, the table is built again.
  const chars = new Uint8Array(65536)
  const step = Math.max(1, Math.floor(m / 20000))
  for (let v = 0; v < m; v += step) {
    const s = vals[v]
    const len = s.length < 64 ? s.length : 64
    for (let i = 0; i < len; i++) chars[s.charCodeAt(i)] = 1
  }
  const keys = new Uint32Array(m * WORDS)
  const next = new Int32Array(m)
  const order = new Int32Array(m)
  const cmp = (x, y) => (vals[x] === vals[y] ? 0 : collator.compare(vals[x], vals[y]))
  for (let attempt = 0; attempt < 3; attempt++) {
    const table = weightTable(chars, collator)
    if (!table) return null
    const missing = new Set()
    const write = keyWriter(table, keys, missing)
    for (let v = 0; v < m; v++) next[v] = write(vals[v], 0, v * WORDS)
    if (missing.size && attempt < 2) {
      for (const c of missing) chars[c] = 1
      continue
    }
    for (let v = 0; v < m; v++) order[v] = v

    // Sort by the first key word, then each run of equal words by the next
    // word; runs whose whole chunk ties are compared on their next chunk
    // while there is more to compare, and put in order by the collator once
    // there is not.
    const ranges = [0, m, 0]
    while (ranges.length) {
      const w = ranges.pop()
      const end = ranges.pop()
      const start = ranges.pop()
      const items = order.subarray(start, end)
      sortByWord(items, keys, w)
      let a = 0
      for (let k = 1; k <= items.length; k++) {
        if (k < items.length && keys[items[k - 1] * WORDS + w] === keys[items[k] * WORDS + w]) continue
        if (k - a > 1) {
          if (w + 1 < WORDS) ranges.push(start + a, start + k, w + 1)
          else {
            const group = items.subarray(a, k)
            let more = false
            for (let t = 0; t < group.length && !more; t++) more = next[group[t]] >= 0
            if (more) {
              for (let t = 0; t < group.length; t++) {
                const it = group[t]
                const from = next[it]
                if (from >= 0) next[it] = write(vals[it], from, it * WORDS)
                else keys.fill(0, it * WORDS, it * WORDS + WORDS)
              }
              ranges.push(start + a, start + k, 0)
            } else {
              group.set(Array.from(group).sort(cmp))
            }
          }
        }
        a = k
      }
    }
    if (!missing.size || attempt === 2) break
    // Characters found beyond the first chunk: build the table again.
    for (const c of missing) chars[c] = 1
  }
  return order
}

/**
 * Rank per value: equal strings (by the collator) share a rank, and ranks
 * follow the collator's order. Returns a Float64Array.
 */
function rankValues(vals, collator) {
  const m = vals.length
  const rank = new Float64Array(m)
  if (m === 0) return rank
  const cmp = (a, b) => (a === b ? 0 : collator.compare(a, b))
  const assign = (order) => {
    let r = 0
    rank[order[0]] = 0
    for (let k = 1; k < m; k++) {
      const c = cmp(vals[order[k - 1]], vals[order[k]])
      if (c > 0) return false
      if (c < 0) r++
      rank[order[k]] = r
    }
    return true
  }
  const order = keyOrder(vals, collator)
  if (order && assign(order)) return rank
  const all = order ? Array.from(order) : Array.from({ length: m }, (_, i) => i)
  assign(all.sort((x, y) => cmp(vals[x], vals[y])))
  return rank
}

/**
 * Sort key per row for a text column: the rank of its value in the
 * collator's order, NaN where missing.
 * @param {(string|null)[]} str
 * @param {Intl.Collator} collator
 */
export function textSortKey(str, collator) {
  const n = str.length
  const itemOf = new Int32Array(n)
  // Columns with many repeats are ranked once per distinct value; the
  // de-duplication stops early when the values look mostly distinct.
  const index = new Map()
  let vals = []
  let seen = 0
  let dedupe = true
  for (let i = 0; i < n; i++) {
    const s = str[i]
    if (s === null) {
      itemOf[i] = -1
      continue
    }
    if (++seen === 20000 && index.size > 0.8 * seen) {
      dedupe = false
      break
    }
    let u = index.get(s)
    if (u === undefined) {
      u = vals.length
      index.set(s, u)
      vals.push(s)
    }
    itemOf[i] = u
  }
  if (!dedupe) {
    vals = []
    for (let i = 0; i < n; i++) {
      const s = str[i]
      if (s === null) itemOf[i] = -1
      else {
        itemOf[i] = vals.length
        vals.push(s)
      }
    }
  }
  const rank = rankValues(vals, collator)
  const key = new Float64Array(n)
  for (let i = 0; i < n; i++) key[i] = itemOf[i] < 0 ? NaN : rank[itemOf[i]]
  return key
}
