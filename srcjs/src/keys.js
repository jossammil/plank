// Keyboard shortcuts: which key does what, when a key press is ordinary typing,
// and the help sheet that lists them.

import { h } from './dom.js'

/** Single keys that jump to a tool, active while focus is not in a text box. */
export const SHORTCUTS = [
  ['palette', 'Ctrl/⌘ K', 'Command palette: run any action or go to a column'],
  ['search', '/', 'Search the visible columns'],
  ['where', 'W', 'WHERE query'],
  ['columns', 'C', 'Find a column in the column list'],
  ['counts', 'K', 'Counts panel'],
  ['export', 'E', 'Export'],
  ['views', 'V', 'Views'],
  ['appearance', 'A', 'Appearance'],
  ['minimal', 'M', 'Minimal view: just the table'],
  ['open', 'O', 'Open a file as a new tab'],
  ['goto', 'G', 'Go to a row'],
  ['help', '?', 'Keyboard shortcuts'],
]

/** Keys of the table itself (focus on the table). */
export const GRID_KEYS = [
  ['Arrows', 'Move the cell cursor'],
  ['Shift + arrows, click or drag', 'Select a block of cells'],
  ['Ctrl/⌘ + arrows, Home, End', 'Jump to the edges'],
  ['Page Up, Page Down', 'Move by a screen'],
  ['Tab, Shift+Tab', 'Next or previous cell'],
  ['Ctrl/⌘ A', 'Select every shown cell'],
  ['Ctrl/⌘ C', 'Copy the selection (with Shift: and the column names)'],
  ['Enter', 'Row details'],
  ['Esc', 'Close a panel, or clear the selection'],
  ['Ctrl/⌘ Z, Shift+Ctrl/⌘ Z', 'Undo, redo'],
]

const KEY_OF = { '/': 'search', w: 'where', c: 'columns', k: 'counts', e: 'export', v: 'views', a: 'appearance', m: 'minimal', o: 'open', g: 'goto', '?': 'help', ':': 'palette' }

/** The key that triggers a shortcut, for button tooltips ("Export (E)"). */
export const keyHint = (name) => {
  const s = SHORTCUTS.find((x) => x[0] === name)
  return s ? s[1] : ''
}

/** True when the key press belongs to a text box (shortcuts stay out of the way). */
export function isTyping(t) {
  if (!t) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(t.type)
  return false
}

/** The shortcut a key press asks for, or null. */
export function shortcutFor(e) {
  if (e.altKey || e.repeat) return null
  if (e.ctrlKey || e.metaKey) return !e.shiftKey && (e.key === 'k' || e.key === 'K') ? 'palette' : null
  return KEY_OF[e.key] || null
}

/** The help sheet: the shortcuts and the table's own keys. */
export function helpSheet() {
  const table = (rows) => h('table', { class: 'pqv-keys-table' },
    h('tbody', null, rows.map(([key, what]) => h('tr', null,
      h('td', null, h('kbd', { text: key })),
      h('td', { text: what })))))
  return h('div', { class: 'pqv-pop pqv-keys', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('div', { class: 'pqv-pop-title', text: 'Keyboard shortcuts' }),
    h('div', { class: 'pqv-keys-body' },
      h('div', { class: 'pqv-keys-head', text: 'Anywhere in the viewer' }),
      table(SHORTCUTS.map((s) => [s[1], s[2]])),
      h('div', { class: 'pqv-keys-head', text: 'In the table' }),
      table(GRID_KEYS)),
    h('div', { class: 'pqv-pop-foot pqv-opt-note', text: 'Single-letter keys work when the cursor is not in a text box.' }))
}
