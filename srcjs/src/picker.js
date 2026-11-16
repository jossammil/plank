// Column picker: a searchable checklist of every column in the file, with a
// type tag, summary stats and a small distribution chart that fill in as
// columns are decoded. Selected columns are listed first, in table order,
// and can be dragged (or moved with Alt+Up/Down) to reorder the table.

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
   */
  constructor(host, opts) {
    this.opts = opts
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
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      const name = e.target && e.target.dataset && e.target.dataset.name
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

    for (const f of opts.fields) this.addItem(f)

    host.append(
      h('div', { class: 'pqv-ptop' },
        this.search,
        h('div', { class: 'pqv-pactions' },
          this.count,
          h('button', { class: 'pqv-link', type: 'button', text: 'All', onclick: () => this.setAll(true) }),
          h('button', { class: 'pqv-link', type: 'button', text: 'None', onclick: () => this.setAll(false) }))),
      this.list)
    this.place()
  }

  addItem(f) {
    const cb = h('input', { type: 'checkbox' })
    cb.dataset.name = f.name
    const tag = h('span', { class: 'pqv-tag', text: f.tag })
    const nameEl = h('span', { class: 'pqv-pname', text: f.name })
    const stats = h('div', { class: 'pqv-pstats', text: f.label || '' })
    const chart = h('div', { class: 'pqv-pchart' })
    // A click on the grip must not toggle the checkbox of its label.
    const grip = h('span', {
      class: 'pqv-grip', draggable: 'false', title: 'Drag to reorder (or Alt+Up/Down)',
      onclick: (e) => e.preventDefault(),
    })
    grip.innerHTML = GRIP
    const row = h('label', { class: 'pqv-pitem', title: f.label ? `${f.name}: ${f.label}` : f.name },
      grip,
      cb,
      h('div', { class: 'pqv-pmain' },
        h('div', { class: 'pqv-pline' }, nameEl, tag),
        stats,
        chart))
    row.dataset.name = f.name
    const it = { cb, tag, nameEl, stats, chart, row, grip, label: f.label || '', done: false }
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
    it.nameEl.textContent = to
    it.row.title = to
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

  /** Names of items currently listed (not hidden by the search). */
  listedNames() {
    const out = []
    for (const [name, it] of this.items) if (!it.row.hidden) out.push(name)
    return out
  }

  // Reordering uses pointer events rather than native drag-and-drop, so it
  // behaves the same in every browser and on touch screens.
  setupDrag() {
    let drag = null
    const clear = () => {
      if (drag && drag.mark) drag.mark.classList.remove('pqv-drop-before', 'pqv-drop-after')
      if (drag) drag.mark = null
    }
    const target = (y) => {
      const rows = Array.from(this.selList.children).filter((r) => !r.hidden)
      for (const r of rows) {
        const rect = r.getBoundingClientRect()
        if (y < rect.top + rect.height / 2) return { row: r, after: false }
      }
      const last = rows[rows.length - 1]
      return last ? { row: last, after: true } : null
    }
    const move = (e) => {
      if (!drag) return
      e.preventDefault()
      // Scroll the list when the pointer nears its top or bottom edge.
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
      const { name, row, t } = drag
      clear()
      row.classList.remove('pqv-dragging')
      try { row.querySelector('.pqv-grip').releasePointerCapture(e.pointerId) } catch { /* already released */ }
      drag = null
      if (!commit || !t || t.row === row) return
      this.order.splice(this.order.indexOf(name), 1)
      let k = this.order.indexOf(t.row.dataset.name)
      if (t.after) k++
      this.order.splice(k, 0, name)
      this.place()
      this.emit()
    }
    this.list.addEventListener('pointerdown', (e) => {
      const grip = e.button === 0 && e.target.closest && e.target.closest('.pqv-grip')
      const row = grip && grip.closest('.pqv-pitem')
      if (!row || row.parentElement !== this.selList) return
      e.preventDefault()
      drag = { name: row.dataset.name, row, t: null, mark: null }
      row.classList.add('pqv-dragging')
      try { grip.setPointerCapture(e.pointerId) } catch { /* optional */ }
    })
    // WebKit still sends mousedown after a cancelled pointerdown; its default
    // action would start a native drag and swallow the pointer events.
    this.list.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.pqv-grip')) e.preventDefault()
    })
    // Stop the browser from starting its own drag (of the label or icon).
    this.list.addEventListener('dragstart', (e) => {
      if (drag || (e.target.closest && e.target.closest('.pqv-grip'))) e.preventDefault()
    })
    this.list.addEventListener('pointermove', move)
    this.list.addEventListener('pointerup', (e) => end(e, true))
    this.list.addEventListener('pointercancel', (e) => end(e, false))
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
