// pqview: wires the dataset, picker, grid, query bar and toolbar together.

import { h, debounce, idle } from './dom.js'
import { decodeBase64, openDataset } from './load.js'
import { computeView, emptySpec, isActive, hasOptions, compileRegex } from './filters.js'
import { parseQuery, compileQuery, evaluateQuery, resolveColumn, QueryError } from './query.js'
import { toCSV } from './csv.js'
import { toXLSX, toRDS, toParquet, toTSV, XLSX_MAX_ROWS } from './export.js'
import { Grid } from './grid.js'
import { formatNumber, formatDate, formatDateTime, makeZone } from './format.js'
import { Picker } from './picker.js'
import { chartSVG, overlayCounts, detailHTML } from './spark.js'
import { fullQueryParts, formatFullQuery } from './sql.js'
import {
  makeMarker, setMarks, usedValues, serializeMarkers, deserializeMarkers, fingerprint,
} from './markers.js'
import { CountsPanel } from './counts.js'
import { RowDetail } from './detail.js'
import {
  makeView, normalizeView, viewSignature, parseSaved, serializeSaved, describeView, viewToR, specFromView,
} from './views.js'

const DEFAULT_VISIBLE = 10
const COPY_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/></svg>'

function formatBytes(b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(b < 10485760 ? 2 : 1)} MB`
  return `${(b / 1073741824).toFixed(2)} GB`
}
// Above this many cells, columns are only decoded when selected.
const BACKGROUND_CELLS = 6e6
const THEMES = ['auto', 'light', 'dark']
const THEME_LABEL = { auto: 'Auto (follows system)', light: 'Light', dark: 'Dark' }
const svg = (body) => `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">${body}</svg>`
const THEME_ICON = {
  auto: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" stroke="none"/>'),
  light: svg('<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>'),
  dark: svg('<path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z"/>'),
}
const QUERY_EXAMPLES = [
  ['age > 30 AND region IN (\'West\', \'South\')', 'Compare numbers, match a list'],
  ['comment LIKE \'%review%\'', 'Text pattern: % any text, _ one character (ignores case)'],
  ['comment REGEXP \'^(called|left)\'', 'Regular expression (case-sensitive; IREGEXP ignores case)'],
  ['income IS NULL OR income < 20000', 'Missing values'],
  ['visit_date BETWEEN \'2023-01\' AND \'2023-06\'', 'Dates: YYYY, YYYY-MM or YYYY-MM-DD cover the whole period'],
  ['YEAR(visit_date) = 2024 AND NOT enrolled', 'Functions and logical columns'],
  ['income / 1000 >= 50', 'Arithmetic: + - * /'],
  ['"column with spaces" = \'x\'', 'Quote unusual column names with " or `'],
]

// Viewer preferences are remembered per browser. Storage can be unavailable
// (private windows, blocked site data), so every access is guarded.
function loadPref(key) {
  try {
    return window.localStorage.getItem('pqview.' + key)
  } catch {
    return null
  }
}
function savePref(key, value) {
  try {
    window.localStorage.setItem('pqview.' + key, value)
  } catch {
    // ignore
  }
}

/**
 * @param {HTMLElement} el container element
 * @param {object} x payload from R: { data, meta, columns, digits, title, theme, font, where, top_offset }
 */
