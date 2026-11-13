// Column picker: a searchable checklist of every column in the file, with a
// type tag and summary stats that fill in as columns are decoded.

import { h } from './dom.js'
import { typeTag, columnStats } from './store.js'

export class Picker {
  /**
   * @param {HTMLElement} host
   * @param {object} opts
   * @param {{name: string, tag: string, label: string|null}[]} opts.fields
   * @param {number} opts.n total rows
   * @param {(names: string[]) => void} opts.onChange called with selected names in file order
   */
  constructor(host, opts) {
    this.opts = opts
    this.items = new Map()
    this.count = h('span', { class: 'pqv-pcount' })
    this.search = h('input', {
      class: 'pqv-input', type: 'text', placeholder: 'Find column', 'aria-label': 'Find column',
      spellcheck: 'false', autocomplete: 'off',
    })
    this.search.addEventListener('input', () => this.applySearch())
    this.list = h('div', { class: 'pqv-plist' })
    this.list.addEventListener('change', () => this.emit())

    for (const f of opts.fields) {
      const cb = h('input', { type: 'checkbox' })
      const tag = h('span', { class: 'pqv-tag', text: f.tag })
      const stats = h('div', { class: 'pqv-pstats', text: f.label || '' })
      const row = h('label', { class: 'pqv-pitem', title: f.label ? `${f.name}: ${f.label}` : f.name },
        cb,
        h('div', { class: 'pqv-pmain' },
          h('div', { class: 'pqv-pline' }, h('span', { class: 'pqv-pname', text: f.name }), tag),
          stats))
      this.items.set(f.name, {
        cb, tag, stats, row,
        lower: (f.name + ' ' + (f.label || '')).toLowerCase(),
      })
      this.list.append(row)
    }

    host.append(
      h('div', { class: 'pqv-ptop' },
        this.search,
        h('div', { class: 'pqv-pactions' },
          this.count,
          h('button', { class: 'pqv-link', type: 'button', text: 'All', onclick: () => this.setAll(true) }),
          h('button', { class: 'pqv-link', type: 'button', text: 'None', onclick: () => this.setAll(false) }))),
      this.list)
    this.updateCount()
  }

  selected() {
    const out = []
    for (const [name, it] of this.items) if (it.cb.checked) out.push(name)
    return out
  }

  setSelected(names) {
    const set = new Set(names)
    for (const [name, it] of this.items) it.cb.checked = set.has(name)
    this.updateCount()
  }

  setAll(checked) {
    for (const it of this.items.values()) if (!it.row.hidden) it.cb.checked = checked
    this.emit()
  }

  emit() {
    this.updateCount()
    this.opts.onChange(this.selected())
  }

  updateCount() {
    let k = 0
    for (const it of this.items.values()) if (it.cb.checked) k++
    this.count.textContent = `${k} of ${this.items.size} selected`
  }

  applySearch() {
    const q = this.search.value.trim().toLowerCase()
    for (const it of this.items.values()) it.row.hidden = !!q && !it.lower.includes(q)
  }

  /** Fill in the type tag and summary stats once a column has been decoded. */
  updateStats(col) {
    const it = this.items.get(col.name)
    if (!it || it.done) return
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
}
