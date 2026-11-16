// Column picker: a searchable list of every column in the file, with a type
// tag, summary stats and a small distribution chart that fill in as columns
// are decoded. Only the checkbox adds or removes a column. Clicking the rest
// of an item opens its details; dragging an item reorders the table (or adds
// the column at that place). Selected columns are listed first, in table
// order. The panel can be resized from its right edge.

import { h } from './dom.js'
import { typeTag, columnStats } from './store.js'

const GRIP = '<svg viewBox="0 0 8 14" width="8" height="14" aria-hidden="true" focusable="false">'
  + '<g fill="currentColor"><circle cx="2" cy="3" r="1.1"/><circle cx="6" cy="3" r="1.1"/>'
  + '<circle cx="2" cy="7" r="1.1"/><circle cx="6" cy="7" r="1.1"/>'
  + '<circle cx="2" cy="11" r="1.1"/><circle cx="6" cy="11" r="1.1"/></g></svg>'

export class Picker {
  /**
   * @param {HTMLElement} host
   * @param {object} opts
   * @param {{name: string, tag: string, label: string|null}[]} opts.fields
   * @param {number} opts.n total rows
   * @param {(names: string[]) => void} opts.onChange called with selected names in table order
   * @param {(name: string, el: HTMLElement) => void} [opts.onDetail] fill an item's detail panel
   * @param {HTMLElement} [opts.root] element that hosts the chart tooltip
   * @param {number} [opts.width] starting panel width in pixels
   * @param {(width: number) => void} [opts.onWidth] called after the user resizes the panel
   */
  constructor(host, opts) {
    this.opts = opts
    this.host = host
    this.items = new Map()
    this.fileOrder = []
    this.order = []
    this.count = h('span', { class: 'pqv-pcount' })
    this.search = h('input', {
      class: 'pqv-input', type: 'text', placeholder: 'Find column', 'aria-label': 'Find column',
      spellcheck: 'false', autocomplete: 'off',
    })
    this.search.addEventListener('input', () => this.applySearch())

    this.selHead = h('div', { class: 'pqv-pgroup' })
    this.selList = h('div', { class: 'pqv-pgroup-list pqv-psel' })
    this.otherHead = h('div', { class: 'pqv-pgroup' })
    this.otherList = h('div', { class: 'pqv-pgroup-list' })
    this.list = h('div', { class: 'pqv-plist' }, this.selHead, this.selList, this.otherHead, this.otherList)
    this.list.addEventListener('change', (e) => {
      const name = e.target && e.target.dataset && e.target.dataset.name
      if (name === undefined) return
      this.toggle(name, e.target.checked)
      this.emit()
    })
    this.list.addEventListener('keydown', (e) => {
      const name0 = e.target && e.target.dataset && e.target.dataset.name
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('pqv-pmain')) {
        e.preventDefault()
        this.toggleDetail(name0)
        return
      }
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      const name = name0
      const k = this.order.indexOf(name)
      if (k < 0) return
      e.preventDefault()
      const to = e.key === 'ArrowUp' ? k - 1 : k + 1
      if (to < 0 || to >= this.order.length) return
      this.order.splice(k, 1)
      this.order.splice(to, 0, name)
      this.place()
      e.target.focus()
      this.emit()
    })
    this.setupDrag()
    this.setupTips()

    for (const f of opts.fields) this.addItem(f)

    host.append(
      h('div', { class: 'pqv-ptop' },
        this.search,
        h('div', { class: 'pqv-pactions' },
          this.count,
          h('button', { class: 'pqv-link', type: 'button', text: 'All', onclick: () => this.setAll(true) }),
          h('button', { class: 'pqv-link', type: 'button', text: 'None', onclick: () => this.setAll(false) }))),
      this.list)

