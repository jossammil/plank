// Appearance: colour theme, accent colour, text colour, table font, text
// size and row spacing. The colours themselves live in pqview.css as token blocks; this
// module only picks which block applies and builds the settings window.

import { h } from './dom.js'

export const THEMES = [
  ['auto', 'Auto', 'Follows the system light or dark setting'],
  ['classic', 'Classic', 'Light and neutral'],
  ['modern', 'Modern', 'Crisp white, cool greys'],
  ['dark', 'Dark', 'Light text on dark grey'],
  ['vintage', 'Vintage', 'Sepia ink on cream paper'],
  ['terminal', 'Terminal', 'Green phosphor on black, all monospace'],
]
export const ACCENTS = [
  ['', 'Theme default'], ['blue', 'Blue'], ['teal', 'Teal'], ['green', 'Green'],
  ['amber', 'Amber'], ['red', 'Red'], ['purple', 'Purple'], ['pink', 'Pink'],
]
// Text colours: dark shades on light themes, light shades on dark ones.
export const INKS = [
  ['', 'Theme default'], ['contrast', 'High contrast'], ['slate', 'Slate'], ['navy', 'Navy'],
  ['green', 'Green'], ['amber', 'Amber'], ['plum', 'Plum'],
]
export const FONTS = [['mono', 'Mono'], ['sans', 'Sans'], ['serif', 'Serif']]
export const SIZES = [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']]
export const DENSITIES = [['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']]
export const APPEARANCE_KEYS = ['theme', 'accent', 'ink', 'font', 'size', 'density']

const ROW_H = { compact: 22, normal: 26, roomy: 32 }

const pick = (list, v) => (list.some((o) => o[0] === v) ? v : null)

/** A theme name from R or a saved preference; 'light' is the old name of Classic. */
export function normalizeTheme(v) {
  return pick(THEMES, v === 'light' ? 'classic' : v)
}

/**
 * The starting appearance: the reader's saved choices first, then the
 * author's (theme and font from R), then the defaults.
 * @param {(key: string) => string|null} load saved preference, or null
 * @param {object} x payload from R
 */
export function readAppearance(load, x = {}) {
  const oldMono = load('mono')
  return {
    theme: normalizeTheme(load('theme')) || normalizeTheme(x.theme) || 'auto',
    accent: pick(ACCENTS, load('accent')) || '',
    ink: pick(INKS, load('ink')) || '',
    font: pick(FONTS, load('font')) ||
      (oldMono === '1' ? 'mono' : oldMono === '0' ? 'sans' : null) ||
      pick(FONTS, x.font) || 'mono',
    size: pick(SIZES, load('size')) || 'normal',
    density: pick(DENSITIES, load('density')) || 'normal',
  }
}

export const defaultAppearance = (x) => readAppearance(() => null, x)

export const isDarkTheme = (theme, systemDark) =>
  theme === 'dark' || theme === 'terminal' || (theme === 'auto' && !!systemDark)

/** Terminal always uses monospace, whatever font is chosen. */
export const effectiveFont = (a) => (a.theme === 'terminal' ? 'mono' : a.font)

export const rowHeight = (a) => ROW_H[a.density] || ROW_H.normal

/** Puts the appearance on the widget root as attributes the CSS reads. */
export function applyAppearance(el, a, systemDark) {
  const font = effectiveFont(a)
  el.dataset.theme = a.theme
  if (a.accent) el.dataset.accent = a.accent
  else delete el.dataset.accent
  if (a.ink) el.dataset.ink = a.ink
  else delete el.dataset.ink
  el.dataset.font = font
  el.dataset.size = a.size
  el.dataset.density = a.density
  el.classList.toggle('pqv-mono', font === 'mono')
  el.classList.toggle('pqv-dark', isDarkTheme(a.theme, systemDark))
  el.style.setProperty('--pqv-row-h', rowHeight(a) + 'px')
}

// A row of choices that behaves as one radio group: Tab reaches the chosen
// one, arrow keys move the choice.
function radioGroup(label, options, cls, render, onPick) {
  const group = h('div', { class: 'pqv-ap-group ' + cls, role: 'radiogroup', 'aria-label': label })
  const buttons = options.map(([value, text, note]) => {
    const b = h('button', {
      class: 'pqv-ap-choice', type: 'button', role: 'radio', 'aria-checked': 'false',
      'aria-label': text, title: note ? `${text}: ${note}` : text,
    }, render(value, text))
    b.dataset.value = value
    b.addEventListener('click', () => onPick(value))
    return b
  })
  group.append(...buttons)
  group.addEventListener('keydown', (e) => {
    const moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    const live = buttons.filter((b) => !b.disabled)
    let k = live.indexOf(document.activeElement)
    if (k < 0) return
    if (e.key in moves) k = (k + moves[e.key] + live.length) % live.length
    else if (e.key === 'Home') k = 0
    else if (e.key === 'End') k = live.length - 1
    else return
    e.preventDefault()
    onPick(live[k].dataset.value)
    live[k].focus()
  })
  const sync = (value, disabled = false) => {
    for (const b of buttons) {
      const on = b.dataset.value === value
      b.setAttribute('aria-checked', String(on))
      b.tabIndex = on ? 0 : -1
      b.disabled = disabled
    }
    group.setAttribute('aria-disabled', String(disabled))
  }
  return { el: group, sync, checked: () => buttons.find((b) => b.tabIndex === 0) }
}

function themePreview(value) {
  const sample = (theme) => h('span', { class: 'pqv-ap-preview', 'data-theme': theme },
    h('span', { class: 'pqv-ap-pv-text', text: 'Aa' }),
    h('span', { class: 'pqv-ap-pv-line' }),
    h('span', { class: 'pqv-ap-pv-dot' }))
  if (value === 'auto') return h('span', { class: 'pqv-ap-auto' }, sample('classic'), sample('dark'))
  return sample(value)
}

/**
 * The Appearance window.
 * @param {object} opts
 * @param {() => object} opts.get current appearance
 * @param {(key: string, value: string) => void} opts.set change one setting
 * @param {() => void} opts.reset back to the defaults
 * @returns {{ el: HTMLElement, sync: () => void, focusTarget: () => HTMLElement }}
 */
export function appearancePanel({ get, set, reset }) {
  const theme = radioGroup('Theme', THEMES, 'pqv-ap-themes',
    (value, text) => [themePreview(value), h('span', { class: 'pqv-ap-name', text })],
    (v) => set('theme', v))
  const accent = radioGroup('Accent colour', ACCENTS, 'pqv-ap-swatches',
    (value) => h('span', { class: 'pqv-ap-swatch', 'data-accent': value || 'default', 'aria-hidden': 'true' }),
    (v) => set('accent', v))
  const ink = radioGroup('Text colour', INKS, 'pqv-ap-swatches pqv-ap-inks',
    (value) => h('span', { class: 'pqv-ap-ink', 'data-ink': value || 'default', 'aria-hidden': 'true', text: 'A' }),
    (v) => set('ink', v))
  const seg = (label, list, key) => radioGroup(label, list, 'pqv-ap-seg',
    (value, text) => text, (v) => set(key, v))
  const font = seg('Font', FONTS, 'font')
  const size = seg('Text size', SIZES, 'size')
  const density = seg('Row spacing', DENSITIES, 'density')
  const fontNote = h('div', { class: 'pqv-ap-note', text: 'Terminal always uses monospace.' })
  const row = (label, control, extra) => h('div', { class: 'pqv-ap-row' },
    h('span', { class: 'pqv-ap-k', text: label }), control.el, extra)

  const el = h('div', { class: 'pqv-pop pqv-appearance', role: 'dialog', 'aria-label': 'Appearance' },
    h('div', { class: 'pqv-pop-title', text: 'Appearance' }),
    h('div', { class: 'pqv-ap-body' },
      h('div', { class: 'pqv-ap-head', text: 'Theme' }),
      theme.el,
      h('div', { class: 'pqv-ap-head', text: 'Customize' }),
      row('Accent', accent),
      row('Text', ink),
      row('Font', font, fontNote),
      row('Text size', size),
      row('Row spacing', density)),
    h('div', { class: 'pqv-pop-foot pqv-ap-foot' },
      h('button', { class: 'pqv-link', type: 'button', text: 'Reset to defaults', onclick: () => reset() })))

  const sync = () => {
    const a = get()
    const terminal = a.theme === 'terminal'
    theme.sync(a.theme)
    accent.sync(a.accent)
    ink.sync(a.ink)
    font.sync(effectiveFont(a), terminal)
    fontNote.hidden = !terminal
    size.sync(a.size)
    density.sync(a.density)
  }
  sync()
  return { el, sync, focusTarget: () => theme.checked() }
}
