// Appearance: colour theme, accent colour, text colour, table font, text
// size, row spacing and where the controls sit. The colours themselves live in plank.css as token blocks; this
// module only picks which block applies and builds the settings window.

import { h } from './dom.js'

export const THEMES = [
  ['auto', 'Auto', 'Follows the system light or dark setting'],
  ['classic', 'Classic', 'Light and neutral'],
  ['modern', 'Modern', 'Crisp white, cool greys'],
  ['dark', 'Dark', 'Light text on dark grey'],
  ['vintage', 'Vintage', 'Sepia ink on cream paper'],
  ['starship', 'Starship', 'Starship console: black, with orange and lilac panels'],
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
export const PLACES = [['top', 'Top'], ['bottom', 'Bottom']]
// Fine-tuning ("More options"): 'theme' means whatever the theme does.
export const DECORS = [['theme', 'Theme', "The theme's own"], ['on', 'On', 'Coloured bands and filled buttons'], ['off', 'Off', 'Plain controls']]
export const SHAPES = [['theme', 'Theme', "The theme's own"], ['square', 'Square'], ['rounded', 'Rounded'], ['pill', 'Pill']]
export const UIFONTS = [['theme', 'Theme', "The theme's own"], ['sans', 'Sans'], ['condensed', 'Condensed', 'Narrow capitals'], ['mono', 'Mono'], ['serif', 'Serif']]
export const CONTRASTS = [['soft', 'Soft', 'Fainter lines'], ['normal', 'Normal'], ['high', 'High', 'Stronger lines and labels']]
export const APPEARANCE_KEYS = ['theme', 'accent', 'ink', 'font', 'size', 'density', 'controls', 'decor', 'shape', 'uifont', 'contrast']

// What 'theme' means for each fine-tuning setting, per theme. Anything not
// listed: no decor, and the theme's own shapes and controls font.
const THEME_LOOK = {
  starship: { decor: 'on', shape: 'pill', uifont: 'condensed' },
}

const ROW_H = { compact: 22, normal: 26, roomy: 32 }

const pick = (list, v) => (list.some((o) => o[0] === v) ? v : null)

// Old theme names: Light became Classic, Terminal became Starship.
const OLD_THEMES = { light: 'classic', terminal: 'starship' }

/** A theme name from R or a saved preference, old names included. */
export function normalizeTheme(v) {
  return pick(THEMES, OLD_THEMES[v] || v)
}

/**
 * The starting appearance: the reader's saved choices first, then the
 * author's (theme, font and controls from R), then the defaults.
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
    controls: pick(PLACES, load('controls')) || pick(PLACES, x.controls) || 'top',
    decor: pick(DECORS, load('decor')) || 'theme',
    shape: pick(SHAPES, load('shape')) || 'theme',
    uifont: pick(UIFONTS, load('uifont')) || 'theme',
    contrast: pick(CONTRASTS, load('contrast')) || 'normal',
  }
}

/**
 * The fine-tuning settings with 'theme' replaced by the theme's own choice.
 * shape and uifont are null when the theme's CSS decides.
 */
export function resolveLook(a) {
  const own = THEME_LOOK[a.theme] || {}
  const choose = (key, list, fallback) => {
    const v = pick(list, a[key])
    return !v || v === 'theme' ? (own[key] || fallback) : v
  }
  return {
    decor: choose('decor', DECORS, 'off'),
    shape: choose('shape', SHAPES, null),
    uifont: choose('uifont', UIFONTS, null),
    contrast: pick(CONTRASTS, a.contrast) || 'normal',
  }
}

export const defaultAppearance = (x) => readAppearance(() => null, x)

export const isDarkTheme = (theme, systemDark) =>
  theme === 'dark' || theme === 'starship' || (theme === 'auto' && !!systemDark)

/** The table font. (Every theme now follows the reader's choice.) */
export const effectiveFont = (a) => a.font

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
  el.dataset.controls = a.controls || 'top'
  const fine = resolveLook(a)
  el.dataset.decor = fine.decor
  el.dataset.contrast = fine.contrast
  if (fine.shape) el.dataset.shape = fine.shape
  else delete el.dataset.shape
  if (fine.uifont) el.dataset.uifont = fine.uifont
  else delete el.dataset.uifont
  el.classList.toggle('pqv-mono', font === 'mono')
  el.classList.toggle('pqv-dark', isDarkTheme(a.theme, systemDark))
  el.style.setProperty('--pqv-row-h', rowHeight(a) + 'px')
  applyContrast(el, fine.contrast)
}