    // Resize from the right edge; double-click (or the button) toggles wide.
    this.widthBtn = h('button', {
      class: 'pqv-link pqv-pwide', type: 'button', text: 'Wider', title: 'Make the column list wider',
      onclick: () => this.setWidth(this.width > 380 ? 270 : 480, true),
    })
    host.querySelector('.pqv-pactions').append(this.widthBtn)
    this.resizer = h('div', {
      class: 'pqv-presizer', role: 'separator', 'aria-orientation': 'vertical',
      title: 'Drag to resize the column list, double-click to widen or narrow it',
      onpointerdown: (e) => this.startResize(e),
      ondblclick: () => this.setWidth(this.width > 380 ? 270 : 480, true),
    })
    host.append(this.resizer)
    this.setWidth(opts.width || 270, false)
    this.place()
  }

  setWidth(w, save) {
    const root = this.opts.root
    const max = Math.max(260, Math.min(900, (root && root.clientWidth ? root.clientWidth : 1200) * 0.7))
    this.width = Math.round(Math.max(200, Math.min(max, w)))
    this.host.style.width = this.width + 'px'
    this.widthBtn.textContent = this.width > 380 ? 'Narrower' : 'Wider'
    this.widthBtn.title = this.width > 380 ? 'Make the column list narrower' : 'Make the column list wider'
    if (save && this.opts.onWidth) this.opts.onWidth(this.width)
  }

  startResize(e) {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = this.width
    this.resizer.classList.add('pqv-active')
    const move = (ev) => this.setWidth(w0 + ev.clientX - x0, false)
    const up = () => {
      this.resizer.classList.remove('pqv-active')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (this.opts.onWidth) this.opts.onWidth(this.width)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  addItem(f) {
    const cb = h('input', { type: 'checkbox' })
    cb.dataset.name = f.name
    const tag = h('span', { class: 'pqv-tag', text: f.tag })
    const nameEl = h('span', { class: 'pqv-pname', text: f.name })
    const stats = h('div', { class: 'pqv-pstats', text: f.label || '' })
    const chart = h('div', { class: 'pqv-pchart' })
    const detail = h('div', { class: 'pqv-pdetail', hidden: true })
    const grip = h('span', { class: 'pqv-grip', 'aria-hidden': 'true' })
    grip.innerHTML = GRIP
    const main = h('div', {
      class: 'pqv-pmain', tabindex: '0', role: 'button', 'aria-expanded': 'false',
      title: (f.label ? `${f.name}: ${f.label}\n` : '') + 'Click for details, drag to place in the table',
    },
    h('div', { class: 'pqv-pline' }, nameEl, tag),
    stats,
    chart)
    main.dataset.name = f.name
    const row = h('div', { class: 'pqv-pitem' },
      grip,
      h('label', { class: 'pqv-pcheck', title: 'Show this column in the table' }, cb),
      h('div', { class: 'pqv-pbody' }, main, detail))
    row.dataset.name = f.name
    const it = { cb, tag, nameEl, stats, chart, detail, main, row, grip, label: f.label || '', done: false, open: false }
    it.lower = (f.name + ' ' + it.label).toLowerCase()
    this.items.set(f.name, it)
    this.fileOrder.push(f.name)
    return it
  }

  /** Add a column created in the browser (a marker), selected unless told otherwise. */
  addField(f, select = true) {
    if (this.items.has(f.name)) return
    this.addItem(f)
    if (select) this.toggle(f.name, true)
    this.place()
    this.applySearch()
  }

  removeField(name) {
    const it = this.items.get(name)
    if (!it) return
    it.row.remove()
    this.items.delete(name)
    this.fileOrder = this.fileOrder.filter((x) => x !== name)
    this.order = this.order.filter((x) => x !== name)
    this.place()
  }

  renameField(from, to) {
    const it = this.items.get(from)
    if (!it || this.items.has(to)) return
    this.items.delete(from)
    this.items.set(to, it)
    it.cb.dataset.name = to
    it.row.dataset.name = to
    it.main.dataset.name = to
    it.nameEl.textContent = to
    it.main.title = 'Click for details, drag to place in the table'
    it.lower = (to + ' ' + it.label).toLowerCase()
    this.fileOrder = this.fileOrder.map((x) => (x === from ? to : x))
    this.order = this.order.map((x) => (x === from ? to : x))
  }

  selected() {
    return this.order.slice()
  }

  setSelected(names) {
    const seen = new Set()
    this.order = []
    for (const name of names) {
      if (this.items.has(name) && !seen.has(name)) {
        seen.add(name)
        this.order.push(name)
      }
    }
    this.place()
  }

  toggle(name, checked) {
    const k = this.order.indexOf(name)
    if (checked && k < 0) this.order.push(name)
    else if (!checked && k >= 0) this.order.splice(k, 1)
    this.placeOne(name)
  }

  setAll(checked) {
    for (const name of this.fileOrder) {
      const it = this.items.get(name)
      if (!it.row.hidden) {
        const k = this.order.indexOf(name)
        if (checked && k < 0) this.order.push(name)
        else if (!checked && k >= 0) this.order.splice(k, 1)
      }
    }
    this.place()
    this.emit()
  }

  emit() {
    this.updateCount()
    this.opts.onChange(this.selected())
  }

  /** Put every item in its group and position. */
  place() {
    const sel = new Set(this.order)
    for (const name of this.order) {
      const it = this.items.get(name)
      it.cb.checked = true
      this.selList.append(it.row)
    }
    for (const name of this.fileOrder) {
      if (sel.has(name)) continue
      const it = this.items.get(name)
      it.cb.checked = false
      this.otherList.append(it.row)
    }
    this.updateCount()
  }

  /**
   * Move one item after it was ticked or unticked. Only items above it move,
   * so ticking down the list keeps the next item under the pointer.
   */
  placeOne(name) {
    const it = this.items.get(name)
    if (this.order.includes(name)) {
      it.cb.checked = true
      this.selList.append(it.row)
    } else {
      it.cb.checked = false
      const sel = new Set(this.order)
      const k = this.fileOrder.indexOf(name)
      let before = null
      for (let j = k + 1; j < this.fileOrder.length; j++) {
        if (!sel.has(this.fileOrder[j])) {
          before = this.items.get(this.fileOrder[j]).row
          break
        }
      }
      this.otherList.insertBefore(it.row, before)
    }
    this.updateCount()
  }

  updateCount() {
    const k = this.order.length
    const total = this.items.size
    this.count.textContent = `${k} of ${total} selected`
    this.selHead.textContent = `In table (${k})`
    this.selHead.hidden = k === 0
    this.otherHead.textContent = k ? `Other columns (${total - k})` : ''
    this.otherHead.hidden = k === 0 || k === total
  }

  applySearch() {
    const q = this.search.value.trim().toLowerCase()
    for (const it of this.items.values()) it.row.hidden = !!q && !it.lower.includes(q)
  }

  /** Open or close an item's detail panel. */
  toggleDetail(name, open) {
    const it = this.items.get(name)
    if (!it) return
    it.open = open === undefined ? !it.open : open
    it.detail.hidden = !it.open
    it.row.classList.toggle('pqv-open', it.open)
    it.main.setAttribute('aria-expanded', String(it.open))
    if (it.open && this.opts.onDetail) this.opts.onDetail(name, it.detail)
  }

  /** Names of items whose details are open and listed. */
  openDetails() {
    const out = []
    for (const [name, it] of this.items) if (it.open && !it.row.hidden) out.push(name)
    return out
  }

  /** Names of items currently listed (not hidden by the search). */
  listedNames() {
    const out = []
    for (const [name, it] of this.items) if (!it.row.hidden) out.push(name)
    return out
  }

  // Dragging uses pointer events rather than native drag-and-drop, so it
  // behaves the same in every browser. A press that does not move is a click.
  setupDrag() {
    let drag = null
    const clear = () => {
      if (drag && drag.mark) drag.mark.classList.remove('pqv-drop-before', 'pqv-drop-after')
      if (drag) drag.mark = null
    }
    const target = (y) => {
      const rows = Array.from(this.selList.children).filter((r) => !r.hidden)
      const box = this.selList.getBoundingClientRect()
      // An unselected column can only be dropped into the "In table" group.
      if (!rows.length || y > box.bottom + 12) return null
      for (const r of rows) {
        const rect = r.getBoundingClientRect()
        if (y < rect.top + rect.height / 2) return { row: r, after: false }
      }
      return { row: rows[rows.length - 1], after: true }
    }
    const move = (e) => {
      if (!drag) return
      if (!drag.active) {
        if (Math.abs(e.clientY - drag.y0) + Math.abs(e.clientX - drag.x0) < 6) return
        drag.active = true
        drag.row.classList.add('pqv-dragging')
        this.list.classList.add('pqv-is-dragging')
        this.hideTip()
      }
      e.preventDefault()
      const lr = this.list.getBoundingClientRect()
      if (e.clientY < lr.top + 24) this.list.scrollTop -= 12
      else if (e.clientY > lr.bottom - 24) this.list.scrollTop += 12
      const t = target(e.clientY)
      clear()
      drag.t = t
      if (t && t.row !== drag.row) {
        drag.mark = t.row
        drag.mark.classList.add(t.after ? 'pqv-drop-after' : 'pqv-drop-before')
      }
    }
    const end = (e, commit) => {
      if (!drag) return
      const { name, row, t, active, el } = drag
      clear()
      row.classList.remove('pqv-dragging')
      this.list.classList.remove('pqv-is-dragging')
      try { el.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      drag = null
      if (!commit) return
      if (!active) {
        this.toggleDetail(name)
        return
      }
      if (!t || t.row === row) return
      const k0 = this.order.indexOf(name)
      if (k0 >= 0) this.order.splice(k0, 1)
      let k = this.order.indexOf(t.row.dataset.name)
      if (t.after) k++
      this.order.splice(k, 0, name)
      this.place()
      this.emit()
    }
    this.list.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.target.closest) return
      // The checkbox and the detail panel keep their normal behaviour.
      if (e.target.closest('.pqv-pcheck, .pqv-pdetail, input, button, a')) return
      const el = e.target.closest('.pqv-grip, .pqv-pmain')
      const row = el && el.closest('.pqv-pitem')
      if (!row) return
      e.preventDefault()
      drag = { name: row.dataset.name, row, el, t: null, mark: null, active: false, x0: e.clientX, y0: e.clientY }
      try { el.setPointerCapture(e.pointerId) } catch { /* optional */ }
    })
    // WebKit still sends mousedown after a cancelled pointerdown; its default
    // action would start a native drag and swallow the pointer events.
    this.list.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.pqv-grip, .pqv-pmain') && !e.target.closest('.pqv-pdetail')) e.preventDefault()
    })
    this.list.addEventListener('dragstart', (e) => {
      if (drag || (e.target.closest && e.target.closest('.pqv-grip, .pqv-pmain'))) e.preventDefault()
    })
    this.list.addEventListener('pointermove', move)
    this.list.addEventListener('pointerup', (e) => end(e, true))
    this.list.addEventListener('pointercancel', (e) => end(e, false))
  }

  // Instant tooltips for the chart bars (native SVG titles are slow and
  // unreliable inside a scrolling list).
  setupTips() {
    const root = this.opts.root
    if (!root) return
    this.tip = h('div', { class: 'pqv-tip', role: 'tooltip', hidden: true })
    root.append(this.tip)
    this.list.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || this.list.classList.contains('pqv-is-dragging')) return
      const g = e.target.closest && e.target.closest('[data-tip]')
      if (!g) {
        this.hideTip()
        return
      }
      const text = g.getAttribute('data-tip')
      if (this.tip.textContent !== text) this.tip.textContent = text
      this.tip.hidden = false
      const rr = root.getBoundingClientRect()
      const tw = this.tip.offsetWidth
      const th = this.tip.offsetHeight
      let x = e.clientX - rr.left + 12
      let y = e.clientY - rr.top - th - 10
      if (x + tw > rr.width - 4) x = Math.max(4, e.clientX - rr.left - tw - 12)
      if (y < 4) y = e.clientY - rr.top + 16
      this.tip.style.left = x + 'px'
      this.tip.style.top = y + 'px'
      if (this.tipBar && this.tipBar !== g) this.tipBar.classList.remove('pqv-hot')
      this.tipBar = g
      g.classList.add('pqv-hot')
    })
    this.list.addEventListener('pointerleave', () => this.hideTip())
    this.list.addEventListener('scroll', () => this.hideTip(), { passive: true })
  }

  hideTip() {
    if (this.tip) this.tip.hidden = true
    if (this.tipBar) this.tipBar.classList.remove('pqv-hot')
    this.tipBar = null
  }

  /** Fill in the type tag and summary stats once a column has been decoded. */
  updateStats(col, force = false) {
    const it = this.items.get(col.name)
    if (!it || (it.done && !force)) return
    it.done = true
    it.tag.textContent = typeTag(col)
    if (col.error) {
      it.stats.textContent = 'Could not decode this column'
      it.stats.title = col.error
      it.stats.classList.add('pqv-bad-text')
      return
    }
    const s = columnStats(col)
    const parts = [`${s.distinct.toLocaleString()} distinct`]
    if (s.missing) {
      const pct = (s.missing / this.opts.n) * 100
      parts.push(`${pct < 0.1 ? '<0.1' : pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% NA`)
    }
    if (s.min !== null) parts.push(s.min === s.max ? s.min : `${s.min} to ${s.max}`)
    it.stats.textContent = parts.join(' · ')
    if (col.label) it.stats.title = col.label
  }

  /** Has this column's chart been drawn? */
  hasChart(name) {
    const it = this.items.get(name)
    return !!it && it.chart.firstChild !== null
  }

  setChart(name, svg) {
    const it = this.items.get(name)
    if (it) it.chart.innerHTML = svg
  }
}
