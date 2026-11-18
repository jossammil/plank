// Virtual-scrolling grid. Only the rows and columns inside the viewport exist
// in the DOM; scrolling rewrites the text of a small pool of cells.

import { h } from './dom.js'
import { cellText } from './store.js'
import { parseNumberInput, parseDateInput, formatNumberAs } from './format.js'
import { textError, hasOptions, compileRegex, hasFilter } from './filters.js'

const ROW_H = 26 // default row height; the Appearance window can change it
const OVERSCAN = 6
// Browsers cap element height (about 17M px in Firefox); beyond this the
// scroll position is mapped proportionally onto the rows.
const MAX_SCROLL_H = 12e6
const MIN_W = 56
const MAX_AUTO_W = 340
const TYPE_MIN_W = { number: 104, date: 132, datetime: 156, boolean: 92, category: 96, string: 96 }
const OPT_W = 28
const MODE_PLACEHOLDER = { contains: 'contains', regex: 'regex', exact: 'equals' }
const MODE_TITLE = {
  contains: 'Rows containing this text',
  regex: 'Rows matching this regular expression',
  exact: 'Rows equal to this text',
}
const FUNNEL = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">'
  + '<path d="M2 3h12l-4.6 5.4V13l-2.8 1.2V8.4z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
const PIN_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">'
  + '<path d="M6 2h4M7 2v4L4.5 9h7L9 6V2M8 9v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'
const OPT_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
  + '<path d="M2 4h7M13 4h1M2 8h2M8 8h6M2 12h8M14 12h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>'
  + '<circle cx="11" cy="4" r="1.8" stroke="currentColor" stroke-width="1.4" fill="none"/>'
  + '<circle cx="6" cy="8" r="1.8" stroke="currentColor" stroke-width="1.4" fill="none"/>'
  + '<circle cx="12" cy="12" r="1.8" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>'

/** Short labels for the options in effect on a column, shown in its header. */
function badgeList(col, spec) {
  const out = []
  if (spec.join === 'or') out.push({ text: 'OR', title: 'OR filter: a row needs to match this or another OR filter' })
  if (spec.invert) out.push({ text: 'NOT', title: 'Showing everything except the matches' })
  if (col.type === 'string') {
    if (spec.mode === 'regex') out.push({ text: '.*', title: 'Regular expression' })
    if (spec.mode === 'exact') out.push({ text: '=', title: 'Exact value' })
    if (spec.caseSensitive) out.push({ text: 'Aa', title: 'Case sensitive' })
  }
  if (spec.na === 'exclude') out.push({ text: 'no NA', title: 'Missing values hidden' })
  if (spec.na === 'only') out.push({ text: 'NA', title: 'Only missing values' })
  return out
}

