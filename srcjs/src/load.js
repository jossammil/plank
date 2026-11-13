// Opens the embedded parquet bytes with hyparquet and decodes columns on demand.

import { parquetMetadata, parquetSchema, parquetRead, parquetReadObjects } from 'hyparquet'
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
        const rows = await parquetReadObjects({ file: buffer, metadata, columns: [field.name] })
        values = rows.map((r) => r[field.name])
      } else {
        values = new Array(n)
        await parquetRead({
          file: buffer,
          metadata,
          columns: [field.name],
          parsers,
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

  return {
    n,
    fields,
    column,
    has: (name) => byName.has(name),
    peek: (name) => cache.get(name) || null,
  }
}
