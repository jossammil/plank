// Marker columns: columns the reader adds in the browser and fills in, either
// for every filtered row at once or one cell at a time. They use the same
// store shape as a decoded category column, so filters, sorting, the WHERE
// query and CSV export treat them like any other column.

const CACHES = ['_text', '_lower', '_key', '_stats', '_dist', '_bin']

export function makeMarker(name, n) {
  return {
    name, n,
    type: 'category',
    marker: true,
    factor: false,
    label: 'Marker column added in this browser',
    rClass: null,
    digits: 7,
    zone: null,
    integer: false,
    error: null,
    levels: [],
    counts: [],
    codes: new Int32Array(n).fill(-1),
    isNull: new Uint8Array(n).fill(1),
    nullCount: n,
  }
}

/** Forget cached text, sort keys, stats and chart bins after a change. */
export function invalidate(col) {
  for (const k of CACHES) delete col[k]
}

/**
 * Set `value` (or clear it when value is null) on each row index in `rows`.
 * Levels are only ever appended, so existing filter specs stay valid.
 * Returns the number of rows that changed.
 */
export function setMarks(col, rows, value) {
  let code = -1
  if (value !== null) {
    code = col.levels.indexOf(value)
    if (code < 0) {
      code = col.levels.length
      col.levels.push(value)
      col.counts.push(0)
    }
  }
  const { codes, counts, isNull } = col
  let changed = 0
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r]
    const old = codes[i]
    if (old === code) continue
    changed++
    if (old >= 0) counts[old]--
    else {
      isNull[i] = 0
      col.nullCount--
    }
    codes[i] = code
    if (code >= 0) counts[code]++
    else {
      isNull[i] = 1
      col.nullCount++
    }
  }
  if (changed) invalidate(col)
  return changed
}

/** Values in use, most common first. */
export function usedValues(col) {
  const out = []
  col.levels.forEach((level, c) => { if (col.counts[c] > 0) out.push(level) })
  out.sort((a, b) => col.counts[col.levels.indexOf(b)] - col.counts[col.levels.indexOf(a)])
  return out
}

// ---- persistence --------------------------------------------------------

function toBase64(bytes) {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
  return btoa(s)
}

function fromBase64(text) {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/**
 * Compact JSON-able form of the marker columns. Codes are stored one byte
 * per row (two when there are more than 254 values), shifted by one so 0
 * means missing.
 */
export function serializeMarkers(cols) {
  return {
    v: 1,
    cols: cols.map((col) => {
      // Drop values no row uses any more.
      const keep = []
      const remap = new Int32Array(col.levels.length).fill(-1)
      col.levels.forEach((level, c) => {
        if (col.counts[c] > 0) {
          remap[c] = keep.length
          keep.push(level)
        }
      })
      const wide = keep.length > 254
      const arr = wide ? new Uint16Array(col.n) : new Uint8Array(col.n)
      for (let i = 0; i < col.n; i++) {
        const c = col.codes[i]
        arr[i] = c < 0 ? 0 : remap[c] + 1
      }
      return {
        name: col.name,
        levels: keep,
        wide,
        codes: toBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)),
      }
    }),
  }
}

/** Rebuild marker columns; anything that does not fit `n` rows is dropped. */
export function deserializeMarkers(obj, n) {
  const out = []
  if (!obj || obj.v !== 1 || !Array.isArray(obj.cols)) return out
  for (const c of obj.cols) {
    try {
      if (typeof c.name !== 'string' || !Array.isArray(c.levels)) continue
      const bytes = fromBase64(c.codes)
      const arr = c.wide ? new Uint16Array(bytes.buffer, 0, bytes.length >> 1) : bytes
      if (arr.length !== n) continue
      const col = makeMarker(c.name, n)
      col.levels = c.levels.map(String)
      col.counts = new Array(col.levels.length).fill(0)
      let nulls = 0
      for (let i = 0; i < n; i++) {
        const k = arr[i] - 1
        if (k < 0 || k >= col.levels.length) {
          nulls++
          continue
        }
        col.codes[i] = k
        col.isNull[i] = 0
        col.counts[k]++
      }
      col.nullCount = nulls
      out.push(col)
    } catch {
      // skip a damaged entry
    }
  }
  return out
}

/** Short hash that identifies a dataset, used to key saved marks. */
export function fingerprint(n, names, data) {
  const text = `${n}|${names.join('\u0001')}|${data.length}|${data.slice(0, 4096)}|${data.slice(-1024)}`
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
