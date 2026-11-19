// The command palette (Ctrl/⌘+K): type to find any action, column, view or
// theme, then Enter to run it.

import { h } from './dom.js'

const WORD_START = /[\s:_.\-/(]/

/**
 * How well `query` matches `text`: higher is better, -1 for no match. A
 * substring scores highest (earlier and at a word start is better); otherwise
 * the query's letters must appear in order, and runs and word starts count.
 */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) return 1000 - at * 2 - (t.length - q.length) * 0.1 + (at === 0 || WORD_START.test(t[at - 1]) ? 200 : 0)
  let from = 0
  let prev = -2
  let score = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const j = t.indexOf(ch, from)
    if (j < 0) return -1
    score += j === prev + 1 ? 8 : 1
    if (j === 0 || WORD_START.test(t[j - 1])) score += 6
    prev = j
    from = j + 1
  }
  return score - t.length * 0.05
}

/** Items matching `query`, best first; without a query, in their given order. */
export function rankItems(items, query, limit = 60) {
  if (!query.trim()) return items.slice(0, limit)
  const scored = []
  for (const it of items) {
    const s = fuzzyScore(query, it.label)
    if (s >= 0) scored.push([s, it])
  }
  scored.sort((a, b) => b[0] - a[0])
  return scored.slice(0, limit).map((x) => x[1])
}

let uid = 0

/**
 * Opens the palette over `root`.
 * @param {HTMLElement} root widget root
 * @param {() => {label: string, group?: string, hint?: string, run: () => void}[]} getItems
 * @param {object} [opts]
 * @param {(query: string) => object[]} [opts.extra] items computed from the query (e.g. "Go to row 120")
 * @param {() => void} [opts.onClose]
 */
export function openPalette(root, getItems, opts = {}) {
  const items = getItems()
  const id = 'pqv-pal-' + ++uid
  const input = h('input', {
    class: 'pqv-input pqv-palette-input', type: 'text', placeholder: 'Type an action, a column or a view…',
    'aria-label': 'Command', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': id,
    'aria-autocomplete': 'list', spellcheck: 'false', autocomplete: 'off',
  })
  const list = h('div', { class: 'pqv-palette-list', role: 'listbox', id, 'aria-label': 'Commands' })
  const empty = h('div', { class: 'pqv-palette-empty', text: 'Nothing matches.', hidden: true })
  const box = h('div', { class: 'pqv-palette', role: 'dialog', 'aria-label': 'Command palette' }, input, list, empty)
  const back = document.activeElement
  let shown = []
  let sel = 0

  const render = () => {
    const q = input.value
    shown = (opts.extra ? opts.extra(q) : []).concat(rankItems(items, q))
    sel = Math.min(sel, Math.max(0, shown.length - 1))
    list.textContent = ''
    shown.forEach((it, k) => {
      const row = h('div', {
        class: 'pqv-palette-item', role: 'option', id: `${id}-${k}`, 'aria-selected': String(k === sel),
      },
      h('span', { class: 'pqv-palette-label', text: it.label }),
      it.hint ? h('kbd', { class: 'pqv-palette-hint', text: it.hint }) : null,
      it.group ? h('span', { class: 'pqv-palette-group', text: it.group }) : null)
      row.addEventListener('pointerdown', (e) => e.preventDefault()) // keep focus in the box
      row.addEventListener('click', () => run(k))
      list.append(row)
    })
    empty.hidden = shown.length > 0
    if (shown.length) input.setAttribute('aria-activedescendant', `${id}-${sel}`)
    else input.removeAttribute('aria-activedescendant')
  }
  const move = (d) => {
    if (!shown.length) return
    sel = (sel + d + shown.length) % shown.length
    for (const row of list.children) row.setAttribute('aria-selected', String(row.id === `${id}-${sel}`))
    input.setAttribute('aria-activedescendant', `${id}-${sel}`)
    const row = list.children[sel]
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
  }
  const close = (restore = true) => {
    if (!box.isConnected) return
    box.remove()
    document.removeEventListener('pointerdown', onDown, true)
    if (restore && back && back.focus && back.isConnected) back.focus()
    if (opts.onClose) opts.onClose()
  }
  const run = (k) => {
    const it = shown[k]
    if (!it) return
    // Close first, so whatever the action opens is not closed with the palette.
    close(true)
    it.run()
  }
  const onDown = (e) => {
    if (!box.contains(e.target)) close(false)
  }
  input.addEventListener('input', () => {
    sel = 0
    render()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'PageDown') move(Math.min(8, shown.length - 1 - sel) || 0)
    else if (e.key === 'PageUp') move(-Math.min(8, sel) || 0)
    else if (e.key === 'Enter') run(sel)
    else if (e.key === 'Escape') close(true)
    else return
    e.preventDefault()
    e.stopPropagation()
  })
  document.addEventListener('pointerdown', onDown, true)
  root.append(box)
  render()
  input.focus()
  return { el: box, close }
}
