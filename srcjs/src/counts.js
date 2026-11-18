// The Counts panel: a live table of how many filtered rows fall in each value
// (or range, or period) of one or two columns, with an optional statistic of
// a number column. Clicking a group filters to it through the WHERE query.

import { h } from './dom.js'
import {
  BINS, STATS, defaultBin, groupKey, countGroups, sortGroups, groupCondition, excludeCondition,
  formatStat, statDecimals, groupTable,
} from './summary.js'

const PAGE = 300
const MIN_COL = 40
const VALUE_TAGS = new Set(['int', 'dbl', 'lgl'])
const STAT_LABEL = Object.fromEntries(STATS)

const csvField = (s) => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s)

function pct(count, total) {
  if (!total) return '0%'
  const p = (count / total) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return (p >= 99.95 && count < total ? '>99.9' : p.toFixed(1)) + '%'
}

// The span of a set of statistics with zero inside it, so bars of negative
// values grow left from a zero line and positive ones right.
function barScale(groups) {
  let lo = 0
  let hi = 0
  for (const g of groups) {
    const v = g.value
    if (v === null || !Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return { lo, hi, span: hi - lo }
}

/** A bar for one statistic inside a track the width of its cell. */
function valueBar(v, { lo, span }) {
  const track = h('span', { class: 'pqv-ctrack' })
  if (lo < 0) {
    const zero = h('span', { class: 'pqv-czero' })
    zero.style.left = ((-lo / span) * 100).toFixed(2) + '%'
    track.append(zero)
  }
  if (v === null || !Number.isFinite(v) || !span) return track
  const bar = h('span', { class: v < 0 ? 'pqv-cbar pqv-cbar-neg' : 'pqv-cbar' })
  bar.style.left = (((Math.min(v, 0) - lo) / span) * 100).toFixed(2) + '%'
  bar.style.width = ((Math.abs(v) / span) * 100).toFixed(2) + '%'
  track.append(bar)
  return track
}

export class CountsPanel {
  /**
   * @param {HTMLElement} host element the panel fills
   * @param {object} opts
   * @param {() => {name: string, tag: string}[]} opts.fields every column, markers last
   * @param {(name: string) => Promise<object>} opts.getCol decoded column
   * @param {() => Uint32Array} opts.getView the filtered and sorted rows
   * @param {() => string|null} opts.defaultBy column to count by when none is chosen
   * @param {(cond: string) => void} opts.onDrill add a condition to the WHERE query
   * @param {(text: string) => Promise<boolean>} opts.copyText
   * @param {(blob: Blob) => void} opts.download save a CSV of the counts
   * @param {() => void} opts.onClose
   * @param {() => void} [opts.onChange] the panel was opened, closed or set to count differently
   * @param {(px: number) => void} [opts.onHeight] the table's height was dragged
   * @param {number} [opts.height] remembered table height
   * @param {(name: string) => object|null} [opts.getFormat] display format of a number column
   */
  constructor(host, opts) {
    this.opts = opts
    this.el = host
    this.cfg = { by: [null, null], bins: [null, null], value: null, stat: 'mean', bars: 'rows' }
    this.sortBy = 'count'
    this.sortDir = 'desc'
    this.limit = PAGE
    this.token = 0
    this.result = null
    this.timings = {}
    // Column widths the user dragged: { sig, widths: Map(id -> px), set: Set(id) }
    // where sig names the columns shown. Null while the layout is automatic.
    this.colW = null

    const sel = (label) => h('select', { class: 'pqv-input', 'aria-label': label })
    this.byA = sel('Count rows by')
    this.binA = sel('Group values of the first column by')
    this.byB = sel('Then by')
    this.binB = sel('Group values of the second column by')
    this.valueSel = sel('Value column')
    this.statSel = sel('Statistic')
    for (const [k, label] of STATS) this.statSel.append(h('option', { value: k, text: label }))
    const barBtn = (mode, text, title) => h('button', {
      class: 'pqv-toggle pqv-cbars-opt', type: 'button', text, title, 'data-bars': mode, 'aria-pressed': 'false',
    })
    this.barBtns = [
      barBtn('rows', 'Rows', 'Bars show the number of rows in each group'),
      barBtn('value', 'Value', 'Bars show the calculated value of each group'),
    ]
    this.barsBox = h('span', { class: 'pqv-counts-bars', role: 'group', 'aria-label': 'Bars show', hidden: true },
      h('span', { class: 'pqv-counts-word', text: 'bars' }), this.barBtns)
    this.info = h('span', { class: 'pqv-counts-info', 'aria-live': 'polite' })
    this.copyBtn = h('button', { class: 'pqv-btn pqv-btn-sm', type: 'button', text: 'Copy', title: 'Copy every group as tab-separated text' })
    this.csvBtn = h('button', { class: 'pqv-btn pqv-btn-sm', type: 'button', text: 'CSV', title: 'Download every group as a CSV file' })
    this.closeBtn = h('button', { class: 'pqv-btn pqv-btn-sm pqv-icon-sm', type: 'button', text: '×', title: 'Close the Counts panel', 'aria-label': 'Close the Counts panel' })
    this.table = h('table', { class: 'pqv-counts-table' })
    this.scroll = h('div', { class: 'pqv-counts-scroll' }, this.table)
    this.msg = h('div', { class: 'pqv-counts-msg' })
    this.more = h('button', { class: 'pqv-link', type: 'button', hidden: true })
    this.shown = h('span', { class: 'pqv-counts-shown' })
    const resizer = h('div', { class: 'pqv-counts-resizer', title: 'Drag to resize' })
    if (opts.height) this.el.style.setProperty('--pqv-counts-h', opts.height + 'px')

    this.el.append(
      h('div', { class: 'pqv-counts-head' },
        h('span', { class: 'pqv-counts-label', text: 'Count rows by' }),
        h('span', { class: 'pqv-counts-pick' }, this.byA, this.binA),
        h('span', { class: 'pqv-counts-word', text: 'then' }),
        h('span', { class: 'pqv-counts-pick' }, this.byB, this.binB),
        h('span', { class: 'pqv-counts-word', text: 'value' }),
        h('span', { class: 'pqv-counts-pick' }, this.valueSel, this.statSel),
        this.barsBox,
        this.info,
        h('span', { class: 'pqv-counts-tools' }, this.copyBtn, this.csvBtn, this.closeBtn)),
      this.msg,
      this.scroll,
      h('div', { class: 'pqv-counts-foot' }, this.shown, this.more,
        h('span', { class: 'pqv-counts-hint', text: 'Click a row to show only that group; Exclude hides it. Both add to the WHERE query.' })),
      resizer)

    const changed = () => {
      this.limit = PAGE
      this.update()
      if (opts.onChange) opts.onChange()
    }
    this.byA.addEventListener('change', () => {
      this.cfg.by[0] = this.byA.value || null
      this.cfg.bins[0] = null
      changed()
    })
    this.byB.addEventListener('change', () => {
      this.cfg.by[1] = this.byB.value || null
      this.cfg.bins[1] = null
      changed()
    })
    this.binA.addEventListener('change', () => { this.cfg.bins[0] = this.binA.value; changed() })
    this.binB.addEventListener('change', () => { this.cfg.bins[1] = this.binB.value; changed() })
    this.valueSel.addEventListener('change', () => {
      if (!this.cfg.value && this.valueSel.value) this.cfg.bars = 'value'
      this.cfg.value = this.valueSel.value || null
      if (!this.cfg.value && this.sortBy === 'value') this.sortBy = 'count'
      changed()
    })
    this.statSel.addEventListener('change', () => { this.cfg.stat = this.statSel.value; changed() })
    for (const btn of this.barBtns) {
      btn.addEventListener('click', () => {
        if (this.cfg.bars === btn.dataset.bars) return
        this.cfg.bars = btn.dataset.bars
        this.render()
        if (opts.onChange) opts.onChange()
      })
    }
    this.more.addEventListener('click', () => {
      this.limit += PAGE
      this.render()
    })
    this.closeBtn.addEventListener('click', () => opts.onClose())
    this.copyBtn.addEventListener('click', async () => {
      const ok = await opts.copyText(this.textTable('\t'))
      this.copyBtn.textContent = ok ? 'Copied' : 'Copy failed'
      setTimeout(() => { this.copyBtn.textContent = 'Copy' }, 1500)
    })
    this.csvBtn.addEventListener('click', () => {
      opts.download(new Blob([this.textTable(',')], { type: 'text/csv;charset=utf-8' }))
    })
    this.table.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.pqv-ccol-grip')
      if (grip) this.startColResize(e, grip)
    })
    this.table.addEventListener('dblclick', (e) => {
      const grip = e.target.closest('.pqv-ccol-grip')
      if (grip) this.autoWidth(grip.dataset.col)
    })
    this.table.addEventListener('click', (e) => {
      if (e.target.closest('.pqv-ccol-grip')) return
      const tr = e.target.closest('tr[data-g]')
      if (tr) return this.drill(+tr.dataset.g, !!e.target.closest('.pqv-counts-ex'))
      const th = e.target.closest('button[data-sort]')
      if (th) this.sortOn(th.dataset.sort)
    })
    this.table.addEventListener('keydown', (e) => {
      const grip = e.target.closest('.pqv-ccol-grip')
      if (grip) return this.gripKey(e, grip)
      const tr = e.target.closest('tr[data-g]')
      if (tr && e.target === tr && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        this.drill(+tr.dataset.g, false)
      }
    })
    resizer.addEventListener('pointerdown', (e) => this.startResize(e))
    this.refreshFields()
  }

  get open() {
    return !this.el.hidden
  }

  /** The panel's settings, for saving in a view; null when it is closed. */
  config() {
    if (!this.open || !this.cfg.by[0]) return null
    const by = this.cfg.by.filter(Boolean)
    return {
      by,
      bins: by.map((_, k) => this.cfg.bins[k] || null),
      value: this.cfg.value,
      stat: this.cfg.stat,
      bars: this.cfg.value ? this.cfg.bars : 'rows',
    }
  }

  /** Apply saved settings (from a view) and open the panel. */
  setConfig(c) {
    const has = (name) => this.opts.fields().some((f) => f.name === name)
    const by = (c.by || []).filter(has)
    this.cfg = {
      by: [by[0] || null, by[1] || null],
      bins: [by[0] ? (c.bins && c.bins[0]) || null : null, by[1] ? (c.bins && c.bins[1]) || null : null],
      value: c.value && has(c.value) ? c.value : null,
      stat: STAT_LABEL[c.stat] ? c.stat : 'mean',
      bars: 'rows',
    }
    this.cfg.bars = c.bars === 'rows' || c.bars === 'value' ? c.bars : this.cfg.value ? 'value' : 'rows'
    this.limit = PAGE
    this.refreshFields()
  }

  renameField(from, to) {
    this.cfg.by = this.cfg.by.map((x) => (x === from ? to : x))
    if (this.cfg.value === from) this.cfg.value = to
    this.refreshFields()
  }

  /** Rebuild the column lists, for example after a marker column was added. */
  refreshFields() {
    const fields = this.opts.fields()
    const names = new Set(fields.map((f) => f.name))
    if (this.cfg.by[0] && !names.has(this.cfg.by[0])) this.cfg.by[0] = null
    if (this.cfg.by[1] && !names.has(this.cfg.by[1])) this.cfg.by[1] = null
    if (this.cfg.value && !names.has(this.cfg.value)) this.cfg.value = null
    const fill = (select, list, none, value) => {
      select.textContent = ''
      if (none) select.append(h('option', { value: '', text: none }))
      for (const f of list) select.append(h('option', { value: f.name, text: f.name }))
      select.value = value || ''
    }
    fill(this.byA, fields, fields.length ? null : '(no columns)', this.cfg.by[0])
    fill(this.byB, fields, '(none)', this.cfg.by[1])
    fill(this.valueSel, fields.filter((f) => VALUE_TAGS.has(f.tag)), '(none: rows only)', this.cfg.value)
    this.statSel.value = this.cfg.stat
  }

  show(on) {
    this.el.hidden = !on
    if (this.opts.onChange) this.opts.onChange()
    if (on) {
      if (!this.cfg.by[0]) {
        this.cfg.by[0] = this.opts.defaultBy()
        this.refreshFields()
      }
      this.update()
    } else {
      this.token++
    }
  }

  /** Recount over the current rows. Does nothing while the panel is closed. */
  async update() {
    if (!this.open) return
    const token = ++this.token
    const [a, b] = this.cfg.by
    this.byA.value = a || ''
    this.byB.value = b || ''
    this.valueSel.value = this.cfg.value || ''
    this.statSel.disabled = !this.cfg.value
    if (!a) {
      this.result = null
      this.binA.hidden = true
      this.binB.hidden = true
      this.render('Choose a column to count by.')
      return
    }
    let colA
    let colB = null
    let colV = null
    try {
      colA = await this.opts.getCol(a)
      if (b) colB = await this.opts.getCol(b)
      if (this.cfg.value) colV = await this.opts.getCol(this.cfg.value)
    } catch (err) {
      if (token === this.token) this.render(String((err && err.message) || err))
      return
    }
    if (token !== this.token) return
    const bad = [colA, colB, colV].find((c) => c && c.error)
    if (bad) {
      this.result = null
      this.render(`Column '${bad.name}' could not be decoded: ${bad.error}`)
      return
    }
    if (colV && !(colV.type === 'number' || colV.type === 'boolean')) colV = null
    const binFor = (sel, col, k) => {
      const bins = BINS[col.type]
      sel.hidden = !bins
      if (!bins) return 'value'
      let bin = this.cfg.bins[k]
      if (!bin || !bins.some(([key]) => key === bin)) bin = defaultBin(col)
      sel.textContent = ''
      for (const [key, label] of bins) sel.append(h('option', { value: key, text: label }))
      sel.value = bin
      return bin
    }
    const binA = binFor(this.binA, colA, 0)
    const binB = colB ? binFor(this.binB, colB, 1) : null
    if (!colB) this.binB.hidden = true
    const t = performance.now()
    const keys = [groupKey(colA, binA)]
    if (colB) keys.push(groupKey(colB, binB))
    const t1 = performance.now()
    const view = this.opts.getView()
    const groups = countGroups(view, keys, colV, this.cfg.stat)
    sortGroups(groups, keys, this.sortBy === 'value' && !colV ? 'count' : this.sortBy, this.sortDir)
    this.timings = { keys: t1 - t, count: performance.now() - t1 }
    this.result = { keys, groups, total: view.length, valueCol: colV, stat: this.cfg.stat }
    this.render()
  }

  sortOn(by) {
    if (this.sortBy === by) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc'
    else {
      this.sortBy = by
      this.sortDir = by === 'key' ? 'asc' : 'desc'
    }
    if (this.result) {
      const r = this.result
      sortGroups(r.groups, r.keys, this.sortBy, this.sortDir)
      this.render()
    }
  }

  drill(g, exclude) {
    const r = this.result
    if (!r || !r.groups[g]) return
    const group = r.groups[g]
    this.opts.onDrill(exclude ? excludeCondition(r.keys, group) : groupCondition(r.keys, group))
  }

  textTable(sep) {
    const r = this.result
    if (!r) return ''
    const rows = groupTable(r.groups, r.keys, r.total, r.valueCol, r.stat)
    const cell = sep === ',' ? csvField : (s) => s.replace(/[\t\r\n]+/g, ' ')
    return rows.map((row) => row.map(cell).join(sep)).join('\r\n') + '\r\n'
  }

  render(message = '') {
    const r = this.result
    this.table.textContent = ''
    this.msg.textContent = message
    this.msg.hidden = !message
    this.copyBtn.disabled = !r
    this.csvBtn.disabled = !r
    this.barsBox.hidden = !(r && r.valueCol)
    if (!r) {
      this.info.textContent = ''
      this.shown.textContent = ''
      this.more.hidden = true
      return
    }
    const { keys, groups, total, valueCol, stat } = r
    const valueBars = !!valueCol && this.cfg.bars === 'value'
    for (const btn of this.barBtns) btn.setAttribute('aria-pressed', String(btn.dataset.bars === (valueBars ? 'value' : 'rows')))
    this.info.textContent = `${groups.length.toLocaleString()} group${groups.length === 1 ? '' : 's'} · ` +
      `${total.toLocaleString()} row${total === 1 ? '' : 's'}`
    const cols = [
      ...keys.map((k, i) => ({ id: `k${i}:${k.col.name}`, label: k.col.name, cls: 'pqv-ck', by: i === 0 ? 'key' : null, title: i === 0 ? 'Sort by the group values' : null })),
      { id: 'count', label: 'Rows', cls: 'pqv-cn', by: 'count' },
      { id: 'pct', label: '%', cls: valueBars ? 'pqv-cp pqv-cp-text' : 'pqv-cp' },
      valueCol ? { id: 'v:' + valueCol.name, label: `${STAT_LABEL[stat]} ${valueCol.name}`, cls: valueBars ? 'pqv-cn pqv-cv pqv-cvbar' : 'pqv-cn pqv-cv', by: 'value' } : null,
      { id: 'actions', label: '', cls: 'pqv-ca' },
    ].filter(Boolean)
    const sig = cols.map((c) => c.id).join('\u0000')
    if (this.colW && this.colW.sig !== sig) this.colW = null
    this.colSig = sig
    const arrow = (by) => (this.sortBy === by ? (this.sortDir === 'asc' ? ' ▲' : ' ▼') : '')
    const th = (c) => h('th', {
      class: c.by ? c.cls + ' pqv-csort' : c.cls, scope: 'col', 'data-col': c.id,
      'aria-sort': c.by && this.sortBy === c.by ? (this.sortDir === 'asc' ? 'ascending' : 'descending') : null,
    },
    c.by ? h('button', { type: 'button', 'data-sort': c.by, title: c.title || `Sort by ${c.label}`, text: c.label + arrow(c.by) }) : c.label,
    h('span', {
      class: 'pqv-ccol-grip', 'data-col': c.id, role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',
      'aria-label': c.label ? `Resize the ${c.label} column` : 'Resize the last column',
      title: 'Drag to resize this column; double-click for automatic width',
    }))
    const headRow = h('tr', null, cols.map(th))
    const colgroup = h('colgroup', null, cols.map((c) => h('col', { 'data-col': c.id })))
    const body = h('tbody')
    let max = 0
    for (const g of groups) if (g.count > max) max = g.count
    const fmt = valueCol && this.opts.getFormat ? this.opts.getFormat(valueCol.name) : null
    const decimals = valueCol ? statDecimals(groups.map((g) => g.value), valueCol.digits || 7) : null
    const scale = valueBars ? barScale(groups) : null
    const shown = Math.min(groups.length, this.limit)
    for (let j = 0; j < shown; j++) {
      const g = groups[j]
      const label = (k, id) => h('td', { class: id < 0 ? 'pqv-ck pqv-isna' : 'pqv-ck', text: k.label(id) })
      let pctCell
      if (valueBars) pctCell = h('td', { class: 'pqv-cp pqv-cp-text', text: pct(g.count, total) })
      else {
        const bar = h('span', { class: 'pqv-cbar' })
        bar.style.width = (max ? (g.count / max) * 100 : 0).toFixed(1) + '%'
        pctCell = h('td', { class: 'pqv-cp' }, bar, h('span', { class: 'pqv-cpv', text: pct(g.count, total) }))
      }
      let valueCell = null
      if (valueCol) {
        const text = formatStat(g.value, valueCol, stat, fmt, decimals)
        const cls = 'pqv-cn pqv-cv' + (valueBars ? ' pqv-cvbar' : '') + (g.value === null ? ' pqv-isna' : '')
        valueCell = valueBars
          ? h('td', { class: cls }, valueBar(g.value, scale), h('span', { class: 'pqv-cpv', text }))
          : h('td', { class: cls, text })
      }
      body.append(h('tr', { 'data-g': String(j), tabindex: '0', title: 'Click to show only this group' },
        label(keys[0], g.a),
        keys[1] ? label(keys[1], g.b) : null,
        h('td', { class: 'pqv-cn', text: g.count.toLocaleString() }),
        pctCell,
        valueCell,
        h('td', { class: 'pqv-ca' }, h('button', {
          class: 'pqv-link pqv-counts-ex', type: 'button', text: 'Exclude', title: 'Hide this group (adds to the WHERE query)',
        }))))
    }
    this.table.append(colgroup, h('thead', null, headRow), body)
    this.applyWidths()
    if (!groups.length) this.msg.textContent = 'No rows match the current filters.'
    this.msg.hidden = !!groups.length
    this.shown.textContent = groups.length > shown ? `Showing ${shown.toLocaleString()} of ${groups.length.toLocaleString()} groups.` : ''
    this.more.hidden = groups.length <= shown
    this.more.textContent = `Show ${Math.min(PAGE, groups.length - shown).toLocaleString()} more`
  }

  // ---- column widths ----------------------------------------------------------

  /** Fixed widths when the user has resized a column, else the automatic layout. */
  applyWidths() {
    const fixed = !!this.colW
    this.table.classList.toggle('pqv-counts-fixed', fixed)
    let sum = 0
    for (const col of this.table.querySelectorAll('col')) {
      const w = fixed ? this.colW.widths.get(col.dataset.col) : null
      col.style.width = w ? w + 'px' : ''
      sum += w || 0
    }
    this.table.style.width = fixed ? sum + 'px' : ''
  }

  /** Widths of the columns as the automatic layout draws them. */
  autoWidths() {
    const was = this.colW
    this.colW = null
    this.applyWidths()
    const widths = new Map()
    for (const th of this.table.querySelectorAll('thead th')) widths.set(th.dataset.col, Math.round(th.getBoundingClientRect().width))
    this.colW = was
    this.applyWidths()
    return widths
  }

  /** Starts fixed widths from the automatic layout, the first time a column is resized. */
  fixWidths() {
    if (!this.colW) this.colW = { sig: this.colSig, widths: this.autoWidths(), set: new Set() }
    return this.colW
  }

  setWidth(id, px) {
    const w = this.fixWidths()
    w.widths.set(id, Math.max(MIN_COL, Math.round(px)))
    w.set.add(id)
    this.applyWidths()
  }

  /** One column back to its automatic width; all of them once none is set by hand. */
  autoWidth(id) {
    if (!this.colW) return
    this.colW.set.delete(id)
    if (!this.colW.set.size) this.colW = null
    else this.colW.widths.set(id, this.autoWidths().get(id))
    this.applyWidths()
  }

  startColResize(e, grip) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const id = grip.dataset.col
    const x0 = e.clientX
    const w0 = this.fixWidths().widths.get(id)
    grip.classList.add('pqv-dragging')
    const move = (ev) => this.setWidth(id, w0 + ev.clientX - x0)
    const up = () => {
      grip.classList.remove('pqv-dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // Arrow keys resize the column; Enter or Delete gives it back its automatic width.
  gripKey(e, grip) {
    const id = grip.dataset.col
    const step = e.shiftKey ? 40 : 10
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      this.setWidth(id, this.fixWidths().widths.get(id) + (e.key === 'ArrowLeft' ? -step : step))
    } else if (e.key === 'Enter' || e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      this.autoWidth(id)
    }
  }

  startResize(e) {
    e.preventDefault()
    const y0 = e.clientY
    const h0 = this.scroll.offsetHeight
    let px = h0
    const move = (ev) => {
      px = Math.max(60, Math.round(h0 + ev.clientY - y0))
      this.el.style.setProperty('--pqv-counts-h', px + 'px')
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (this.opts.onHeight) this.opts.onHeight(px)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
}