export class Grid {
  /**
   * @param {HTMLElement} host
   * @param {object} opts
   * @param {HTMLElement} opts.root widget root, used to position popovers
   * @param {number} opts.n total rows in the dataset
   * @param {(name: string) => object} opts.getSpec filter spec for a column
   * @param {(name: string, debounced: boolean) => void} opts.onFilter
   * @param {(name: string, additive: boolean) => void} opts.onSort
   * @param {(col: object, row: number, cell: HTMLElement) => void} [opts.onMarkCell] click on a marker cell
   * @param {(row: number, onNumber: boolean) => void} [opts.onRowClick] click on a row (onNumber: on its row number)
   * @param {(name: string) => void} [opts.onPin] pin or unpin a column
   * @param {(name: string) => object|null} [opts.getFormat] display format of a number column
   * @param {(name: string, fmt: object|null) => void} [opts.onFormat] the display format was changed
   */
  constructor(host, opts) {
    this.opts = opts
    this.cols = []
    this.view = new Uint32Array(0)
    this.sort = []
    this.widths = new Map()
    this.lefts = [0]
    this.layoutVersion = 0
    this.pool = []
    this.pinCount = 0
    this.current = -1
    this.hoverRow = null
    this.cellKey = ''
    this.raf = 0
    this.pop = null
    this.refreshers = new Map()
    this.rowNumW = Math.max(44, 20 + 8 * String(opts.n).length)
    this.rowH = 0

    this.head = h('div', { class: 'pqv-head', role: 'row' })
    this.rowsEl = h('div', { class: 'pqv-rows' })
    // The row numbers and pinned columns: drawn on a layer that stays at the
    // left edge while the rest scrolls sideways.
    this.pinEl = h('div', { class: 'pqv-rows pqv-pinrows' })
    this.canvas = h('div', { class: 'pqv-canvas' }, this.rowsEl, this.pinEl)
    this.scroller = h('div', { class: 'pqv-scroller', tabindex: '0', role: 'grid' }, this.head, this.canvas)
    this.empty = h('div', { class: 'pqv-empty' })
    host.append(this.scroller, this.empty)

    this.scroller.addEventListener('scroll', () => {
      // A popover attached to a cell would drift away from it.
      if (this.pop && this.pop.cell) this.closePop()
      this.schedule()
    }, { passive: true })
    this.canvas.addEventListener('click', (e) => {
      if (!e.target.closest) return
      const cell = e.target.closest('.pqv-markcell')
      if (cell && this.opts.onMarkCell && cell._row !== undefined) {
        if (this.pop && this.pop.anchor === cell) this.closePop()
        else this.opts.onMarkCell(cell._col, cell._row, cell)
        return
      }
      const row = e.target.closest('.pqv-row')
      if (!row || row._i === undefined || !this.opts.onRowClick) return
      // Leave text selection alone.
      const sel = window.getSelection && window.getSelection()
      if (sel && !sel.isCollapsed && String(sel).trim()) return
      this.opts.onRowClick(row._i, !!e.target.closest('.pqv-rownum'))
    })
    this.canvas.addEventListener('mouseover', (e) => {
      const cell = e.target.closest && e.target.closest('.pqv-cell')
      if (!cell) return
      if (cell.scrollWidth > cell.clientWidth) cell.title = cell.textContent
      else cell.removeAttribute('title')
      // A row is drawn in two parts (pinned and scrolling): light up both.
      const row = this.pool[cell.parentNode._r]
      if (row !== this.hoverRow) this.setHover(row)
    })
    this.canvas.addEventListener('mouseleave', () => this.setHover(null))
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.schedule())
      this.ro.observe(this.scroller)
    }
    this.onDocDown = (e) => {
      if (this.pop && !this.pop.el.contains(e.target) && !this.pop.anchor.contains(e.target)) this.closePop()
    }
    this.onDocKey = (e) => {
      if (e.key === 'Escape' && this.pop) {
        const anchor = this.pop.anchor
        this.closePop()
        anchor.focus()
      }
    }
    document.addEventListener('pointerdown', this.onDocDown, true)
    document.addEventListener('keydown', this.onDocKey)
  }

  destroy() {
    if (this.ro) this.ro.disconnect()
    cancelAnimationFrame(this.raf)
    document.removeEventListener('pointerdown', this.onDocDown, true)
    document.removeEventListener('keydown', this.onDocKey)
  }

  // ---- public API -------------------------------------------------------

  /**
   * @param {object[]} cols columns in display order
   * @param {number} [pinCount] how many of the first columns stay in view when scrolling sideways
   */
  setColumns(cols, pinCount = 0) {
    this.closePop()
    this.build(cols, pinCount)
  }

  build(cols, pinCount) {
    this.cols = cols
    this.pinCount = Math.min(pinCount, cols.length)
    for (const col of cols) {
      if (!this.widths.has(col.name)) this.widths.set(col.name, this.autoWidth(col))
    }
    this.buildHead()
    this.layout()
    this.updateSortIcons()
    this.schedule()
  }

  setView(view, resetScroll = true) {
    this.view = view
    if (resetScroll) this.scroller.scrollTop = 0
    this.schedule()
  }

  setSort(sort) {
    this.sort = sort
    this.updateSortIcons()
  }

  /** Highlight the row shown in the detail panel (-1 for none). */
  setCurrent(i) {
    this.current = i
    this.schedule()
  }

  /** Scroll just enough to show the row at view position `pos`. */
  scrollToRow(pos) {
    const sc = this.scroller
    const rowH = this.rowHeight()
    const viewH = Math.max(rowH, sc.clientHeight - this.head.offsetHeight)
    const total = this.view.length * rowH
    const virt = Math.min(total, MAX_SCROLL_H)
    const scaled = total > virt && virt > viewH
    const top = scaled ? (sc.scrollTop / (virt - viewH)) * (total - viewH) : sc.scrollTop
    const y = pos * rowH
    let want
    if (y < top) want = y
    else if (y + rowH > top + viewH) want = y + rowH - viewH
    else return
    sc.scrollTop = scaled ? (want / (total - viewH)) * (virt - viewH) : want
    this.schedule()
  }

  setHover(row) {
    if (this.hoverRow) {
      this.hoverRow.el.classList.remove('pqv-hover')
      this.hoverRow.pel.classList.remove('pqv-hover')
    }
    this.hoverRow = row || null
    if (row) {
      row.el.classList.add('pqv-hover')
      row.pel.classList.add('pqv-hover')
    }
  }

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.render())
  }

  // ---- layout -----------------------------------------------------------

  measure(text) {
    if (!this.ctx) {
      this.ctx = document.createElement('canvas').getContext('2d')
      const cs = getComputedStyle(this.scroller)
      this.ctx.font = `${cs.fontSize} ${cs.fontFamily}`
    }
    return this.ctx.measureText(text).width
  }

  /** Cell text as displayed, with the column's number format if it has one. */
  displayCell(col, i, fmt) {
    if (fmt && col.type === 'number' && !col.isNull[i]) return formatNumberAs(col.num[i], col.digits, fmt)
    return cellText(col, i)
  }

  autoWidth(col) {
    let w = this.measure(col.name) * 1.08 + 36
    const sample = Math.min(col.n, 200)
    const fmt = this.opts.getFormat ? this.opts.getFormat(col.name) : null
    for (let i = 0; i < sample; i++) {
      const t = this.displayCell(col, i, fmt)
      if (t !== null) {
        const tw = this.measure(t.length > 80 ? t.slice(0, 80) : t) + 20
        if (tw > w) w = tw
      }
    }
    // leave room for the filter inputs and the options button
    const floor = (TYPE_MIN_W[col.type] || 96) + OPT_W
    return Math.round(Math.min(MAX_AUTO_W, Math.max(floor, w)))
  }

  /** Row height in pixels, from the --pqv-row-h custom property. */
  rowHeight() {
    if (!this.rowH) {
      const v = parseFloat(getComputedStyle(this.scroller).getPropertyValue('--pqv-row-h'))
      if (v > 0) this.rowH = v
      else return ROW_H // not in the page yet: measure again next time
    }
    return this.rowH
  }

  /**
   * Re-measure column widths and the row height after a change of font, text
   * size or row spacing, keeping the same first row in view.
   */
  remeasure() {
    const before = this.rowHeight()
    const firstRow = this.scroller.scrollTop / before
    this.ctx = null
    this.rowH = 0
    this.widths.clear()
    // Header popovers go with the header; others (such as the Appearance
    // window that made this change) stay open.
    if (this.pop && this.head.contains(this.pop.anchor)) this.closePop()
    this.build(this.cols, this.pinCount)
    this.render() // sizes the canvas for the new row height
    const after = this.rowHeight()
    if (after !== before) this.scroller.scrollTop = Math.round(firstRow * after)
    this.schedule()
  }

  layout() {
    const lefts = [0, this.rowNumW]
    for (const col of this.cols) lefts.push(lefts[lefts.length - 1] + this.widths.get(col.name))
    this.lefts = lefts
    const total = lefts[lefts.length - 1]
    this.head.style.width = total + 'px'
    this.canvas.style.width = total + 'px'
    const cells = this.head.children
    const pins = this.pinCount
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]
      cell.style.width = lefts[c + 1] - lefts[c] + 'px'
      // Pinned header cells stick to the left edge like their rows.
      const pinned = c <= pins
      cell.classList.toggle('pqv-hpin', pinned)
      cell.classList.toggle('pqv-hpin-last', c === pins)
      cell.style.left = pinned ? lefts[c] + 'px' : ''
    }
    this.layoutVersion++
  }

  // ---- header -----------------------------------------------------------

  buildHead() {
    this.head.textContent = ''
    this.refreshers.clear()
    this.head.append(
      h('div', { class: 'pqv-hcell pqv-hrownum', title: 'Row number in the original data' },
        h('div', { class: 'pqv-hname pqv-hname-static' }, '#'),
        h('div', { class: 'pqv-hfilter' })),
    )
    for (const col of this.cols) this.head.append(this.headCell(col))
  }

  headCell(col) {
    const spec = this.opts.getSpec(col.name)
    const title = col.error
      ? `${col.name}: could not be decoded (${col.error})`
      : col.label ? `${col.name}: ${col.label}` : col.name
    const badges = h('span', { class: 'pqv-badges' })
    const nameBtn = h('button', {
      class: 'pqv-hname', type: 'button', title: title + '\nClick to sort, shift-click to add a sort key',
      onclick: (e) => this.opts.onSort(col.name, e.shiftKey),
    },
    h('span', { class: 'pqv-hlabel', text: col.name }),
    badges,
    h('span', { class: 'pqv-sorticon', 'aria-hidden': 'true' }))
    const resizer = h('div', {
      class: 'pqv-resizer',
      title: 'Drag to resize, double-click to fit',
      onpointerdown: (e) => this.startResize(e, col),
      ondblclick: () => {
        this.widths.set(col.name, this.autoWidth(col))
        this.layout()
        this.schedule()
      },
    })
    const controls = this.filterControls(col, spec)
    const opt = h('button', {
      class: 'pqv-opt', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      'aria-label': `${col.name} filter options`, title: 'Filter options: match mode, include or exclude, missing values',
    })
    opt.innerHTML = OPT_ICON
    // Shown while the column has a filter: click to switch it off and on.
    const fbtn = h('button', { class: 'pqv-fbtn', type: 'button', hidden: true })
    fbtn.innerHTML = FUNNEL
    fbtn.addEventListener('click', (e) => {
      e.stopPropagation()
      spec.paused = !spec.paused
      refresh()
      this.opts.onFilter(col.name, false)
    })
    const pinBtn = h('button', { class: 'pqv-pinbtn', type: 'button' })
    pinBtn.innerHTML = PIN_ICON
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.opts.onPin) this.opts.onPin(col.name)
    })
    const pinned = this.cols.indexOf(col) < this.pinCount
    pinBtn.classList.toggle('pqv-on', pinned)
    pinBtn.title = pinned ? 'Unpin this column' : 'Pin this column: keep it at the left while scrolling sideways'
    pinBtn.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${col.name}`)
    pinBtn.setAttribute('aria-pressed', String(pinned))
    const refresh = () => {
      controls.refresh()
      const has = hasFilter(col, spec)
      const on = has && !spec.paused
      fbtn.hidden = !has
      fbtn.classList.toggle('pqv-on', on)
      fbtn.setAttribute('aria-pressed', String(on))
      fbtn.title = on ? 'Filter on: click to switch it off' : 'Filter off: click to switch it back on'
      fbtn.setAttribute('aria-label', `${col.name} filter ${on ? 'on' : 'off'}`)
      if (cell) {
        cell.classList.toggle('pqv-hfiltered', on)
        cell.classList.toggle('pqv-hpaused', has && !!spec.paused)
      }
      const list = badgeList(col, spec)
      badges.textContent = ''
      for (const b of list) badges.append(h('span', { class: 'pqv-badge', text: b.text, title: b.title }))
      opt.classList.toggle('pqv-on', hasOptions(spec))
      // Widen the column if its name and badges no longer fit.
      if ((list.length || has || pinned) && badges.isConnected) {
        const need = Math.ceil(this.measure(col.name) * 1.08 + 40 + badges.offsetWidth + (has ? 20 : 0) + (pinned ? 18 : 0))
        if (need > this.widths.get(col.name)) {
          this.widths.set(col.name, Math.min(need, MAX_AUTO_W + 120))
          this.layout()
          this.schedule()
        }
      }
    }
    opt.addEventListener('click', () => {
      if (this.pop && this.pop.anchor === opt) this.closePop()
      else this.openOptions(col, spec, opt, () => { spec.paused = false; refresh(); this.opts.onFilter(col.name, false) })
    })
    let cell = null
    this.refreshers.set(col.name, refresh)
    cell = h('div', { class: col.marker ? 'pqv-hcell pqv-hmarker' : 'pqv-hcell', role: 'columnheader' },
      h('div', { class: 'pqv-hnamerow' }, fbtn, nameBtn, pinBtn),
      h('div', { class: 'pqv-hfilter' }, controls.nodes, opt),
      resizer)
    cell.dataset.name = col.name
    refresh()
    return cell
  }

  /** The filter input(s) for a column, plus a refresh() that repaints their state. */
  filterControls(col, spec) {
    const out = []
    let refresh = () => {}
    const changed = (debounced) => {
      // Editing a filter switches it back on and updates the indicator.
      spec.paused = false
      const r = this.refreshers.get(col.name)
      if (r) r()
      this.opts.onFilter(col.name, debounced)
    }

    if (col.type === 'number' || col.type === 'date' || col.type === 'datetime') {
      const isNum = col.type === 'number'
      const parse = (text, isMax) => {
        if (isNum) return parseNumberInput(text)
        const wall = parseDateInput(text, isMax)
        if (wall === null || wall !== wall || !col.zone) return wall
        // An upper bound is the last instant before the next wall-clock moment.
        return isMax ? col.zone.toUtc(wall + 1) - 1 : col.zone.toUtc(wall)
      }
      const bound = (key, placeholder) => {
        const input = h('input', {
          class: 'pqv-input', type: 'text', placeholder, value: spec[key + 'Text'],
          spellcheck: 'false', autocomplete: 'off', 'aria-label': `${col.name} ${placeholder}`,
          title: isNum ? `${placeholder === 'min' ? 'Minimum' : 'Maximum'} value` : 'YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DD HH:MM',
        })
        const check = () => {
          const v = parse(input.value, key === 'max')
          const bad = v !== null && v !== v
          input.classList.toggle('pqv-bad', bad)
          spec[key] = bad ? null : v
        }
        if (input.value) check()
        input.addEventListener('input', () => {
          spec[key + 'Text'] = input.value
          check()
          changed(true)
        })
        return input
      }
      out.push(bound('min', isNum ? 'min' : 'from'), bound('max', isNum ? 'max' : 'to'))
    } else if (col.type === 'boolean') {
      const select = h('select', { class: 'pqv-input', 'aria-label': `${col.name} filter` },
        h('option', { value: '', text: 'All' }),
        h('option', { value: 'T', text: 'TRUE' }),
        h('option', { value: 'F', text: 'FALSE' }))
      select.value = spec.bool === null ? '' : spec.bool ? 'T' : 'F'
      select.addEventListener('change', () => {
        spec.bool = select.value === '' ? null : select.value === 'T'
        changed(false)
      })
      out.push(select)
    } else if (col.type === 'category') {
      const btn = h('button', { class: 'pqv-input pqv-levels', type: 'button', 'aria-haspopup': 'dialog' })
      const label = () => {
        const used = col.counts.reduce((a, c) => a + (c > 0 ? 1 : 0), 0)
        btn.textContent = spec.codes === null ? 'All' : `${spec.codes.size} of ${used}`
        btn.classList.toggle('pqv-on', spec.codes !== null)
      }
      label()
      btn.addEventListener('click', () => {
        if (this.pop && this.pop.anchor === btn) this.closePop()
        else this.openLevels(col, spec, btn, () => { label(); changed(false) })
      })
      out.push(btn)
    } else {
      const input = h('input', {
        class: 'pqv-input', type: 'text', value: spec.contains,
        spellcheck: 'false', autocomplete: 'off',
      })
      refresh = () => {
        const err = textError(spec)
        input.placeholder = MODE_PLACEHOLDER[spec.mode]
        input.setAttribute('aria-label', `${col.name} ${MODE_PLACEHOLDER[spec.mode]}`)
        input.classList.toggle('pqv-bad', !!err)
        input.title = err ? `Invalid regular expression: ${err}` : MODE_TITLE[spec.mode]
      }
      input.addEventListener('input', () => {
        spec.contains = input.value
        refresh()
        changed(true)
      })
      out.push(input)
    }
    return { nodes: out, refresh }
  }

  /** Rebuild one column's header (for example after a marker column changed). */
  refreshColumn(name) {
    const k = this.cols.findIndex((c) => c.name === name)
    if (k < 0) return
    const old = this.head.children[k + 1]
    if (this.pop && old.contains(this.pop.anchor)) this.closePop()
    const cell = this.headCell(this.cols[k])
    cell.style.width = old.style.width
    old.replaceWith(cell)
    this.updateSortIcons()
    this.schedule()
  }

  updateSortIcons() {
    const multi = this.sort.length > 1
    for (const cell of this.head.children) {
      const icon = cell.querySelector('.pqv-sorticon')
      if (!icon) continue
      const k = this.sort.findIndex((s) => s.name === cell.dataset.name)
      if (k < 0) {
        icon.textContent = ''
        cell.removeAttribute('aria-sort')
      } else {
        const asc = this.sort[k].dir === 'asc'
        icon.textContent = (asc ? '▲' : '▼') + (multi ? k + 1 : '')
        cell.setAttribute('aria-sort', asc ? 'ascending' : 'descending')
      }
    }
  }

  startResize(e, col) {
    e.preventDefault()
    const startX = e.clientX
    const startW = this.widths.get(col.name)
    const move = (ev) => {
      this.widths.set(col.name, Math.max(MIN_W, Math.round(startW + ev.clientX - startX)))
      this.layout()
      this.schedule()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // ---- popovers ---------------------------------------------------------

  closePop() {
    if (!this.pop) return
    this.pop.el.remove()
    this.pop.anchor.setAttribute('aria-expanded', 'false')
    this.pop = null
  }

  /** Show `el` as a popover under `anchor`, inside the widget. */
  openPop(anchor, el, focus, cell = false) {
    this.closePop()
    const root = this.opts.root
    root.append(el)
    const rr = root.getBoundingClientRect()
    const ar = anchor.getBoundingClientRect()
    const left = Math.max(4, Math.min(ar.left - rr.left, rr.width - el.offsetWidth - 4))
    el.style.left = left + 'px'
    el.style.top = ar.bottom - rr.top + 4 + 'px'
    el.style.maxHeight = Math.max(120, rr.height - (ar.bottom - rr.top) - 12) + 'px'
    anchor.setAttribute('aria-expanded', 'true')
    this.pop = { el, anchor, cell }
    if (focus) focus.focus()
  }

  openOptions(col, spec, anchor, onChange) {
    const sections = []
    const group = (title, name, choices, get, set) => {
      const box = h('fieldset', { class: 'pqv-opt-group' }, h('legend', { text: title }))
      for (const [value, label] of choices) {
        const radio = h('input', { type: 'radio', name, value })
        radio.checked = get() === value
        radio.addEventListener('change', () => {
          if (radio.checked) {
            set(value)
            onChange()
          }
        })
        box.append(h('label', { class: 'pqv-opt-item' }, radio, h('span', { text: label })))
      }
      sections.push(box)
    }
    const id = 'pqv' + Math.random().toString(36).slice(2, 8)

    group('Combine with other filters', id + 'j',
      [['and', 'AND: rows must match'], ['or', 'OR: match this or another OR filter']],
      () => spec.join, (v) => { spec.join = v })

    if (col.type === 'string') {
      group('Match', id + 'm', [['contains', 'Contains'], ['regex', 'Regular expression'], ['exact', 'Exact value']],
        () => spec.mode, (v) => { spec.mode = v })
      const cs = h('input', { type: 'checkbox' })
      cs.checked = spec.caseSensitive
      cs.addEventListener('change', () => {
        spec.caseSensitive = cs.checked
        onChange()
      })
      sections.push(h('label', { class: 'pqv-opt-item pqv-opt-check' }, cs, h('span', { text: 'Case sensitive' })))
    }
    group('Show', id + 's', [['keep', 'Matching rows'], ['invert', 'Everything but the matches']],
      () => (spec.invert ? 'invert' : 'keep'), (v) => { spec.invert = v === 'invert' })
    if (col.nullCount > 0) {
      const pct = (col.nullCount / col.n) * 100
      group(`Missing values (${col.nullCount.toLocaleString()}, ${pct < 0.1 ? '<0.1' : pct.toFixed(pct >= 10 ? 0 : 1)}%)`, id + 'n',
        [['any', 'Show'], ['exclude', 'Hide'], ['only', 'Only missing']],
        () => spec.na, (v) => { spec.na = v })
    } else {
      sections.push(h('div', { class: 'pqv-opt-note', text: 'No missing values in this column.' }))
    }
    if (col.type === 'number' && this.opts.onFormat) {
      // How numbers are shown; filters and exports are not affected.
      const fmt = this.opts.getFormat(col.name) || { decimals: null, big: false }
      const dec = h('select', { class: 'pqv-input', 'aria-label': `${col.name} decimals` },
        h('option', { value: '', text: 'Auto' }),
        [0, 1, 2, 3, 4, 5, 6].map((d) => h('option', { value: String(d), text: String(d) })))
      dec.value = fmt.decimals == null ? '' : String(fmt.decimals)
      const big = h('input', { type: 'checkbox' })
      big.checked = !!fmt.big
      const changed = () => {
        const next = { decimals: dec.value === '' ? null : +dec.value, big: big.checked }
        this.opts.onFormat(col.name, next.decimals == null && !next.big ? null : next)
        // Redraw the column, widening it if the numbers grew.
        this.widths.set(col.name, Math.max(this.widths.get(col.name) || 0, this.autoWidth(col)))
        this.layout()
        this.schedule()
      }
      dec.addEventListener('change', changed)
      big.addEventListener('change', changed)
      sections.push(h('fieldset', { class: 'pqv-opt-group pqv-opt-format' },
        h('legend', { text: 'Display' }),
        h('label', { class: 'pqv-opt-item' }, h('span', { text: 'Decimals' }), dec),
        h('label', { class: 'pqv-opt-item pqv-opt-check' }, big, h('span', { text: 'Thousands separator (1,234)' }))))
    }
    const reset = h('button', {
      class: 'pqv-link', type: 'button', text: 'Reset options',
      onclick: () => {
        spec.mode = 'contains'
        spec.caseSensitive = false
        spec.invert = false
        spec.na = 'any'
        spec.join = 'and'
        onChange()
        this.openOptions(col, spec, anchor, onChange)
      },
    })
    const el = h('div', { class: 'pqv-pop pqv-opts', role: 'dialog', 'aria-label': `${col.name} filter options` },
      h('div', { class: 'pqv-pop-title', text: col.name }),
      h('div', { class: 'pqv-opt-body' }, sections),
      h('div', { class: 'pqv-pop-foot' }, reset))
    this.openPop(anchor, el, el.querySelector('input:checked') || el.querySelector('input'))
  }

  openLevels(col, spec, anchor, onChange) {
    const items = []
    const list = h('div', { class: 'pqv-pop-list' })
    col.levels.forEach((level, code) => {
      if (!col.counts[code]) return
      const cb = h('input', { type: 'checkbox' })
      cb.checked = spec.codes === null || spec.codes.has(code)
      const row = h('label', { class: 'pqv-pop-item' }, cb,
        h('span', { class: 'pqv-pop-name', text: level === '' ? '(empty)' : level }),
        h('span', { class: 'pqv-pop-count', text: col.counts[code].toLocaleString() }))
      items.push({ cb, code, row, level, lower: level.toLowerCase() })
      list.append(row)
    })
    const commit = () => {
      const set = new Set()
      for (const it of items) if (it.cb.checked) set.add(it.code)
      spec.codes = set.size === items.length ? null : set
      onChange()
    }
    list.addEventListener('change', commit)
    const setAll = (checked) => {
      for (const it of items) if (!it.row.hidden) it.cb.checked = checked
      commit()
    }
    const onlyShown = () => {
      for (const it of items) it.cb.checked = !it.row.hidden
      commit()
    }

    const search = h('input', {
      class: 'pqv-input', type: 'text', placeholder: 'Find value', 'aria-label': 'Find value',
      spellcheck: 'false', autocomplete: 'off',
    })
    const regex = h('button', {
      class: 'pqv-toggle pqv-toggle-sm', type: 'button', text: '.*', 'aria-pressed': 'false',
      title: 'Treat the text as a regular expression',
    })
    const shown = h('span', { class: 'pqv-pop-shown' })
    const applyFind = () => {
      const q = search.value
      let test = null
      search.classList.remove('pqv-bad')
      search.title = ''
      if (q) {
        if (regex.getAttribute('aria-pressed') === 'true') {
          const { re, error } = compileRegex(q, false)
          if (re) test = (it) => re.test(it.level)
          else {
            search.classList.add('pqv-bad')
            search.title = `Invalid regular expression: ${error}`
          }
        } else {
          const lq = q.toLowerCase()
          test = (it) => it.lower.includes(lq)
        }
      }
      let k = 0
      for (const it of items) {
        it.row.hidden = !!test && !test(it)
        if (!it.row.hidden) k++
      }
      shown.textContent = test ? `${k} shown` : ''
      onlyBtn.hidden = !test
    }
    search.addEventListener('input', applyFind)
    regex.addEventListener('click', () => {
      regex.setAttribute('aria-pressed', String(regex.getAttribute('aria-pressed') !== 'true'))
      applyFind()
      search.focus()
    })
    const onlyBtn = h('button', {
      class: 'pqv-link', type: 'button', text: 'Only these', hidden: true,
      title: 'Check the values shown and uncheck the rest', onclick: onlyShown,
    })
    const top = h('div', { class: 'pqv-pop-top' },
      h('div', { class: 'pqv-pop-find' }, search, regex),
      h('div', { class: 'pqv-pop-actions' },
        h('button', { class: 'pqv-link', type: 'button', text: 'All', onclick: () => setAll(true) }),
        h('button', { class: 'pqv-link', type: 'button', text: 'None', onclick: () => setAll(false) }),
        onlyBtn, shown))
    const el = h('div', { class: 'pqv-pop', role: 'dialog', 'aria-label': `${col.name} values` }, top, list)
    this.openPop(anchor, el, search)
  }

  // ---- body -------------------------------------------------------------

  /** One pooled row: the pinned part (row number and pinned columns) and the scrolling part. */
  makeRow(c0, c1, r) {
    const el = h('div', { class: 'pqv-row' })
    const pel = h('div', { class: 'pqv-row' })
    el._r = r
    pel._r = r
    const cells = []
    this.makeCells(pel, 0, this.pinCount, cells)
    this.makeCells(el, c0, c1, cells)
    return { el, pel, cells, alt: false, cur: false }
  }

  makeCells(el, c0, c1, cells) {
    for (let c = c0; c <= c1; c++) {
      const col = c === 0 ? null : this.cols[c - 1]
      let cls = 'pqv-cell'
      if (!col) cls += ' pqv-rownum'
      else if (col.type === 'number') cls += ' pqv-num'
      else if (col.marker) cls += ' pqv-markcell'
      const cell = h('div', { class: cls })
      cell.style.width = this.lefts[c + 1] - this.lefts[c] + 'px'
      const text = document.createTextNode('')
      cell.append(text)
      el.append(cell)
      if (col && col.marker) cell._col = col
      const fmt = col && col.type === 'number' && this.opts.getFormat ? this.opts.getFormat(col.name) : null
      cells.push({ cell, text, col, fmt, na: false, mark: !!(col && col.marker) })
    }
  }

  render() {
    this.raf = 0
    const { scroller, view, cols, lefts } = this
    const n = view.length

    if (!cols.length) {
      this.empty.textContent = 'Select one or more columns to view the data.'
      this.empty.hidden = false
    } else if (!n) {
      this.empty.textContent = 'No rows match the current filters.'
      this.empty.hidden = false
    } else {
      this.empty.hidden = true
    }

    const headH = this.head.offsetHeight
    this.empty.style.top = headH + 'px'
    const viewH = Math.max(0, scroller.clientHeight - headH)
    const rowH = this.rowHeight()
    const total = n * rowH
    const virt = Math.min(total, MAX_SCROLL_H)
    if (this.virt !== virt) {
      this.canvas.style.height = virt + 'px'
      this.virt = virt
    }

    const st = scroller.scrollTop
    let top = st
    if (total > virt && virt > viewH) top = (st / (virt - viewH)) * (total - viewH)
    const first = Math.max(0, Math.floor(top / rowH) - OVERSCAN)
    const last = cols.length ? Math.min(n, Math.ceil((top + viewH) / rowH) + OVERSCAN) : 0

    // Visible column window. Layout column 0 is the row number; it and the
    // pinned columns (1..pinCount) are drawn on the pinned layer.
    const x0 = scroller.scrollLeft
    const x1 = x0 + scroller.clientWidth
    const ncol = lefts.length - 1
    const P = this.pinCount + 1
    const pinW = lefts[P]
    let c0 = ncol
    let c1 = ncol - 1
    if (P < ncol) {
      c0 = P
      while (c0 < ncol - 1 && lefts[c0 + 1] <= x0 + pinW) c0++
      c1 = c0
      while (c1 < ncol - 1 && lefts[c1 + 1] < x1) c1++
      c0 = Math.max(P, c0 - 1)
      c1 = Math.min(ncol - 1, c1 + 1)
    }

    const key = `${c0}:${c1}:${this.layoutVersion}`
    if (key !== this.cellKey) {
      this.rowsEl.textContent = ''
      this.pinEl.textContent = ''
      this.pool = []
      this.hoverRow = null
      this.cellKey = key
      this.rowsEl.style.width = Math.max(0, lefts[c1 + 1] - lefts[c0]) + 'px'
      this.pinEl.style.width = pinW + 'px'
    }
    const y = st - (top - first * rowH)
    this.rowsEl.style.transform = `translate(${lefts[c0]}px, ${y}px)`
    this.pinEl.style.transform = `translate(${x0}px, ${y}px)`
    this.pinEl.classList.toggle('pqv-pinshadow', x0 > 0)
    this.head.classList.toggle('pqv-pinshadow', x0 > 0)

    const want = Math.max(0, last - first)
    const pool = this.pool
    while (pool.length < want) {
      const row = this.makeRow(c0, c1, pool.length)
      pool.push(row)
      this.rowsEl.append(row.el)
      this.pinEl.append(row.pel)
    }
    while (pool.length > want) {
      const row = pool.pop()
      if (row === this.hoverRow) this.hoverRow = null
      row.el.remove()
      row.pel.remove()
    }

    for (let r = 0; r < want; r++) {
      const row = pool[r]
      const ri = first + r
      const i = view[ri]
      const alt = (ri & 1) === 1
      if (row.alt !== alt) {
        row.el.classList.toggle('pqv-alt', alt)
        row.pel.classList.toggle('pqv-alt', alt)
        row.alt = alt
      }
      const cur = i === this.current
      if (row.cur !== cur) {
        row.el.classList.toggle('pqv-current', cur)
        row.pel.classList.toggle('pqv-current', cur)
        row.cur = cur
      }
      row.el._i = i
      row.pel._i = i
      const cells = row.cells
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k]
        if (!c.col) {
          c.text.nodeValue = String(i + 1)
          continue
        }
        if (c.mark) c.cell._row = i
        const t = c.fmt ? this.displayCell(c.col, i, c.fmt) : cellText(c.col, i)
        const na = t === null
        if (c.na !== na) {
          c.cell.classList.toggle('pqv-isna', na)
          c.na = na
        }
        c.text.nodeValue = na ? (c.mark ? '' : 'NA') : t
      }
    }
  }
}
