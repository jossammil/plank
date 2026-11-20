// Tiny DOM helpers.

export const COPY_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/></svg>'

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k]
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k === 'value') el.value = v
      else if (k === 'style') Object.assign(el.style, v)
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : v)
    }
  }
  for (const c of children.flat()) if (c != null) el.append(c)
  return el
}

export function debounce(fn, ms) {
  let t = 0
  const wrapped = (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  wrapped.cancel = () => clearTimeout(t)
  return wrapped
}

export const idle = typeof window !== 'undefined' && window.requestIdleCallback
  ? (fn) => window.requestIdleCallback(fn, { timeout: 500 })
  : (fn) => setTimeout(fn, 30)