// Contrast mixes the theme's line and muted colours toward the background
// (soft) or the text (high). A CSS variable cannot be mixed from its own
// value, so the theme's colours are read first and the mix set inline.
const CONTRAST_MIX = {
  soft: { to: '--pqv-bg', '--pqv-line': 45, '--pqv-line-strong': 40, '--pqv-muted': 25 },
  high: { to: '--pqv-fg', '--pqv-line': 40, '--pqv-line-strong': 40, '--pqv-muted': 45 },
}

function applyContrast(el, contrast) {
  const keys = ['--pqv-line', '--pqv-line-strong', '--pqv-muted']
  for (const k of keys) el.style.removeProperty(k)
  const mix = CONTRAST_MIX[contrast]
  if (!mix || typeof getComputedStyle !== 'function') return
  const cs = getComputedStyle(el)
  const to = cs.getPropertyValue(mix.to).trim()
  if (!to) return
  for (const k of keys) {
    const v = cs.getPropertyValue(k).trim()
    if (v) el.style.setProperty(k, `color-mix(in srgb, ${v} ${100 - mix[k]}%, ${to})`)
  }
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

let moreOpen = false

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
  const controls = seg('Controls', PLACES, 'controls')
  const decor = seg('Decor', DECORS, 'decor')
  const shape = seg('Shapes', SHAPES, 'shape')
  const uifont = seg('Controls font', UIFONTS, 'uifont')
  const contrast = seg('Contrast', CONTRASTS, 'contrast')
  const row = (label, control, extra) => h('div', { class: 'pqv-ap-row' },
    h('span', { class: 'pqv-ap-k', text: label }), control.el, extra)
  // Starts folded; stays open while the page is (not saved).
  const more = h('details', { class: 'pqv-ap-more' },
    h('summary', { class: 'pqv-ap-more-sum', text: 'More options' }),
    row('Decor', decor),
    row('Shapes', shape),
    row('Controls font', uifont),
    row('Contrast', contrast))
  more.open = moreOpen
  more.addEventListener('toggle', () => { moreOpen = more.open })

  const el = h('div', { class: 'pqv-pop pqv-appearance', role: 'dialog', 'aria-label': 'Appearance' },
    h('div', { class: 'pqv-pop-title', text: 'Appearance' }),
    h('div', { class: 'pqv-ap-body' },
      h('div', { class: 'pqv-ap-head', text: 'Theme' }),
      theme.el,
      h('div', { class: 'pqv-ap-head', text: 'Customize' }),
      row('Accent', accent),
      row('Text', ink),
      row('Font', font),
      row('Text size', size),
      row('Row spacing', density),
      row('Controls', controls),
      more),
    h('div', { class: 'pqv-pop-foot pqv-ap-foot' },
      h('button', { class: 'pqv-link', type: 'button', text: 'Reset to defaults', onclick: () => reset() })))

  const sync = () => {
    const a = get()
    theme.sync(a.theme)
    accent.sync(a.accent)
    ink.sync(a.ink)
    font.sync(effectiveFont(a))
    size.sync(a.size)
    density.sync(a.density)
    controls.sync(a.controls || 'top')
    decor.sync(a.decor || 'theme')
    shape.sync(a.shape || 'theme')
    uifont.sync(a.uifont || 'theme')
    contrast.sync(a.contrast || 'normal')
  }
  sync()
  return { el, sync, focusTarget: () => theme.checked() }
}