export function mount(el, x) {
  const t0 = performance.now()
  if (el.pqview && el.pqview.destroy) el.pqview.destroy()
  el.textContent = ''
  el.classList.add('pqv')

  const prefs = {
    theme: THEMES.includes(loadPref('theme')) ? loadPref('theme') : (THEMES.includes(x.theme) ? x.theme : 'auto'),
    mono: loadPref('mono') === null ? x.font !== 'sans' : loadPref('mono') === '1',
    query: loadPref('query') !== '0',
    full: loadPref('fullQuery') === '1',
    pickerWidth: +loadPref('pickerWidth') || 0,
  }
  el.dataset.theme = prefs.theme
  el.classList.toggle('pqv-mono', prefs.mono)

  // A widget that fills a page of its own gets breathing room at the top, so
  // browser chrome (for example Safari in full screen) does not cover the toolbar.
  const standalone = !!el.parentElement && el.parentElement.id === 'htmlwidget_container' &&
    !/[?&]viewer_pane=1/.test(window.location.search)
  const topOffset = Math.max(0, Number(x.top_offset) || 0)
  if (standalone) {
    el.classList.add('pqv-standalone')
    // The band above the toolbar holds the title, notes and data sizes.
    el.style.setProperty('--pqv-top', topOffset + 'px')
  }

  const state = {
    selected: [], cols: [], specs: new Map(), sort: [], pinned: [], formats: new Map(), view: new Uint32Array(0),
    search: '', searchRegex: loadPref('searchRegex') === '1', searchInvert: false,
    queryMask: null, queryInvert: false, queryError: null, queryCols: [], queryText: '', computed: false,
  }
  const timings = {}
  const api = { state, timings, ready: null, destroy() {} }
  el.pqview = api

  const loading = h('div', { class: 'pqv-loading', text: 'Loading data' })
  el.append(loading)

  api.ready = init().catch((err) => {
    el.textContent = ''
    el.append(h('div', { class: 'pqv-error', role: 'alert' },
      h('strong', { text: 'pqview could not read the data. ' }),
      String((err && err.message) || err)))
    throw err
  })
  api.ready.catch(() => {})
  return api

  async function init() {
    const bytes = decodeBase64(x.data)
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const ds = openDataset(buffer, x.meta || {}, { digits: x.digits })
    api.ds = ds
    timings.opened = performance.now() - t0

    // ---- toolbar --------------------------------------------------------
    const toggle = (text, title, pressed) => h('button', {
      class: 'pqv-toggle', type: 'button', text, title, 'aria-pressed': String(!!pressed),
    })
    const setPressed = (btn, on) => btn.setAttribute('aria-pressed', String(!!on))

    const pickerBtn = h('button', { class: 'pqv-btn', type: 'button', 'aria-expanded': 'true' })
    const searchInput = h('input', {
      class: 'pqv-input pqv-search', type: 'search', placeholder: 'Search visible columns',
      'aria-label': 'Search visible columns', spellcheck: 'false', autocomplete: 'off',
    })
    const searchRegexBtn = toggle('.*', 'Search with a regular expression', state.searchRegex)
    const searchNotBtn = toggle('NOT', 'Show rows that do NOT match the search', false)
    const status = h('div', { class: 'pqv-status', role: 'status' })
    const clearBtn = h('button', { class: 'pqv-btn pqv-clear', type: 'button', text: 'Clear filters', hidden: true })
    const undoBtn = h('button', { class: 'pqv-btn pqv-icon', type: 'button', disabled: true })
    undoBtn.innerHTML = svg('<path d="M6 3 2.5 6.5 6 10"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/>')
    const redoBtn = h('button', { class: 'pqv-btn pqv-icon', type: 'button', disabled: true })
    redoBtn.innerHTML = svg('<path d="M10 3l3.5 3.5L10 10"/><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9"/>')
    const markBtn = h('button', {
      class: 'pqv-btn', type: 'button', text: 'Mark', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      title: 'Add a marker column and mark the filtered rows',
    })
    const countsBtn = h('button', {
      class: 'pqv-btn', type: 'button', text: 'Counts', 'aria-pressed': 'false',
      title: 'Show or hide the Counts panel: filtered rows per value of one or two columns',
    })
    const viewsBtn = h('button', {
      class: 'pqv-btn pqv-viewsbtn', type: 'button', text: 'Views', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      title: 'Save the columns, filters and sort as a named view, or switch to a saved one',
    })
    const exportBtn = h('button', {
      class: 'pqv-btn', type: 'button', text: 'Export', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      title: 'Save or copy the filtered rows and visible columns: CSV, Excel, R (.rds), parquet or clipboard',
    })
    const queryBtn = toggle('WHERE', 'Show or hide the WHERE query bar', prefs.query)
    const fullBtn = toggle('See Query', 'Show every filter, search and WHERE condition combined as one query', prefs.full)
    // Display preferences sit quietly in the title band, apart from the
    // controls that change the data shown.
    const monoBtn = h('button', {
      class: 'pqv-pref pqv-pref-mono', type: 'button', text: 'Mono', title: 'Monospace font in the table',
      'aria-pressed': String(!!prefs.mono),
    })
    const themeBtn = h('button', { class: 'pqv-pref pqv-pref-icon', type: 'button' })

    // ---- title band: title, notes and data sizes -------------------------
    const dataBytes = bytes.byteLength
    const sizeData = h('div', { class: 'pqv-size' })
    const sizeExport = h('div', { class: 'pqv-size' })
    const pageBytes = Math.round((String(x.data || '').length + 150000) / 1024) * 1024
    sizeData.append(h('span', { class: 'pqv-size-k', text: 'Data' }), h('span', { class: 'pqv-size-v', text: formatBytes(dataBytes) }))
    sizeData.title = `Embedded parquet data: ${dataBytes.toLocaleString()} bytes ` +
      `(${ds.n.toLocaleString()} rows × ${ds.fields.length} columns). This page is about ${formatBytes(pageBytes)}.`
    const notes = x.notes == null ? '' : [].concat(x.notes).join('\n')
    const header = h('div', { class: 'pqv-header' },
      h('div', { class: 'pqv-heading' },
        x.title ? h('div', { class: 'pqv-title', text: x.title, title: x.title }) : null,
        notes ? h('div', { class: 'pqv-notes', text: notes }) : null),
      h('div', { class: 'pqv-headright' },
        h('div', { class: 'pqv-sizes' }, sizeData, sizeExport),
        h('div', { class: 'pqv-prefs' }, monoBtn, themeBtn)))
    header.classList.toggle('pqv-header-empty', !x.title && !notes)

    const toolbar = h('div', { class: 'pqv-toolbar' },
      pickerBtn, viewsBtn,
      h('div', { class: 'pqv-searchgroup' }, searchInput, searchRegexBtn, searchNotBtn),
      status, h('div', { class: 'pqv-undo' }, undoBtn, redoBtn), clearBtn, countsBtn, markBtn, exportBtn,
      h('div', { class: 'pqv-switches' }, queryBtn, fullBtn))

    // ---- query bar ------------------------------------------------------
    const queryInput = h('input', {
      class: 'pqv-input pqv-query-input', type: 'text', value: x.where || '',
      placeholder: "age > 30 AND region IN ('West', 'South')",
      'aria-label': 'WHERE condition', spellcheck: 'false', autocomplete: 'off',
    })
    const queryNotBtn = toggle('NOT', 'Show rows where the condition is NOT true (missing values included)', false)
    const queryHelpBtn = h('button', {
      class: 'pqv-btn pqv-icon', type: 'button', text: '?', 'aria-haspopup': 'dialog',
      'aria-expanded': 'false', title: 'Query syntax and examples',
    })
    const queryMsg = h('div', { class: 'pqv-query-msg', 'aria-live': 'polite' })
    const fullText = h('pre', { class: 'pqv-full-text' })
    const fullCopy = h('button', { class: 'pqv-btn pqv-btn-sm', type: 'button', title: 'Copy the full query' })
    fullCopy.innerHTML = COPY_ICON + '<span>Copy</span>'
    const fullUse = h('button', {
      class: 'pqv-btn pqv-btn-sm', type: 'button', text: 'Edit as WHERE',
      title: 'Put the full query in the WHERE box and clear the column filters and search, so you can edit it',
    })
    const fullBox = h('div', { class: 'pqv-full', hidden: !prefs.full },
      h('div', { class: 'pqv-full-head' },
        h('span', { class: 'pqv-full-label', text: 'Query' }),
        h('span', { class: 'pqv-full-note', text: 'column filters, search and WHERE combined' }),
        fullCopy, fullUse),
      fullText)
    const queryBar = h('div', { class: 'pqv-querybar', hidden: !prefs.query },
      h('div', { class: 'pqv-query-row' },
        h('label', { class: 'pqv-query-label', text: 'WHERE' }),
        queryInput, queryNotBtn, queryHelpBtn),
      queryMsg)
    queryBar.querySelector('label').addEventListener('click', () => queryInput.focus())

    const countsBox = h('div', { class: 'pqv-counts', hidden: true, role: 'region', 'aria-label': 'Counts' })
    const pickerHost = h('div', { class: 'pqv-picker' })
    const gridHost = h('div', { class: 'pqv-gridwrap' })
    const detailHost = h('div', { class: 'pqv-detail', hidden: true, role: 'complementary', 'aria-label': 'Row details' })
    const body = h('div', { class: 'pqv-body' }, pickerHost, gridHost, detailHost)

    // Marker columns live alongside the decoded parquet columns.
    const markers = new Map()
    const fieldNames = () => ds.fields.map((f) => f.name).concat(Array.from(markers.keys()))
    const fieldList = () => ds.fields.map((f) => ({ name: f.name, tag: f.tag }))
      .concat(Array.from(markers.keys(), (name) => ({ name, tag: 'mark' })))
    const hasCol = (name) => ds.has(name) || markers.has(name)
    const peekCol = (name) => markers.get(name) || ds.peek(name)

    const getSpec = (name) => {
      let spec = state.specs.get(name)
      if (!spec) {
        spec = emptySpec()
        state.specs.set(name, spec)
      }
      return spec
    }

    const recompute = (resetScroll = true) => {
      const t = performance.now()
      const byName = new Map(state.cols.map((c) => [c.name, c]))
      state.view = computeView({
        n: ds.n,
        filters: state.cols.map((col) => ({ col, spec: getSpec(col.name) })),
        search: state.search,
        searchRegex: state.searchRegex,
        searchInvert: state.searchInvert,
        searchCols: state.cols,
        queryMask: state.queryMask,
        sort: state.sort.map((s) => ({ col: byName.get(s.name), dir: s.dir })),
      })
      timings.lastCompute = performance.now() - t
      state.computed = true
      grid.setView(state.view, resetScroll)
      updateStatus()
      refreshChartsSoon()
      updateFullQuery()
      updateExportSize()
      countsSoon()
      detailSoon()
      viewLabelSoon()
      shinySoon()
      recordSoon()
    }
    const recomputeSoon = debounce(recompute, 90)
    let counts = null
    const countsSoon = debounce(() => counts && counts.update(), 120)
    let detail = null
    const detailSoon = debounce(() => detail && detail.refresh(), 120)
    // In Shiny, the reader's rows and settings are sent back as inputs:
    // <id>_rows (row numbers, in display order), <id>_state and <id>_row.
    const shiny = () => (el.id && window.Shiny && typeof window.Shiny.setInputValue === 'function' ? window.Shiny : null)
    let shinyRows = null
    const sendShiny = () => {
      const S = shiny()
      if (!S) return
      if (shinyRows !== state.view) {
        shinyRows = state.view
        const rows = new Array(state.view.length)
        for (let k = 0; k < rows.length; k++) rows[k] = state.view[k] + 1
        S.setInputValue(el.id + '_rows', rows)
      }
      S.setInputValue(el.id + '_state', {
        columns: state.cols.map((c) => c.name),
        sort: state.sort.map((s) => (s.dir === 'desc' ? '-' : '') + s.name),
        pinned: state.pinned.slice(),
        where: currentParts().join(' AND '),
        rows_shown: state.view.length,
        rows_total: ds.n,
      })
    }
    const shinySoon = debounce(sendShiny, 250)
    const sendShinyRow = (i) => {
      const S = shiny()
      if (S) S.setInputValue(el.id + '_row', i < 0 ? null : i + 1)
    }
    let updateViewLabel = () => {}
    const viewLabelSoon = debounce(() => updateViewLabel(), 300)

    // ---- full query -------------------------------------------------------
    const currentParts = () => fullQueryParts({
      filters: state.cols.map((col) => ({ col, spec: getSpec(col.name) })),
      searchCols: state.cols,
      search: state.search,
      searchRegex: state.searchRegex,
      searchInvert: state.searchInvert,
      query: state.queryMask !== null ? state.queryText : '',
      queryInvert: state.queryInvert,
    })
    const updateFullQuery = () => {
      if (fullBox.hidden) return
      const text = formatFullQuery(currentParts())
      fullText.textContent = text || 'No filters: every row is shown.'
      fullText.classList.toggle('pqv-full-empty', !text)
      fullCopy.disabled = !text
      fullUse.disabled = !text
    }
    api.fullQuery = () => formatFullQuery(currentParts())

    // ---- estimated export size ---------------------------------------------
    // Measured on a sample of the shown rows, so it stays instant.
    const encoder = new TextEncoder()
    const updateExportSize = () => {
      const view = state.view
      const cols = state.cols
      sizeExport.textContent = ''
      if (!cols.length) {
        sizeExport.append(h('span', { class: 'pqv-size-k', text: 'Export' }), h('span', { class: 'pqv-size-v', text: '—' }))
        sizeExport.title = 'Select columns to export'
        return
      }
      const rowNumbers = cols.some((c) => c.marker)
      const k = Math.min(view.length, 1500)
      const step = view.length / Math.max(1, k)
      const sample = new Uint32Array(k)
      for (let j = 0; j < k; j++) sample[j] = view[Math.floor(j * step)]
      const parts = toCSV(cols, sample, { rowNumbers })
      const headBytes = encoder.encode(parts[0]).length
      let body = 0
      for (let j = 1; j < parts.length; j++) body += encoder.encode(parts[j]).length
      const est = headBytes + (k ? (body / k) * view.length : 0)
      const exact = k === view.length
      sizeExport.append(
        h('span', { class: 'pqv-size-k', text: 'Export' }),
        h('span', { class: 'pqv-size-v', text: (exact ? '' : '≈ ') + formatBytes(Math.round(est)) }))
      sizeExport.title = `${exact ? '' : 'Estimated '}size of a CSV export: ${view.length.toLocaleString()} rows × ` +
        `${cols.length + (rowNumbers ? 1 : 0)} columns${exact ? '' : ', measured on a sample of ' + k.toLocaleString() + ' rows'}.`
    }

    const searchError = () => (state.searchRegex && state.search.trim()
      ? compileRegex(state.search.trim(), false).error || null : null)

    const updateStatus = () => {
      const shown = state.view.length
      status.textContent = shown === ds.n
        ? `${ds.n.toLocaleString()} rows`
        : `${shown.toLocaleString()} of ${ds.n.toLocaleString()} rows`
      const filtered = !!state.search.trim() || state.searchInvert || state.queryMask !== null ||
        !!queryInput.value.trim() || state.queryInvert ||
        state.cols.some((c) => {
          const spec = getSpec(c.name)
          return isActive(c, spec) || hasOptions(spec) || spec.contains !== '' || spec.minText !== '' || spec.maxText !== ''
        })
      clearBtn.hidden = !filtered
      let orActive = 0
      for (const c of state.cols) {
        const spec = getSpec(c.name)
        if (spec.join === 'or' && isActive(c, spec)) orActive++
      }
      status.title = orActive > 1
        ? `${orActive} OR filters: a row needs to match at least one of them, plus every AND filter`
        : orActive === 1 ? 'One OR filter works like AND until another column also uses OR' : ''
      status.classList.toggle('pqv-status-or', orActive > 1)
      pickerBtn.textContent = `Columns ${state.cols.length}/${ds.fields.length}`
      exportBtn.disabled = !state.cols.length
      const err = searchError()
      searchInput.classList.toggle('pqv-bad', !!err)
      searchInput.title = err ? `Invalid regular expression: ${err}` : ''
    }

    const grid = new Grid(gridHost, {
      root: el,
      n: ds.n,
      getSpec,
      onFilter: (_name, debounced) => (debounced ? recomputeSoon() : (recomputeSoon.cancel(), recompute())),
      onSort: (name, additive) => {
        const k = state.sort.findIndex((s) => s.name === name)
        const cur = k < 0 ? null : state.sort[k].dir
        const next = cur === null ? 'asc' : cur === 'asc' ? 'desc' : null
        if (additive) {
          if (k < 0) state.sort.push({ name, dir: next })
          else if (next) state.sort[k].dir = next
          else state.sort.splice(k, 1)
        } else {
          state.sort = next ? [{ name, dir: next }] : []
        }
        grid.setSort(state.sort)
        recompute()
      },
      onMarkCell: (col, row, cell) => openCellMarker(col, row, cell),
      onRowClick: (i, onNumber) => {
        if (onNumber && detail.isOpen && detail.row === i) closeDetail()
        else if (onNumber || detail.isOpen) openDetail(i)
      },
      onPin: (name) => togglePin(name),
      getFormat: (name) => state.formats.get(name) || null,
      onFormat: (name, fmt) => {
        if (fmt) state.formats.set(name, fmt)
        else state.formats.delete(name)
        countsSoon()
        viewLabelSoon()
        recordSoon()
      },
    })
    api.grid = grid

    // ---- theme ----------------------------------------------------------
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
    const paintPage = () => {
      // In a page of its own, match the page background to the widget so
      // overscroll and the top band use the same colour.
      if (standalone) {
        const bg = getComputedStyle(el).backgroundColor
        document.documentElement.style.background = bg
        document.body.style.background = bg
      }
    }
    const applyTheme = () => {
      el.dataset.theme = prefs.theme
      const nextTheme = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length]
      themeBtn.innerHTML = THEME_ICON[prefs.theme]
      themeBtn.title = `Theme: ${THEME_LABEL[prefs.theme]}. Click for ${THEME_LABEL[nextTheme]}.`
      themeBtn.setAttribute('aria-label', themeBtn.title)
      paintPage()
    }
    themeBtn.addEventListener('click', () => {
      prefs.theme = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length]
      savePref('theme', prefs.theme)
      applyTheme()
    })
    const onScheme = () => paintPage()
    if (media && media.addEventListener) media.addEventListener('change', onScheme)
    applyTheme()

    monoBtn.addEventListener('click', () => {
      prefs.mono = !prefs.mono
      savePref('mono', prefs.mono ? '1' : '0')
      setPressed(monoBtn, prefs.mono)
      el.classList.toggle('pqv-mono', prefs.mono)
      grid.remeasure()
    })

    api.destroy = () => {
      grid.destroy()
      document.removeEventListener('keydown', onUndoKey)
      if (media && media.removeEventListener) media.removeEventListener('change', onScheme)
    }

    // ---- stats fill in during idle time ---------------------------------
    const statsQueue = []
    let draining = false
    const drainStats = () => {
      const col = statsQueue.shift()
      if (!col) {
        draining = false
        return
      }
      picker.updateStats(col)
      if (!col.error) picker.setChart(col.name, chartFor(col))
      idle(drainStats)
    }
    const queueStats = (col) => {
      statsQueue.push(col)
      if (!draining) {
        draining = true
        idle(drainStats)
      }
    }
    // ---- distribution charts in the column list ------------------------
    const filteredView = () => (state.computed && state.view.length !== ds.n ? state.view : null)
    const chartFor = (col) => {
      const view = filteredView()
      return chartSVG(col, view ? overlayCounts(col, view) : null, ds.n)
    }
    let chartToken = 0
    let chartsDirty = false
    const refreshCharts = () => {
      const token = ++chartToken
      if (pickerHost.hidden) {
        chartsDirty = true
        return
      }
      chartsDirty = false
      for (const name of picker.openDetails()) fillDetail(name)
      const names = picker.listedNames().filter((name) => picker.hasChart(name) && peekCol(name))
      let k = 0
      const step = () => {
        if (token !== chartToken) return
        const t = performance.now()
        while (k < names.length && performance.now() - t < 8) {
          const col = peekCol(names[k])
          if (col) picker.setChart(col.name, chartFor(col))
          k++
        }
        // Continue soon rather than at idle time, so charts never lag far behind.
        if (k < names.length) setTimeout(step, 0)
        else timings.lastCharts = performance.now()
      }
      step()
    }
    const refreshChartsSoon = debounce(refreshCharts, 120)
    // The detail panel of a column in the list: decode it first if needed.
    const fillDetail = async (name, box) => {
      const target = box || picker.items.get(name)?.detail
      if (!target) return
      if (!peekCol(name)) {
        target.textContent = 'Reading column…'
        await decode(name)
      }
      const col = peekCol(name)
      if (!col || col.error) {
        target.textContent = col ? `Could not decode this column: ${col.error}` : ''
        return
      }
      const view = filteredView()
      target.innerHTML = detailHTML(col, view ? overlayCounts(col, view) : null, ds.n)
    }
    api.refreshCharts = refreshCharts

    const decode = async (name) => {
      if (markers.has(name)) return markers.get(name)
      const fresh = !ds.peek(name)
      const col = await ds.column(name)
      if (fresh) queueStats(col)
      return col
    }

    let selectToken = 0
    const setSelected = async (names) => {
      const token = ++selectToken
      let wanted = names.filter(hasCol)
      // Pinned columns come first, in the order they were given.
      const pins = new Set(state.pinned)
      const pinned = wanted.filter((name) => pins.has(name))
      const ordered = pinned.concat(wanted.filter((name) => !pins.has(name)))
      if (ordered.some((name, k) => name !== wanted[k])) picker.setSelected(ordered)
      wanted = ordered
      state.pinned = pinned
      const cols = []
      for (const name of wanted) cols.push(await decode(name))
      if (token !== selectToken) return
      const keep = new Set(wanted)
      state.selected = wanted
      state.cols = cols
      // Filters and sort keys belong to visible columns only.
      for (const name of Array.from(state.specs.keys())) if (!keep.has(name)) state.specs.delete(name)
      state.sort = state.sort.filter((s) => keep.has(s.name))
      state.pinned = state.pinned.filter((name) => keep.has(name))
      grid.setColumns(cols, state.pinned.length)
      grid.setSort(state.sort)
      recompute(false)
    }

    const picker = new Picker(pickerHost, {
      fields: ds.fields,
      n: ds.n,
      root: el,
      width: prefs.pickerWidth,
      onWidth: (w) => {
        savePref('pickerWidth', String(w))
        grid.schedule()
      },
      onChange: (names) => setSelected(names),
      onDetail: (name, box) => fillDetail(name, box),
    })
    api.picker = picker
    // Missing share and range from the file's footer, shown before a column is read.
    const previewText = (field) => {
      const st = ds.footerStats(field.name)
      if (!st) return ''
      const parts = []
      if (st.nulls && ds.n) {
        const pct = (st.nulls / ds.n) * 100
        parts.push(`${pct < 0.1 ? '<0.1' : pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% NA`)
      }
      if (st.min !== null && st.max !== null && typeof st.min === 'number' && !(field.meta && field.meta.levels)) {
        const fmt = field.tag === 'date' ? formatDate
          : field.tag === 'dttm' ? ((zone) => (v) => formatDateTime(v, zone))(makeZone(field.meta && field.meta.tz))
            : field.tag === 'int' || field.tag === 'dbl' ? (v) => formatNumber(v, x.digits || 7) : null
        if (fmt) parts.push(st.min === st.max ? fmt(st.min) : `${fmt(st.min)} to ${fmt(st.max)}`)
      }
      return parts.join(' · ')
    }
    for (const f of ds.fields) if (!ds.peek(f.name)) picker.setPreview(f.name, previewText(f))
    picker.search.addEventListener('input', () => refreshChartsSoon())

    // ---- WHERE query ----------------------------------------------------
    let queryToken = 0
    const showQueryState = () => {
      const err = state.queryError
      queryInput.classList.toggle('pqv-bad', !!err)
      queryBar.classList.toggle('pqv-query-on', state.queryMask !== null && !err)
      if (err) {
        queryMsg.textContent = err.message + (state.queryMask ? ' — still showing the last valid query.' : '')
        queryMsg.className = 'pqv-query-msg pqv-bad-text'
      } else {
        queryMsg.textContent = ''
        queryMsg.className = 'pqv-query-msg'
      }
    }
    const runQuery = async () => {
      const token = ++queryToken
      const text = queryInput.value
      try {
        const { ast, columns } = parseQuery(text)
        if (!ast) {
          state.queryMask = null
          state.queryError = null
          state.queryCols = []
          showQueryState()
          recompute()
          return
        }
        const resolved = new Map()
        const allNames = fieldNames()
        for (const c of columns) {
          const name = resolveColumn(c.name, allNames)
          if (!name) throw new QueryError(`Unknown column '${c.name}'`, c.pos)
          resolved.set(c.name, name)
        }
        const decoded = new Map()
        for (const name of new Set(resolved.values())) decoded.set(name, await decode(name))
        if (token !== queryToken) return
        const test = compileQuery(ast, (name) => decoded.get(resolved.get(name)))
        const t = performance.now()
        state.queryMask = evaluateQuery(test, ds.n, state.queryInvert)
        state.queryText = text.trim()
        state.queryCols = Array.from(decoded.keys())
        timings.lastQuery = performance.now() - t
        state.queryError = null
        showQueryState()
        recompute()
      } catch (err) {
        if (token !== queryToken) return
        state.queryError = err instanceof QueryError ? err : new QueryError(String((err && err.message) || err))
        showQueryState()
        updateStatus()
      }
    }
    api.runQuery = runQuery
    const runQuerySoon = debounce(runQuery, 300)
    queryInput.addEventListener('input', runQuerySoon)
    queryInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        runQuerySoon.cancel()
        runQuery()
      } else if (e.key === 'Escape' && queryInput.value) {
        queryInput.value = ''
        runQuerySoon.cancel()
        runQuery()
      }
    })
    queryNotBtn.addEventListener('click', () => {
      state.queryInvert = !state.queryInvert
      setPressed(queryNotBtn, state.queryInvert)
      runQuerySoon.cancel()
      runQuery()
    })
    queryHelpBtn.addEventListener('click', () => {
      if (grid.pop && grid.pop.anchor === queryHelpBtn) {
        grid.closePop()
        return
      }
      const list = h('div', { class: 'pqv-help-list' })
      for (const [code, note] of QUERY_EXAMPLES) {
        list.append(h('button', {
          class: 'pqv-help-item', type: 'button', title: 'Use this example',
          onclick: () => {
            queryInput.value = code
            grid.closePop()
            queryInput.focus()
            runQuery()
          },
        }, h('code', { text: code }), h('span', { text: note })))
      }
      const pop = h('div', { class: 'pqv-pop pqv-help', role: 'dialog', 'aria-label': 'Query syntax' },
        h('div', { class: 'pqv-pop-title', text: 'WHERE query syntax' }),
        h('p', {
          class: 'pqv-help-text',
          text: 'Conditions: = != < <= > >=, IN (...), BETWEEN ... AND ..., LIKE, REGEXP, IS [NOT] NULL, ' +
            'combined with AND, OR, NOT and parentheses. Functions: LOWER, UPPER, LENGTH, ABS, YEAR, MONTH, DAY. ' +
            'Text goes in single quotes. The query can use any column, shown or not, and applies on top of the column filters.',
        }),
        list)
      grid.openPop(queryHelpBtn, pop)
    })
    fullBtn.addEventListener('click', () => {
      prefs.full = fullBox.hidden
      fullBox.hidden = !prefs.full
      setPressed(fullBtn, prefs.full)
      savePref('fullQuery', prefs.full ? '1' : '0')
      updateFullQuery()
      grid.schedule()
    })
    // Copying must happen while the browser is still handling the click:
    // Safari (Mac and iPhone) refuses it after any pause. So copyText does
    // its work synchronously when called from a click handler, first with
    // the classic select-and-copy (allowed in every browser during a click,
    // and on file:// pages), then with the Clipboard API.
    const execCopy = (text) => {
      const active = document.activeElement
      const area = h('textarea', { class: 'pqv-offscreen', readonly: '', 'aria-hidden': 'true' })
      area.value = text
      area.style.fontSize = '12pt' // stops iOS zooming in on focus
      el.append(area)
      let ok = false
      try {
        area.select()
        area.setSelectionRange(0, text.length)
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      area.remove()
      if (active && active !== document.body && active.focus) active.focus({ preventScroll: true })
      return ok
    }
    const copyText = (text) => {
      if (execCopy(text)) return Promise.resolve(true)
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true, () => false)
      }
      return Promise.resolve(false)
    }
    fullCopy.addEventListener('click', async () => {
      const ok = await copyText(api.fullQuery())
      const label = fullCopy.querySelector('span')
      label.textContent = ok ? 'Copied' : 'Select and copy'
      if (!ok) {
        const range = document.createRange()
        range.selectNodeContents(fullText)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
      setTimeout(() => { label.textContent = 'Copy' }, 1500)
    })
    fullUse.addEventListener('click', () => {
      const parts = currentParts()
      if (!parts.length) return
      state.specs.clear()
      state.search = ''
      searchInput.value = ''
      state.searchInvert = false
      setPressed(searchNotBtn, false)
      state.queryInvert = false
      setPressed(queryNotBtn, false)
      queryInput.value = parts.join(' AND ')
      grid.setColumns(state.cols, state.pinned.length)
      runQuerySoon.cancel()
      runQuery()
      queryInput.focus()
    })
    queryBtn.addEventListener('click', () => {
      prefs.query = queryBar.hidden
      queryBar.hidden = !prefs.query
      savePref('query', prefs.query ? '1' : '0')
      setPressed(queryBtn, prefs.query)
      grid.schedule()
      if (prefs.query) queryInput.focus()
    })

    const showQueryBar = () => {
      if (!queryBar.hidden) return
      prefs.query = true
      queryBar.hidden = false
      savePref('query', '1')
      setPressed(queryBtn, true)
      grid.schedule()
    }
    // Adds a condition to the WHERE query, keeping the rows it already selects.
    const addWhere = (cond) => {
      const base = state.queryMask !== null ? state.queryText : ''
      let text = cond
      if (base) {
        const b = state.queryInvert ? `(${base}) IS NOT TRUE` : /\bOR\b/i.test(base) ? `(${base})` : base
        text = `${b} AND ${cond}`
      }
      state.queryInvert = false
      setPressed(queryNotBtn, false)
      queryInput.value = text
      showQueryBar()
      runQuerySoon.cancel()
      return runQuery()
    }
    api.addWhere = addWhere

    // ---- counts panel ---------------------------------------------------
    counts = new CountsPanel(countsBox, {
      fields: fieldList,
      getCol: (name) => decode(name),
      getView: () => state.view,
      defaultBy: () => {
        const c = state.cols.find((c) => c.type === 'category' && !c.marker) ||
          state.cols.find((c) => c.type === 'boolean') || state.cols[0]
        return c ? c.name : (ds.fields[0] ? ds.fields[0].name : null)
      },
      onDrill: (cond) => addWhere(cond),
      copyText: (text) => copyText(text),
      download: (blob) => download(blob, 'csv', fileBase + '_counts'),
      getFormat: (name) => state.formats.get(name) || null,
      onClose: () => setCountsOpen(false),
      onChange: () => viewLabelSoon(),
      height: +loadPref('countsHeight') || 0,
      onHeight: (px) => {
        savePref('countsHeight', String(px))
        grid.schedule()
      },
    })
    api.counts = counts
    const setCountsOpen = (on) => {
      counts.show(on)
      setPressed(countsBtn, on)
      grid.schedule()
    }
    countsBtn.addEventListener('click', () => setCountsOpen(!counts.open))

    // ---- row details ------------------------------------------------------
    detail = new RowDetail(detailHost, {
      fields: fieldList,
      tableNames: () => state.cols.map((c) => c.name),
      peekCol,
      getCol: (name) => decode(name),
      getView: () => state.view,
      onRow: (i, pos, reveal) => {
        grid.setCurrent(i)
        sendShinyRow(i)
        if (reveal && pos >= 0) grid.scrollToRow(pos)
      },
      onClose: () => closeDetail(),
      copyText: (text) => copyText(text),
      width: +loadPref('detailWidth') || 0,
      onWidth: (px) => {
        savePref('detailWidth', String(px))
        grid.schedule()
      },
    })
    api.detail = detail
    const openDetail = (i) => {
      // On a narrow widget the panel covers the table instead of squeezing it.
      detailHost.classList.toggle('pqv-detail-over', el.clientWidth < 760)
      detail.show(i, true)
      grid.schedule()
    }
    const closeDetail = () => {
      const wasFocused = detailHost.contains(document.activeElement)
      detail.close()
      grid.setCurrent(-1)
      sendShinyRow(-1)
      grid.schedule()
      if (wasFocused) grid.scroller.focus({ preventScroll: true })
    }
    api.openDetail = openDetail
    api.closeDetail = closeDetail

    // ---- pinned columns ---------------------------------------------------
    // Pinned columns sit first in the table and stay at the left edge.
    const togglePin = (name) => {
      const order = picker.selected().filter((n) => n !== name)
      const pinned = state.pinned.filter((n) => n !== name)
      if (pinned.length === state.pinned.length) pinned.push(name)
      order.splice(pinned.length - (pinned.includes(name) ? 1 : 0), 0, name)
      state.pinned = pinned
      picker.setSelected(order)
      return setSelected(order)
    }
    api.togglePin = togglePin

    // ---- marker columns -------------------------------------------------
    const dataPrint = fingerprint(ds.n, ds.fields.map((f) => f.name), String(x.data || ''))
    const marksKey = 'pqview.marks.' + dataPrint
    const marksStore = { error: null }
    const saveMarks = () => {
      try {
        if (!markers.size) window.localStorage.removeItem(marksKey)
        else window.localStorage.setItem(marksKey, JSON.stringify(serializeMarkers(Array.from(markers.values()))))
        marksStore.error = null
      } catch (err) {
        marksStore.error = 'Marks could not be saved in this browser (storage is full or blocked). Export the data to keep them.'
      }
    }
    const saveMarksSoon = debounce(saveMarks, 400)
    api.saveMarks = () => {
      saveMarksSoon.cancel()
      saveMarks()
    }
    api.markers = markers
    const markerField = (col) => ({ name: col.name, tag: 'mark', label: col.label })
    const restoreMarks = () => {
      let saved = null
      try {
        const text = window.localStorage.getItem(marksKey)
        saved = text ? JSON.parse(text) : null
      } catch {
        saved = null
      }
      const cols = deserializeMarkers(saved, ds.n).filter((col) => !ds.has(col.name))
      for (const col of cols) {
        markers.set(col.name, col)
        picker.addField(markerField(col), false)
        picker.updateStats(col, true)
      }
      return cols
    }

    const nameProblem = (name, except = null) => {
      if (!name) return 'Enter a column name.'
      if (name !== except && fieldNames().includes(name)) return `There is already a column called '${name}'.`
      return null
    }
    const uniqueName = (base) => {
      const names = new Set(fieldNames())
      if (!names.has(base)) return base
      let k = 2
      while (names.has(`${base}_${k}`)) k++
      return `${base}_${k}`
    }
    let marksVer = 0
    const createMarker = async (name) => {
      marksVer++
      const col = makeMarker(name, ds.n)
      markers.set(name, col)
      picker.addField(markerField(col))
      picker.updateStats(col, true)
      picker.setChart(col.name, chartFor(col))
      counts.refreshFields()
      await setSelected(picker.selected())
      saveMarksSoon()
      return col
    }
    // After marks change: repaint the header, stats, chart and rows, and
    // re-run a WHERE query that uses the marker.
    const afterMarks = async (col) => {
      marksVer++
      picker.updateStats(col, true)
      grid.refreshColumn(col.name)
      saveMarksSoon()
      if (state.queryCols.includes(col.name) && queryInput.value.trim()) await runQuery()
      else recompute(false)
      picker.setChart(col.name, chartFor(col))
    }
    const reselect = async () => {
      await setSelected(picker.selected())
      if (state.queryCols.some((name) => !hasCol(name)) && queryInput.value.trim()) await runQuery()
    }
    const renameMarker = async (from, to) => {
      marksVer++
      const col = markers.get(from)
      markers.delete(from)
      col.name = to
      markers.set(to, col)
      const spec = state.specs.get(from)
      if (spec) {
        state.specs.delete(from)
        state.specs.set(to, spec)
      }
      for (const s of state.sort) if (s.name === from) s.name = to
      picker.renameField(from, to)
      counts.renameField(from, to)
      grid.widths.delete(from)
      await setSelected(picker.selected())
      saveMarksSoon()
    }
    const deleteMarker = async (name) => {
      marksVer++
      markers.delete(name)
      state.specs.delete(name)
      picker.removeField(name)
      counts.refreshFields()
      await reselect()
      saveMarksSoon()
    }

    let lastMarker = null
    let lastValue = '1'
    const openMarkPanel = (message = '') => {
      const names = Array.from(markers.keys())
      const n = state.view.length
      const select = h('select', { class: 'pqv-input', 'aria-label': 'Marker column' },
        names.map((name) => h('option', { value: name, text: name })),
        h('option', { value: '', text: 'New marker column…' }))
      select.value = lastMarker && markers.has(lastMarker) ? lastMarker : (names[0] || '')
      const newName = h('input', {
        class: 'pqv-input', type: 'text', value: uniqueName('mark'), 'aria-label': 'New column name',
        spellcheck: 'false', autocomplete: 'off',
      })
      const listId = 'pqv-marks-' + Math.random().toString(36).slice(2, 8)
      const datalist = h('datalist', { id: listId })
      const value = h('input', {
        class: 'pqv-input', type: 'text', value: lastValue, list: listId, 'aria-label': 'Value to mark',
        spellcheck: 'false', autocomplete: 'off',
      })
      const msg = h('div', { class: 'pqv-mark-msg', 'aria-live': 'polite', text: message || marksStore.error || '' })
      const fail = (text) => {
        msg.textContent = text
        msg.classList.add('pqv-bad-text')
      }
      const target = async () => {
        if (select.value) return markers.get(select.value)
        const name = newName.value.trim()
        const problem = nameProblem(name)
        if (problem) {
          fail(problem)
          newName.focus()
          return null
        }
        return createMarker(name)
      }
      const markRows = async (clear) => {
        const v = value.value.trim()
        if (!clear && !v) {
          fail('Enter a value to mark with.')
          value.focus()
          return
        }
        const col = await target()
        if (!col) return
        lastMarker = col.name
        if (!clear) lastValue = v
        const rows = state.view
        const changed = setMarks(col, rows, clear ? null : v)
        await afterMarks(col)
        const verb = clear ? `Cleared '${col.name}' on` : `Marked '${col.name}' = '${v}' on`
        openMarkPanel(`${verb} ${rows.length.toLocaleString()} rows (${changed.toLocaleString()} changed).`)
      }
      const markRowsBtn = h('button', {
        class: 'pqv-btn pqv-primary', type: 'button', text: `Mark ${n.toLocaleString()} filtered rows`,
        onclick: () => markRows(false),
      })
      const clearRowsBtn = h('button', {
        class: 'pqv-btn', type: 'button', text: `Clear marks on ${n.toLocaleString()} filtered rows`,
        onclick: () => markRows(true),
      })
      markRowsBtn.disabled = !n
      value.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          markRows(false)
        }
      })

      const renameInput = h('input', {
        class: 'pqv-input', type: 'text', 'aria-label': 'Rename marker column', spellcheck: 'false', autocomplete: 'off',
      })
      const renameBtn = h('button', {
        class: 'pqv-btn', type: 'button', text: 'Rename',
        onclick: async () => {
          const from = select.value
          const to = renameInput.value.trim()
          if (!from || to === from) return
          const problem = nameProblem(to, from)
          if (problem) return fail(problem)
          await renameMarker(from, to)
          lastMarker = to
          openMarkPanel(`Renamed '${from}' to '${to}'.`)
        },
      })
      const confirmBox = h('span', { class: 'pqv-mark-confirm', hidden: true })
      const deleteBtn = h('button', {
        class: 'pqv-link pqv-danger', type: 'button', text: 'Delete column',
        onclick: () => {
          deleteBtn.hidden = true
          confirmBox.hidden = false
          confirmBox.textContent = ''
          confirmBox.append(
            h('span', { text: `Delete '${select.value}' and its marks? ` }),
            h('button', {
              class: 'pqv-link pqv-danger', type: 'button', text: 'Delete',
              onclick: async () => {
                const name = select.value
                await deleteMarker(name)
                openMarkPanel(`Deleted '${name}'.`)
              },
            }),
            h('button', {
              class: 'pqv-link', type: 'button', text: 'Keep',
              onclick: () => {
                confirmBox.hidden = true
                deleteBtn.hidden = false
              },
            }))
        },
      })
      const newRow = h('label', { class: 'pqv-mark-row' }, h('span', { text: 'Name' }), newName)
      const manage = h('div', { class: 'pqv-mark-manage' },
        h('div', { class: 'pqv-mark-row' }, renameInput, renameBtn),
        h('div', { class: 'pqv-mark-row' }, deleteBtn, confirmBox))
      const sync = () => {
        const col = select.value ? markers.get(select.value) : null
        newRow.hidden = !!col
        manage.hidden = !col
        clearRowsBtn.hidden = !col
        renameInput.value = col ? col.name : ''
        confirmBox.hidden = true
        deleteBtn.hidden = false
        datalist.textContent = ''
        if (col) for (const v of usedValues(col)) datalist.append(h('option', { value: v }))
      }
      select.addEventListener('change', () => {
        msg.textContent = ''
        msg.classList.remove('pqv-bad-text')
        sync()
      })
      sync()

      const pop = h('div', { class: 'pqv-pop pqv-markpanel', role: 'dialog', 'aria-label': 'Marker columns' },
        h('div', { class: 'pqv-pop-title', text: 'Marker columns' }),
        h('div', { class: 'pqv-mark-body' },
          h('label', { class: 'pqv-mark-row' }, h('span', { text: 'Column' }), select),
          newRow,
          h('label', { class: 'pqv-mark-row' }, h('span', { text: 'Value' }), value, datalist),
          h('div', { class: 'pqv-mark-actions' }, markRowsBtn, clearRowsBtn),
          msg,
          manage),
        h('p', {
          class: 'pqv-opt-note',
          text: 'Marking replaces any value already on those rows. Click a cell in a marker column to set one row. ' +
            'Marks are saved in this browser; Export includes them.',
        }))
      grid.openPop(markBtn, pop, value)
      if (marksStore.error && !message) msg.classList.add('pqv-bad-text')
    }
    api.openMarkPanel = openMarkPanel
    markBtn.addEventListener('click', () => {
      if (grid.pop && grid.pop.anchor === markBtn) grid.closePop()
      else openMarkPanel()
    })

    const openCellMarker = (col, row, cell) => {
      const current = col.isNull[row] ? null : col.levels[col.codes[row]]
      const apply = async (v) => {
        grid.closePop()
        setMarks(col, [row], v)
        if (v !== null) lastValue = v
        lastMarker = col.name
        await afterMarks(col)
      }
      const choices = h('div', { class: 'pqv-cellmark-values' })
      const values = usedValues(col)
      if (!values.includes(lastValue)) values.push(lastValue)
      for (const v of values.slice(0, 12)) {
        choices.append(h('button', {
          class: v === current ? 'pqv-chip pqv-on' : 'pqv-chip', type: 'button', text: v,
          onclick: () => apply(v),
        }))
      }
      const input = h('input', {
        class: 'pqv-input', type: 'text', placeholder: 'New value', 'aria-label': 'New value',
        spellcheck: 'false', autocomplete: 'off',
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault()
          apply(input.value.trim())
        }
      })
      const pop = h('div', { class: 'pqv-pop pqv-cellmark', role: 'dialog', 'aria-label': `${col.name}, row ${row + 1}` },
        h('div', { class: 'pqv-pop-title', text: `${col.name} · row ${(row + 1).toLocaleString()}` }),
        choices,
        input,
        h('div', { class: 'pqv-pop-foot' },
          h('button', { class: 'pqv-link', type: 'button', text: 'Clear', disabled: current === null, onclick: () => apply(null) })))
      grid.openPop(cell, pop, input, true)
    }

    // ---- search, clear, export ------------------------------------------
    pickerBtn.addEventListener('click', () => {
      const open = pickerHost.hidden
      pickerHost.hidden = !open
      pickerBtn.setAttribute('aria-expanded', String(open))
      if (open && chartsDirty) refreshCharts()
    })
    searchInput.addEventListener('input', () => {
      state.search = searchInput.value
      recomputeSoon()
    })
    searchRegexBtn.addEventListener('click', () => {
      state.searchRegex = !state.searchRegex
      savePref('searchRegex', state.searchRegex ? '1' : '0')
      setPressed(searchRegexBtn, state.searchRegex)
      searchInput.placeholder = state.searchRegex ? 'Regex across visible columns' : 'Search visible columns'
      recompute()
    })
    searchNotBtn.addEventListener('click', () => {
      state.searchInvert = !state.searchInvert
      setPressed(searchNotBtn, state.searchInvert)
      recompute()
    })
    if (state.searchRegex) searchInput.placeholder = 'Regex across visible columns'
    clearBtn.addEventListener('click', () => {
      state.specs.clear()
      state.search = ''
      searchInput.value = ''
      state.searchInvert = false
      setPressed(searchNotBtn, false)
      queryInput.value = ''
      state.queryInvert = false
      setPressed(queryNotBtn, false)
      state.queryMask = null
      state.queryError = null
      state.queryCols = []
      queryToken++
      showQueryState()
      grid.setColumns(state.cols, state.pinned.length)
      recompute()
    })
    // ---- export ---------------------------------------------------------
    const fileBase = String(x.title || 'data').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'data'
    const download = (blob, ext, base = fileBase) => {
      const url = URL.createObjectURL(blob)
      const a = h('a', { href: url, download: `${base}.${ext}` })
      el.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30000)
    }
    const EXPORTS = [
      { key: 'csv', label: 'CSV', ext: 'csv', note: 'Text, opens anywhere' },
      { key: 'xlsx', label: 'Excel', ext: 'xlsx', note: 'Workbook with typed dates and numbers' },
      { key: 'rds', label: 'R data', ext: 'rds', note: 'readRDS(): factors, dates and time zones kept' },
      { key: 'parquet', label: 'Parquet', ext: 'parquet', note: 'Compact, typed; R, Python, DuckDB' },
      { key: 'clip', label: 'Copy to clipboard', ext: '', note: 'Tab-separated, pastes into a spreadsheet' },
    ]
    const runExport = async (key) => {
      const cols = state.cols
      const view = state.view
      const opts = { rowNumbers: cols.some((c) => c.marker), title: x.title }
      switch (key) {
        case 'csv':
          download(new Blob(toCSV(cols, view, opts), { type: 'text/csv;charset=utf-8' }), 'csv')
          return 'Downloaded CSV.'
        case 'xlsx':
          if (view.length > XLSX_MAX_ROWS) throw new Error(`Excel holds at most ${XLSX_MAX_ROWS.toLocaleString()} rows; filter first or use another format.`)
          download(await toXLSX(cols, view, opts), 'xlsx')
          return 'Downloaded Excel workbook.'
        case 'rds':
          download(await toRDS(cols, view, opts), 'rds')
          return 'Downloaded .rds file.'
        case 'parquet':
          download(toParquet(cols, view, opts), 'parquet')
          return 'Downloaded parquet file.'
        default: {
          const ok = await copyText(toTSV(cols, view, opts))
          if (!ok) throw new Error('The browser did not allow copying; try another format.')
          return `Copied ${view.length.toLocaleString()} rows to the clipboard.`
        }
      }
    }
    api.runExport = runExport
    exportBtn.addEventListener('click', () => {
      if (grid.pop && grid.pop.anchor === exportBtn) {
        grid.closePop()
        return
      }
      if (!state.cols.length) return
      const rows = state.view.length
      const ncol = state.cols.length + (state.cols.some((c) => c.marker) ? 1 : 0)
      const msg = h('div', { class: 'pqv-export-msg', 'aria-live': 'polite' })
      const list = h('div', { class: 'pqv-export-list', role: 'menu' })
      for (const f of EXPORTS) {
        const item = h('button', { class: 'pqv-export-item', type: 'button', role: 'menuitem' },
          h('span', { class: 'pqv-export-label', text: f.label }),
          f.ext ? h('span', { class: 'pqv-export-ext', text: '.' + f.ext }) : null,
          h('span', { class: 'pqv-export-note', text: f.note }))
        item.dataset.format = f.key
        if (f.key === 'xlsx' && rows > XLSX_MAX_ROWS) item.disabled = true
        item.addEventListener('click', async () => {
          for (const b of list.querySelectorAll('button')) b.disabled = true
          msg.className = 'pqv-export-msg'
          msg.textContent = 'Preparing…'
          const t = performance.now()
          // Downloads pause briefly so "Preparing…" can paint first. Copying
          // starts at once: Safari only allows it inside the click itself.
          const task = f.key === 'clip'
            ? runExport(f.key)
            : new Promise((resolve) => setTimeout(resolve, 20)).then(() => runExport(f.key))
          try {
            msg.textContent = await task
            timings.lastExport = performance.now() - t
          } catch (err) {
            msg.className = 'pqv-export-msg pqv-bad-text'
            msg.textContent = String((err && err.message) || err)
          }
          for (const b of list.querySelectorAll('button')) b.disabled = b.dataset.format === 'xlsx' && rows > XLSX_MAX_ROWS
        })
        list.append(item)
      }
      const pop = h('div', { class: 'pqv-pop pqv-exportmenu', role: 'dialog', 'aria-label': 'Export' },
        h('div', { class: 'pqv-pop-title', text: `Export ${rows.toLocaleString()} rows × ${ncol} columns` }),
        list,
        msg)
      grid.openPop(exportBtn, pop, list.querySelector('button'))
    })

    loading.remove()
    el.append(header, toolbar, queryBar, fullBox, countsBox, body)
    // On a narrow container the table matters more than the column list.
    if (el.clientWidth && el.clientWidth < 640) {
      pickerHost.hidden = true
      pickerBtn.setAttribute('aria-expanded', 'false')
    }
    timings.columnsListed = performance.now() - t0

    // ---- undo / redo ------------------------------------------------------
    // Each step is a snapshot of what decides the table: the columns and
    // their order, every filter, the search, the WHERE query, the sort and
    // the marker columns. A burst of typing counts as one step.
    const HISTORY_MAX = 100
    const history = { past: [], current: null, future: [], busy: false }
    let marksSnap = null
    const snapshotMarks = () => {
      if (!marksSnap || marksSnap.ver !== marksVer) {
        marksSnap = {
          ver: marksVer,
          cols: Array.from(markers.values(), (c) => ({ name: c.name, levels: c.levels.slice(), codes: c.codes.slice() })),
        }
      }
      return marksSnap
    }
    const takeSnapshot = () => {
      const order = picker.selected()
      const specs = []
      for (const name of order) {
        const sp = state.specs.get(name)
        if (sp) specs.push([name, { ...sp, codes: sp.codes ? new Set(sp.codes) : null }])
      }
      const snap = {
        order, specs,
        search: state.search, searchRegex: state.searchRegex, searchInvert: state.searchInvert,
        query: queryInput.value, queryInvert: state.queryInvert,
        sort: state.sort.map((x) => ({ ...x })),
        pinned: state.pinned.slice(),
        formats: Array.from(state.formats, ([n, f]) => [n, { ...f }]),
        marks: snapshotMarks(),
      }
      snap.sig = JSON.stringify([
        order, specs.map(([n, sp]) => [n, { ...sp, codes: sp.codes ? Array.from(sp.codes).sort((a, b) => a - b) : null }]),
        snap.search, snap.searchRegex, snap.searchInvert, snap.query, snap.queryInvert, snap.sort, snap.pinned, snap.formats, snap.marks.ver,
      ])
      return snap
    }
    const paintHistory = () => {
      undoBtn.disabled = !history.past.length
      redoBtn.disabled = !history.future.length
      const key = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+'
      undoBtn.title = `Undo the last change to columns, filters, search, query, sort or marks (${key}Z)`
      redoBtn.title = `Redo (${key}Shift+Z)`
      undoBtn.setAttribute('aria-label', 'Undo')
      redoBtn.setAttribute('aria-label', 'Redo')
    }
    const record = () => {
      if (history.busy || !history.current) return
      const snap = takeSnapshot()
      if (snap.sig === history.current.sig) return
      history.past.push(history.current)
      if (history.past.length > HISTORY_MAX) history.past.shift()
      history.current = snap
      history.future = []
      paintHistory()
    }
    const recordSoon = debounce(record, 400)
    const restoreSnapshot = async (snap) => {
      history.busy = true
      try {
        grid.closePop()
        if (snap.marks.ver !== marksVer) {
          const keep = new Set(snap.marks.cols.map((c) => c.name))
          for (const name of Array.from(markers.keys())) {
            if (!keep.has(name)) {
              markers.delete(name)
              picker.removeField(name)
            }
          }
          for (const m of snap.marks.cols) {
            const col = makeMarker(m.name, ds.n)
            col.levels = m.levels.slice()
            col.counts = new Array(col.levels.length).fill(0)
            col.codes = m.codes.slice()
            let nulls = 0
            for (let i = 0; i < ds.n; i++) {
              const c = col.codes[i]
              if (c < 0) nulls++
              else {
                col.isNull[i] = 0
                col.counts[c]++
              }
            }
            col.nullCount = nulls
            markers.set(m.name, col)
            picker.addField(markerField(col), false)
            picker.updateStats(col, true)
          }
          marksVer = snap.marks.ver
          marksSnap = snap.marks
          counts.refreshFields()
          saveMarksSoon()
        }
        await applyTableState({
          ...snap,
          specs: new Map(snap.specs.map(([n, sp]) => [n, { ...sp, codes: sp.codes ? new Set(sp.codes) : null }])),
        })
        for (const col of markers.values()) picker.setChart(col.name, chartFor(col))
      } finally {
        recordSoon.cancel()
        history.busy = false
      }
    }
    // Puts the table in a given state: columns in order, filters, search,
    // WHERE query and sort.
    async function applyTableState(t) {
      state.specs = t.specs
      state.sort = t.sort.map((x) => ({ ...x }))
      state.pinned = (t.pinned || []).slice()
      if (t.formats) state.formats = new Map(t.formats.map(([n, f]) => [n, { ...f }]))
      state.search = t.search
      searchInput.value = t.search
      state.searchRegex = t.searchRegex
      setPressed(searchRegexBtn, t.searchRegex)
      searchInput.placeholder = t.searchRegex ? 'Regex across visible columns' : 'Search visible columns'
      state.searchInvert = t.searchInvert
      setPressed(searchNotBtn, t.searchInvert)
      queryInput.value = t.query
      state.queryInvert = t.queryInvert
      setPressed(queryNotBtn, t.queryInvert)
      const order = t.order.filter(hasCol)
      picker.setSelected(order)
      await setSelected(order)
      runQuerySoon.cancel()
      await runQuery()
    }
    const stepHistory = async (back) => {
      if (history.busy) return
      recordSoon.cancel()
      record()
      const from = back ? history.past : history.future
      const to = back ? history.future : history.past
      if (!from.length) return
      to.push(history.current)
      history.current = from.pop()
      paintHistory()
      await restoreSnapshot(history.current)
    }
    api.undo = () => stepHistory(true)
    api.redo = () => stepHistory(false)
    undoBtn.addEventListener('click', api.undo)
    redoBtn.addEventListener('click', api.redo)
    const onUndoKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      // Text boxes keep the browser's own undo for typing.
      const t = e.target
      // Act on keys pressed inside the viewer, or anywhere when it fills the page.
      if (!(el.contains(t) || (standalone && (t === document.body || t === document.documentElement)))) return
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && t.type !== 'checkbox') return
      e.preventDefault()
      stepHistory(!(k === 'y' || e.shiftKey))
    }
    document.addEventListener('keydown', onUndoKey)
    paintHistory()

    // ---- saved views ------------------------------------------------------
    // A view is a named state of the table. Views from R (pqview(views = ...))
    // come with the file; views saved here stay in this browser.
    const defaultColumns = (x.columns == null
      ? ds.fields.slice(0, DEFAULT_VISIBLE).map((f) => f.name)
      : [].concat(x.columns)).filter(hasCol)
    const resolveView = (v) => {
      const shown = (v.columns || defaultColumns).filter(hasCol)
      // Pinned columns lead the table, as the table will show them.
      const pins = new Set(v.pinned)
      const pinned = shown.filter((c) => pins.has(c))
      const columns = pinned.concat(shown.filter((c) => !pins.has(c)))
      return {
        ...v,
        columns,
        pinned,
        filters: v.filters.filter(([name]) => columns.includes(name)),
        sort: v.sort.filter((s) => columns.includes(s.name)),
        // Views without formats (from R, or saved before formats existed)
        // use the formats the viewer started with.
        formats: (v.formats || startFormats).filter(([name]) => columns.includes(name))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      }
    }
    const startFormats = Object.entries(x.formats || {})
      .filter(([name, f]) => f && hasCol(name))
      .map(([name, f]) => [name, { decimals: f.decimals == null ? null : +f.decimals, big: !!f.big_mark }])
    const authorViews = []
    for (const raw of [].concat(x.views || [])) {
      const v = normalizeView(raw)
      if (v && !authorViews.some((a) => a.name === v.name)) authorViews.push(resolveView(v))
    }
    const viewsKey = 'pqview.views.' + dataPrint
    const viewStore = { error: null }
    let savedViews = []
    try {
      savedViews = parseSaved(window.localStorage.getItem(viewsKey) || '[]')
    } catch {
      savedViews = []
    }
    const saveViews = () => {
      try {
        if (savedViews.length) window.localStorage.setItem(viewsKey, serializeSaved(savedViews))
        else window.localStorage.removeItem(viewsKey)
        viewStore.error = null
        return true
      } catch {
        viewStore.error = 'Views could not be saved in this browser (storage is full or blocked).'
        return false
      }
    }
    const currentView = (name = '') => makeView(name, {
      columns: picker.selected(),
      specs: Array.from(state.specs),
      colOf: peekCol,
      search: state.search,
      searchRegex: state.searchRegex,
      searchInvert: state.searchInvert,
      where: queryInput.value,
      whereInvert: state.queryInvert,
      sort: state.sort,
      pinned: state.pinned,
      formats: Array.from(state.formats),
      counts: counts.config(),
    })
    let activeView = null
    // A view that sets the Counts panel matches only when the panel counts by
    // the same columns.
    const countsKey = (c) => (c ? c.by.join('\u0000') : null)
    updateViewLabel = () => {
      const cur = currentView()
      const sig = viewSignature(cur)
      const match = authorViews.concat(savedViews).find((v) => viewSignature(resolveView(v)) === sig &&
        (!v.counts || countsKey(v.counts) === countsKey(cur.counts)))
      activeView = match ? match.name : null
      viewsBtn.textContent = match ? `View: ${match.name}` : 'Views'
      viewsBtn.classList.toggle('pqv-on', !!match)
    }
    const applyView = async (view) => {
      if (history.busy) return
      const v = resolveView(view)
      recordSoon.cancel()
      record()
      history.busy = true
      try {
        grid.closePop()
        // Columns are read first so filters can find their values.
        for (const name of v.columns) await decode(name)
        const specs = new Map()
        for (const [name, stored] of v.filters) specs.set(name, specFromView(stored, peekCol(name), emptySpec))
        await applyTableState({
          order: v.columns,
          specs,
          sort: v.sort,
          pinned: v.pinned,
          formats: v.formats,
          search: v.search,
          searchRegex: v.searchRegex,
          searchInvert: v.searchInvert,
          query: v.where,
          queryInvert: v.whereInvert,
        })
        if (v.where) showQueryBar()
        if (v.counts) {
          counts.setConfig(v.counts)
          setCountsOpen(true)
        }
      } finally {
        recordSoon.cancel()
        history.busy = false
      }
      record()
      updateViewLabel()
    }
    const saveView = (name) => {
      const v = currentView(name)
      const k = savedViews.findIndex((s) => s.name === name)
      if (k >= 0) savedViews[k] = v
      else savedViews.push(v)
      const ok = saveViews()
      updateViewLabel()
      return { replaced: k >= 0, ok }
    }
    const viewNamed = (name) => authorViews.concat(savedViews).find((v) => v.name === name)
    api.views = {
      list: () => authorViews.concat(savedViews).map((v) => v.name),
      saved: () => savedViews.slice(),
      current: () => currentView(),
      active: () => activeView,
      apply: (name) => (viewNamed(name) ? applyView(viewNamed(name)) : Promise.reject(new Error(`No view called '${name}'`))),
      save: (name) => saveView(name),
      rCode: () => viewToR(currentView(), currentParts().join(' AND '), activeView || ''),
    }

    const openViewsPanel = (message = '', bad = false) => {
      const msg = h('div', { class: 'pqv-mark-msg', 'aria-live': 'polite', text: message || viewStore.error || '' })
      if (bad || (!message && viewStore.error)) msg.classList.add('pqv-bad-text')
      const fail = (text) => {
        msg.textContent = text
        msg.classList.add('pqv-bad-text')
      }
      const nameInput = h('input', {
        class: 'pqv-input', type: 'text', placeholder: 'Name for the current view', 'aria-label': 'View name',
        spellcheck: 'false', autocomplete: 'off', maxlength: '120',
      })
      const doSave = () => {
        const name = nameInput.value.trim()
        if (!name) {
          fail('Enter a name for the view.')
          nameInput.focus()
          return
        }
        if (authorViews.some((v) => v.name === name)) {
          fail(`This report already has a view called '${name}'.`)
          nameInput.focus()
          return
        }
        const { replaced, ok } = saveView(name)
        openViewsPanel(ok ? `${replaced ? 'Replaced' : 'Saved'} '${name}'.` : viewStore.error, !ok)
      }
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          doSave()
        }
      })
      const saveBtn = h('button', { class: 'pqv-btn pqv-primary', type: 'button', text: 'Save', onclick: doSave })

      const item = (v, own) => {
        const row = h('div', { class: v.name === activeView ? 'pqv-view pqv-view-on' : 'pqv-view' })
        const apply = h('button', {
          class: 'pqv-view-apply', type: 'button',
          title: v.name === activeView ? 'This is the current view' : 'Switch to this view',
          onclick: () => applyView(v),
        },
        h('span', { class: 'pqv-view-name', text: v.name }),
        h('span', { class: 'pqv-view-desc', text: describeView(resolveView(v)) }))
        row.append(apply)
        if (!own) return row
        const acts = h('span', { class: 'pqv-view-acts' })
        const link = (text, title, onclick, cls = 'pqv-link') => h('button', { class: cls, type: 'button', text, title, onclick })
        acts.append(
          link('Update', 'Replace this view with the current columns, filters and sort', () => {
            const k = savedViews.indexOf(v)
            if (k < 0) return
            savedViews[k] = currentView(v.name)
            const ok = saveViews()
            updateViewLabel()
            openViewsPanel(ok ? `Updated '${v.name}'.` : viewStore.error, !ok)
          }),
          link('Rename', 'Rename this view', () => {
            const input = h('input', {
              class: 'pqv-input', type: 'text', value: v.name, 'aria-label': `New name for ${v.name}`,
              spellcheck: 'false', autocomplete: 'off', maxlength: '120',
            })
            apply.replaceWith(input)
            acts.hidden = true
            input.focus()
            input.select()
            input.addEventListener('keydown', (e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              const to = input.value.trim()
              if (!to || to === v.name) return openViewsPanel()
              if (viewNamed(to)) return fail(`There is already a view called '${to}'.`)
              const from = v.name
              v.name = to
              const ok = saveViews()
              updateViewLabel()
              openViewsPanel(ok ? `Renamed '${from}' to '${to}'.` : viewStore.error, !ok)
            })
          }),
          link('Delete', 'Delete this view', () => {
            acts.textContent = ''
            acts.append(
              h('span', { class: 'pqv-view-ask', text: 'Delete?' }),
              link('Delete', `Delete '${v.name}'`, () => {
                savedViews = savedViews.filter((s) => s !== v)
                const ok = saveViews()
                updateViewLabel()
                openViewsPanel(ok ? `Deleted '${v.name}'.` : viewStore.error, !ok)
              }, 'pqv-link pqv-danger'),
              link('Keep', 'Keep this view', () => openViewsPanel()))
          }))
        row.append(acts)
        return row
      }

      const list = h('div', { class: 'pqv-views-list' })
      if (authorViews.length) {
        list.append(h('div', { class: 'pqv-views-group', text: 'In this report' }))
        for (const v of authorViews) list.append(item(v, false))
      }
      list.append(h('div', { class: 'pqv-views-group', text: 'Saved in this browser' }))
      for (const v of savedViews) list.append(item(v, true))
      if (!savedViews.length) {
        list.append(h('div', {
          class: 'pqv-views-empty',
          text: 'None yet. Name the current columns, filters and sort above to come back to them later.',
        }))
      }
      const rBtn = h('button', {
        class: 'pqv-btn pqv-btn-sm', type: 'button',
        title: 'Copy pqview_view() code for the current view, to add it to a report with pqview(views = ...)',
      })
      rBtn.innerHTML = COPY_ICON + '<span>Copy as R code</span>'
      rBtn.addEventListener('click', async () => {
        const ok = await copyText(api.views.rCode())
        const label = rBtn.querySelector('span')
        label.textContent = ok ? 'Copied' : 'Copy failed'
        setTimeout(() => { label.textContent = 'Copy as R code' }, 1500)
      })
      const pop = h('div', { class: 'pqv-pop pqv-viewspanel', role: 'dialog', 'aria-label': 'Views' },
        h('div', { class: 'pqv-pop-title', text: 'Views' }),
        h('div', { class: 'pqv-views-save' }, nameInput, saveBtn),
        msg,
        list,
        h('div', { class: 'pqv-pop-foot pqv-views-foot' }, rBtn,
          h('span', { class: 'pqv-opt-note', text: 'A view keeps columns, filters, search, WHERE, sort and counts. Marks are not part of views.' })))
      grid.openPop(viewsBtn, pop, nameInput)
    }
    api.openViewsPanel = openViewsPanel
    viewsBtn.addEventListener('click', () => {
      if (grid.pop && grid.pop.anchor === viewsBtn) grid.closePop()
      else openViewsPanel()
    })

    const initial = defaultColumns.slice()
    for (const col of restoreMarks()) initial.push(col.name)
    counts.refreshFields()
    picker.setSelected(initial.filter(hasCol))
    state.pinned = [].concat(x.pin || []).filter(hasCol)
    for (const [name, f] of startFormats) state.formats.set(name, { ...f })
    state.sort = [].concat(x.sort || [])
      .filter((s) => s && typeof s.name === 'string' && hasCol(s.name))
      .map((s) => ({ name: s.name, dir: s.dir === 'desc' ? 'desc' : 'asc' }))
    await setSelected(picker.selected())
    for (const col of markers.values()) picker.setChart(col.name, chartFor(col))
    if (queryInput.value.trim()) await runQuery()
    if (x.counts) {
      counts.setConfig({ by: [].concat(x.counts) })
      setCountsOpen(true)
    }
    recordSoon.cancel()
    history.current = takeSnapshot()
    updateViewLabel()
    timings.firstTable = performance.now() - t0

    // Decode the remaining columns in the background so their stats appear
    // in the picker and selecting them later is instant.
    if (ds.n * ds.fields.length <= BACKGROUND_CELLS) {
      const pending = ds.fields.map((f) => f.name)
      const step = async () => {
        let name
        while ((name = pending.shift()) !== undefined && ds.peek(name)) { /* already decoded */ }
        if (name === undefined) {
          timings.allDecoded = performance.now() - t0
          return
        }
        await decode(name)
        idle(step)
      }
      idle(step)
    }
  }
}
