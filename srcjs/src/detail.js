// The row detail panel: every column of one row, shown or not, with
// previous / next through the filtered rows.

import { h } from './dom.js'
import { cellText, typeTag } from './store.js'

/** Full-precision text for one value, or null when missing. */
export function detailText(col, i) {
  if (col.error || col.isNull[i]) return null
  if (col.type === 'number') {
    const v = col.num[i]
    if (v === Infinity) return 'Inf'
    if (v === -Infinity) return '-Inf'
    return String(v)
  }
  return cellText(col, i)
}

export class RowDetail {
  /**
   * @param {HTMLElement} host
   * @param {object} opts
   * @param {() => {name: string, tag: string}[]} opts.fields every column, markers last
   * @param {() => string[]} opts.tableNames columns in the table, in order
   * @param {(name: string) => object|undefined} opts.peekCol decoded column, if read yet
   * @param {(name: string) => Promise<object>} opts.getCol decode a column
   * @param {() => Uint32Array} opts.getView
   * @param {(i: number, pos: number, reveal: boolean) => void} opts.onRow row shown (pos: place in the
   *   view, -1 if filtered out; reveal: scroll the table to it)
   * @param {() => void} opts.onClose
   * @param {(text: string) => Promise<boolean>} opts.copyText
   * @param {number} [opts.width] remembered width
   * @param {(px: number) => void} [opts.onWidth]
   */
  constructor(host, opts) {
    this.opts = opts
    this.el = host
    this.el.tabIndex = -1
    this.row = -1
    this.pos = -1
    this.token = 0
    this.entries = []
    if (opts.width) this.el.style.width = opts.width + 'px'

    this.title = h('div', { class: 'pqv-detail-title' })
    this.where = h('div', { class: 'pqv-detail-where' })
    const btn = (text, title, label) => h('button', { class: 'pqv-btn pqv-btn-sm pqv-icon-sm', type: 'button', text, title, 'aria-label': label || title })
    this.prevBtn = btn('‹', 'Previous row (↑)', 'Previous row')
    this.nextBtn = btn('›', 'Next row (↓)', 'Next row')
    this.copyBtn = h('button', { class: 'pqv-btn pqv-btn-sm', type: 'button', text: 'Copy', title: 'Copy every column of this row as tab-separated name and value lines' })
    this.closeBtn = btn('×', 'Close the row panel (Esc)', 'Close the row panel')
    this.find = h('input', {
      class: 'pqv-input', type: 'search', placeholder: 'Find column', 'aria-label': 'Find column in this row',
      spellcheck: 'false', autocomplete: 'off',
    })
    this.list = h('div', { class: 'pqv-detail-list' })
    const resizer = h('div', { class: 'pqv-detail-resizer', title: 'Drag to resize' })
    this.el.append(
      resizer,
      h('div', { class: 'pqv-detail-head' },
        h('div', { class: 'pqv-detail-heading' }, this.title, this.where),
        h('div', { class: 'pqv-detail-tools' }, this.prevBtn, this.nextBtn, this.copyBtn, this.closeBtn)),
      h('div', { class: 'pqv-detail-find' }, this.find),
      this.list)

    this.prevBtn.addEventListener('click', () => this.step(-1))
    this.nextBtn.addEventListener('click', () => this.step(1))
    this.closeBtn.addEventListener('click', () => opts.onClose())
    this.copyBtn.addEventListener('click', async () => {
      const ok = await opts.copyText(await this.copyTextFor(this.row))
      this.copyBtn.textContent = ok ? 'Copied' : 'Copy failed'
      setTimeout(() => { this.copyBtn.textContent = 'Copy' }, 1500)
    })
    this.find.addEventListener('input', () => this.applyFind())
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        opts.onClose()
        return
      }
      if (e.target === this.find || e.altKey || e.metaKey || e.ctrlKey) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        this.step(e.key === 'ArrowDown' ? 1 : -1)
      }
    })
    resizer.addEventListener('pointerdown', (e) => this.startResize(e))
  }

  get isOpen() {
    return !this.el.hidden
  }

  /** Show row i (0-based index in the data). */
  show(i, focus = false) {
    this.el.hidden = false
    this.row = i
    this.render(true)
    if (focus) this.el.focus({ preventScroll: true })
  }

  close() {
    this.el.hidden = true
    this.row = -1
    this.token++
  }

  step(d) {
    const view = this.opts.getView()
    if (this.pos < 0) return
    const pos = this.pos + d
    if (pos < 0 || pos >= view.length) return
    this.show(view[pos])
  }

  /** The rows or columns changed: update the place in the view and the values. */
  refresh() {
    if (this.isOpen && this.row >= 0) this.render(false)
  }

  render(reveal) {
    const i = this.row
    const view = this.opts.getView()
    this.pos = view.indexOf(i)
    this.title.textContent = `Row ${(i + 1).toLocaleString()}`
    this.where.textContent = this.pos < 0
      ? 'Not in the filtered rows'
      : `${(this.pos + 1).toLocaleString()} of ${view.length.toLocaleString()} shown`
    this.prevBtn.disabled = this.pos <= 0
    this.nextBtn.disabled = this.pos < 0 || this.pos >= view.length - 1
    this.opts.onRow(i, this.pos, reveal)

    const token = ++this.token
    const inTable = this.opts.tableNames()
    const shown = new Set(inTable)
    const fields = this.opts.fields()
    const tags = new Map(fields.map((f) => [f.name, f.tag]))
    const others = fields.map((f) => f.name).filter((name) => !shown.has(name))
    const scroll = this.list.scrollTop
    this.list.textContent = ''
    this.entries = []
    const pending = []
    const group = (title, names) => {
      if (!names.length) return
      const head = h('div', { class: 'pqv-detail-group', text: title })
      this.list.append(head)
      const items = []
      for (const name of names) {
        const col = this.opts.peekCol(name)
        const value = h('div', { class: 'pqv-detail-value' })
        const label = h('div', { class: 'pqv-detail-name', title: name },
          h('span', { class: 'pqv-detail-cname', text: name }),
          h('span', { class: 'pqv-tag', text: col ? typeTag(col) : tags.get(name) || '' }))
        const item = h('div', { class: 'pqv-detail-item' }, label, value)
        this.list.append(item)
        const entry = { name, item, value, label, lower: name.toLowerCase(), head }
        items.push(entry)
        this.entries.push(entry)
        if (col) this.fill(entry, col, i)
        else {
          value.textContent = '…'
          value.classList.add('pqv-isna')
          pending.push(entry)
        }
      }
      head._items = items
    }
    group('In the table', inTable)
    group('Other columns', others)
    this.applyFind()
    this.list.scrollTop = scroll
    // Columns not read yet are read one by one, unless the row changes.
    const next = async () => {
      const entry = pending.shift()
      if (!entry || token !== this.token) return
      const col = await this.opts.getCol(entry.name)
      if (token !== this.token) return
      this.fill(entry, col, i)
      next()
    }
    next()
  }

  fill(entry, col, i) {
    const text = col.error ? `(could not be decoded: ${col.error})` : detailText(col, i)
    entry.value.textContent = text === null ? 'NA' : text === '' ? '(empty)' : text
    entry.value.classList.toggle('pqv-isna', text === null || text === '' || !!col.error)
    entry.label.lastChild.textContent = typeTag(col)
    if (col.label) entry.label.title = `${col.name}: ${col.label}`
  }

  applyFind() {
    const q = this.find.value.trim().toLowerCase()
    const heads = new Set()
    for (const e of this.entries) {
      e.item.hidden = !!q && !e.lower.includes(q)
      heads.add(e.head)
    }
    for (const head of heads) head.hidden = head._items.every((e) => e.item.hidden)
  }

  async copyTextFor(i) {
    const lines = []
    for (const f of this.opts.fields()) {
      const col = await this.opts.getCol(f.name)
      const text = detailText(col, i)
      lines.push(`${f.name}\t${text === null ? 'NA' : text.replace(/[\t\r\n]+/g, ' ')}`)
    }
    return lines.join('\r\n') + '\r\n'
  }

  startResize(e) {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = this.el.offsetWidth
    let px = w0
    const move = (ev) => {
      px = Math.max(220, Math.min(900, Math.round(w0 - (ev.clientX - x0))))
      this.el.style.width = px + 'px'
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (this.opts.onWidth) this.opts.onWidth(px)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
}
