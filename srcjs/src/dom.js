// Tiny DOM helpers.

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
