// Opens the embedded parquet bytes with hyparquet and decodes columns on demand.

import { parquetMetadata, parquetSchema, parquetRead, parquetReadObjects } from 'hyparquet'
import { gunzipSync } from 'fflate'
import { decompress as unzstd } from 'fzstd'
import { buildColumn } from './store.js'

export function decodeBase64(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') {
    try {
      return Uint8Array.fromBase64(b64)
    } catch {
      // fall through to atob
    }
  }
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// hyparquet decodes snappy itself; gzip pages go through fflate and zstd
// (the default of polars and recent DuckDB) through fzstd.
const compressors = {
  GZIP: (input, length) => gunzipSync(input, { out: new Uint8Array(length) }),
  ZSTD: (input, length) => unzstd(input, new Uint8Array(length)),
}

// Keep dates and timestamps as epoch milliseconds instead of Date objects.
const parsers = {
  timestampFromMilliseconds: (ms) => Number(ms),
  timestampFromMicroseconds: (us) => Number(us) / 1000,
  timestampFromNanoseconds: (ns) => Number(ns / 1000n) / 1000,
  dateFromDays: (days) => days * 86400000,
}

function temporalKind(el) {
  const lt = el.logical_type && el.logical_type.type
  const ct = el.converted_type
  if (lt === 'DATE' || ct === 'DATE') return 'date'
  if (lt === 'TIMESTAMP' || ct === 'TIMESTAMP_MILLIS' || ct === 'TIMESTAMP_MICROS' || el.type === 'INT96') {
    return 'datetime'
  }
  return null
}

/** Type tag shown before a column has been decoded. */
function guessTag(el, nested, meta) {
  if (meta && meta.levels) return 'fct'
  if (nested) return 'list'
  const kind = temporalKind(el)
  if (kind === 'date') return 'date'
  if (kind === 'datetime') return 'dttm'
  if (el.converted_type === 'DECIMAL' || (el.logical_type && el.logical_type.type === 'DECIMAL')) return 'dbl'
  switch (el.type) {
    case 'BOOLEAN': return 'lgl'
    case 'INT32':
    case 'INT64': return 'int'
    case 'FLOAT':
    case 'DOUBLE': return 'dbl'
    default: return 'chr'
  }
}

/**
 * @param {ArrayBuffer} buffer parquet file bytes
 * @param {object} [meta] per-column hints from R: { name: { class, levels, tz, label } }
 * @param {object} [opts] { digits }
 */
export function openDataset(buffer, meta = {}, opts = {}) {
  const metadata = parquetMetadata(buffer)
  const tree = parquetSchema(metadata)
  const n = Number(metadata.num_rows)

  const fields = tree.children.map((child) => {
    const name = child.element.name
    const m = meta[name] || null
    const nested = child.children.length > 0
    return {
      name,
      element: child.element,
      nested,
      meta: m,
      tag: guessTag(child.element, nested, m),
      label: (m && m.label) || null,
    }
  })
  const byName = new Map(fields.map((f) => [f.name, f]))
  const cache = new Map()

  async function decode(field) {
    const info = {
      kind: field.nested ? null : temporalKind(field.element),
      // Used when a column has no values to look at (no rows, or all missing).
      base: field.tag === 'int' || field.tag === 'dbl' ? 'number' : field.tag === 'lgl' ? 'boolean' : null,
      integer: field.nested ? null : field.tag === 'int',
      levels: field.meta && field.meta.levels ? [].concat(field.meta.levels) : null,
      tz: field.meta && field.meta.tz,
      label: field.label,
      rClass: field.meta && field.meta.class,
      digits: opts.digits,
    }
    try {
      let values
      if (field.nested) {
        const rows = await parquetReadObjects({ file: buffer, metadata, columns: [field.name], compressors })
        values = rows.map((r) => r[field.name])
      } else {
        values = new Array(n)
        await parquetRead({
          file: buffer,
          metadata,
          columns: [field.name],
          parsers,
          compressors,
          onChunk({ columnData, rowStart, rowEnd }) {
            const end = Math.min(rowEnd, n)
            for (let i = rowStart, j = 0; i < end; i++, j++) values[i] = columnData[j]
          },
        })
      }
      return buildColumn(field.name, values, info)
    } catch (err) {
      const message = (err && err.message) || String(err)
      return buildColumn(field.name, new Array(n).fill(null), { label: field.label, error: message })
    }
  }

  /** Decode (once) and return the column store for `name`. */
  async function column(name) {
    let col = cache.get(name)
    if (!col) {
      col = await decode(byName.get(name))
      cache.set(name, col)
    }
    return col
  }

  /**
   * Missing count, min and max for a column from the file's footer, without
   * reading its data. min/max are null when the file does not store them.
   * Returns null when the footer has no statistics for the column.
   */
  function footerStats(name) {
    const field = byName.get(name)
    if (!field || field.nested) return null
    let nulls = 0
    let min = null
    let max = null
    let ranged = true
    for (const rg of metadata.row_groups) {
      const chunk = rg.columns.find((c) => c.meta_data && c.meta_data.path_in_schema.length === 1 &&
        c.meta_data.path_in_schema[0] === name)
      const st = chunk && chunk.meta_data.statistics
      if (!st || st.null_count === undefined) return null
      nulls += Number(st.null_count)
      if (Number(rg.num_rows) === Number(st.null_count)) continue // all missing in this group
      if (st.min_value === undefined || st.max_value === undefined || st.min_value === null) {
        ranged = false
        continue
      }
      const lo = st.min_value instanceof Date ? st.min_value.getTime() : typeof st.min_value === 'bigint' ? Number(st.min_value) : st.min_value
      const hi = st.max_value instanceof Date ? st.max_value.getTime() : typeof st.max_value === 'bigint' ? Number(st.max_value) : st.max_value
      if (min === null || lo < min) min = lo
      if (max === null || hi > max) max = hi
    }
    return { nulls, min: ranged ? min : null, max: ranged ? max : null }
  }

  return {
    n,
    fields,
    column,
    footerStats,
    has: (name) => byName.has(name),
    peek: (name) => cache.get(name) || null,
  }
}

/** The type tag shown for a column built from plain values. */
function tagFor(info) {
  if (info.kind === 'date') return 'date'
  if (info.kind === 'datetime') return 'dttm'
  if (info.base === 'boolean') return 'lgl'
  if (info.base === 'number') return info.integer ? 'int' : 'dbl'
  return 'chr'
}

/**
 * A dataset from columns already in memory (an imported CSV or Excel sheet),
 * with the same interface as openDataset().
 * @param {{name: string, values: any[], info: object}[]} columns
 * @param {object} [opts] { digits }
 */
export function datasetFromColumns(columns, opts = {}) {
  const n = columns.length ? columns[0].values.length : 0
  const fields = columns.map((c) => ({ name: c.name, tag: tagFor(c.info || {}), label: null, nested: false }))
  const byName = new Map(columns.map((c) => [c.name, c]))
  const cache = new Map()
  return {
    n,
    fields,
    async column(name) {
      let col = cache.get(name)
      if (!col) {
        const c = byName.get(name)
        col = buildColumn(name, c.values, { ...c.info, digits: opts.digits })
        cache.set(name, col)
        c.values = null // the column store holds the data from here on
      }
      return col
    },
    footerStats: () => null,
    has: (name) => byName.has(name),
    peek: (name) => cache.get(name) || null,
  }
}
