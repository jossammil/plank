// pqview: wires the dataset, picker, grid, query bar and toolbar together.

import { h, debounce, idle } from './dom.js'
import { decodeBase64, openDataset } from './load.js'
import { computeView, emptySpec, isActive, hasOptions, compileRegex } from './filters.js'
import { parseQuery, compileQuery, evaluateQuery, resolveColumn, QueryError } from './query.js'
import { toCSV } from './csv.js'
import { Grid } from './grid.js'
import { Picker } from './picker.js'
import { chartSVG, overlayCounts } from './spark.js'
import {
  makeMarker, setMarks, usedValues, serializeMarkers, deserializeMarkers, fingerprint,
} from './markers.js'

const DEFAULT_VISIBLE = 10
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
    mono: loadPref('mono') === null ? x.font === 'mono' : loadPref('mono') === '1',
    query: loadPref('query') !== '0',
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
    el.style.setProperty('--pqv-top', topOffset + 'px')
  }

  const state = {
    selected: [], cols: [], specs: new Map(), sort: [], view: new Uint32Array(0),
    search: '', searchRegex: loadPref('searchRegex') === '1', searchInvert: false,
    queryMask: null, queryInvert: false, queryError: null, queryCols: [], computed: false,
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
    const clearBtn = h('button', { class: 'pqv-btn', type: 'button', text: 'Clear filters', hidden: true })
    const markBtn = h('button', {
      class: 'pqv-btn', type: 'button', text: 'Mark', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      title: 'Add a marker column and mark the filtered rows',
    })
    const exportBtn = h('button', {
      class: 'pqv-btn', type: 'button', text: 'Export CSV',
      title: 'Download the filtered rows and visible columns as CSV',
    })
    const queryBtn = toggle('Query', 'Show or hide the WHERE query bar', prefs.query)
    const monoBtn = toggle('Mono', 'Monospace font', prefs.mono)
    const themeBtn = h('button', { class: 'pqv-btn pqv-icon', type: 'button' })

    const toolbar = h('div', { class: 'pqv-toolbar' },
      pickerBtn,
      x.title ? h('div', { class: 'pqv-title', text: x.title, title: x.title }) : null,
      h('div', { class: 'pqv-searchgroup' }, searchInput, searchRegexBtn, searchNotBtn),
      status, clearBtn, markBtn, exportBtn,
      h('div', { class: 'pqv-switches' }, queryBtn, monoBtn, themeBtn))

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
    const queryBar = h('div', { class: 'pqv-querybar', hidden: !prefs.query },
      h('div', { class: 'pqv-query-row' },
        h('label', { class: 'pqv-query-label', text: 'WHERE' }),
        queryInput, queryNotBtn, queryHelpBtn),
      queryMsg)
    queryBar.querySelector('label').addEventListener('click', () => queryInput.focus())

    const pickerHost = h('div', { class: 'pqv-picker' })
    const gridHost = h('div', { class: 'pqv-gridwrap' })
    const body = h('div', { class: 'pqv-body' }, pickerHost, gridHost)

    // Marker columns live alongside the decoded parquet columns.
    const markers = new Map()
    const fieldNames = () => ds.fields.map((f) => f.name).concat(Array.from(markers.keys()))
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
    }
    const recomputeSoon = debounce(recompute, 90)

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
      const wanted = names.filter(hasCol)
      const cols = []
      for (const name of wanted) cols.push(await decode(name))
      if (token !== selectToken) return
      const keep = new Set(wanted)
      state.selected = wanted
      state.cols = cols
      // Filters and sort keys belong to visible columns only.
      for (const name of Array.from(state.specs.keys())) if (!keep.has(name)) state.specs.delete(name)
      state.sort = state.sort.filter((s) => keep.has(s.name))
      grid.setColumns(cols)
      grid.setSort(state.sort)
      recompute(false)
    }

    const picker = new Picker(pickerHost, {
      fields: ds.fields,
      n: ds.n,
      onChange: (names) => setSelected(names),
    })
    api.picker = picker
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
    queryBtn.addEventListener('click', () => {
      prefs.query = queryBar.hidden
      queryBar.hidden = !prefs.query
      savePref('query', prefs.query ? '1' : '0')
      setPressed(queryBtn, prefs.query)
      grid.schedule()
      if (prefs.query) queryInput.focus()
    })

    // ---- marker columns -------------------------------------------------
    const marksKey = 'pqview.marks.' + fingerprint(ds.n, ds.fields.map((f) => f.name), String(x.data || ''))
    const marksStore = { error: null }
    const saveMarks = () => {
      try {
        if (!markers.size) window.localStorage.removeItem(marksKey)
        else window.localStorage.setItem(marksKey, JSON.stringify(serializeMarkers(Array.from(markers.values()))))
        marksStore.error = null
      } catch (err) {
        marksStore.error = 'Marks could not be saved in this browser (storage is full or blocked). Export CSV to keep them.'
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
    const createMarker = async (name) => {
      const col = makeMarker(name, ds.n)
      markers.set(name, col)
      picker.addField(markerField(col))
      picker.updateStats(col, true)
      picker.setChart(col.name, chartFor(col))
      await setSelected(picker.selected())
      saveMarksSoon()
      return col
    }
    // After marks change: repaint the header, stats, chart and rows, and
    // re-run a WHERE query that uses the marker.
    const afterMarks = async (col) => {
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
      grid.widths.delete(from)
      await setSelected(picker.selected())
      saveMarksSoon()
    }
    const deleteMarker = async (name) => {
      markers.delete(name)
      state.specs.delete(name)
      picker.removeField(name)
      await reselect()
      saveMarksSoon()
    }

    let lastMarker = null
    let lastValue = 'yes'
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
            'Marks are saved in this browser; Export CSV includes them, with a row column for joining back in R.',
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
      grid.setColumns(state.cols)
      recompute()
    })
    exportBtn.addEventListener('click', () => {
      if (!state.cols.length) return
      const rowNumbers = state.cols.some((c) => c.marker)
      const blob = new Blob(toCSV(state.cols, state.view, { rowNumbers }), { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const base = String(x.title || 'data').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'data'
      const a = h('a', { href: url, download: `${base}.csv` })
      el.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    })

    loading.remove()
    el.append(toolbar, queryBar, body)
    // On a narrow container the table matters more than the column list.
    if (el.clientWidth && el.clientWidth < 640) {
      pickerHost.hidden = true
      pickerBtn.setAttribute('aria-expanded', 'false')
    }
    timings.columnsListed = performance.now() - t0

    const initial = x.columns == null
      ? ds.fields.slice(0, DEFAULT_VISIBLE).map((f) => f.name)
      : [].concat(x.columns)
    for (const col of restoreMarks()) initial.push(col.name)
    picker.setSelected(initial.filter(hasCol))
    await setSelected(picker.selected())
    for (const col of markers.values()) picker.setChart(col.name, chartFor(col))
    if (queryInput.value.trim()) await runQuery()
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
