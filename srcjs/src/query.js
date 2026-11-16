// A small SQL WHERE-clause language evaluated over the column store.
//
//   age > 30 AND region IN ('West', 'South')
//   comment REGEXP 'review|call' OR income IS NULL
//   visit_date BETWEEN '2023-01' AND '2023-06'
//
// parseQuery() turns text into an AST and lists the columns it uses.
// compileQuery() turns the AST into a per-row test returning
// 1 (true), 0 (false) or 2 (unknown, SQL NULL logic).

import { displayText } from './store.js'
import { parseDateInput, DAY_MS } from './format.js'

const F = 0
const T = 1
const U = 2

export class QueryError extends Error {
  constructor(message, pos) {
    super(pos == null ? message : `${message} (at character ${pos + 1})`)
    this.pos = pos
    this.short = message
  }
}

// ---- tokenizer ------------------------------------------------------------

const KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'ILIKE', 'REGEXP', 'IREGEXP', 'RLIKE',
  'IS', 'NULL', 'TRUE', 'FALSE', 'ESCAPE',
])
const OPS = ['!~*', '<=', '>=', '<>', '!=', '==', '~*', '!~', '=', '<', '>', '+', '-', '*', '/', '%', '~']

function tokenize(text) {
  const out = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const pos = i
    if (c === '(' || c === ')' || c === ',') {
      out.push({ type: c, pos })
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      let s = ''
      for (;;) {
        if (j >= n) throw new QueryError(c === "'" ? 'Unclosed text in quotes' : 'Unclosed quoted column name', pos)
        if (text[j] === c) {
          if (text[j + 1] === c) {
            s += c
            j += 2
            continue
          }
          break
        }
        s += text[j++]
      }
      out.push({ type: c === "'" ? 'str' : 'ident', value: s, quoted: true, pos })
      i = j + 1
      continue
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i))
    if (num) {
      out.push({ type: 'num', value: Number(num[0]), pos })
      i += num[0].length
      continue
    }
    const word = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/.exec(text.slice(i))
    if (word) {
      const upper = word[0].toUpperCase()
      if (KEYWORDS.has(upper)) out.push({ type: 'kw', value: upper === 'RLIKE' ? 'REGEXP' : upper, pos })
      else out.push({ type: 'ident', value: word[0], pos })
      i += word[0].length
      continue
    }
    const op = OPS.find((o) => text.startsWith(o, i))
    if (op) {
      out.push({ type: 'op', value: op, pos })
      i += op.length
      continue
    }
    throw new QueryError(`Unexpected character '${c}'`, pos)
  }
  out.push({ type: 'end', pos: n })
  return out
}

// ---- parser ---------------------------------------------------------------

const FUNCS = {
  LOWER: { args: 1 }, UPPER: { args: 1 }, LENGTH: { args: 1 }, ABS: { args: 1 },
  YEAR: { args: 1 }, MONTH: { args: 1 }, DAY: { args: 1 },
}

/**
 * @param {string} text
 * @returns {{ ast: object|null, columns: {name: string, pos: number}[] }}
 *   ast is null for blank text.
 */
export function parseQuery(text) {
  const tokens = tokenize(text)
  let k = 0
  const columns = []
  const peek = () => tokens[k]
  const next = () => tokens[k++]
  const isKw = (v) => peek().type === 'kw' && peek().value === v
  const isOp = (...v) => peek().type === 'op' && v.includes(peek().value)
  const expect = (type, what) => {
    const t = peek()
    if (t.type !== type) throw new QueryError(`Expected ${what}`, t.pos)
    return next()
  }
  const describe = (t) => (t.type === 'end' ? 'end of query' : t.type === 'kw' ? t.value : t.type === 'op' ? `'${t.value}'` : t.type === 'str' ? 'text' : t.type === 'num' ? 'number' : t.type === 'ident' ? `'${t.value}'` : `'${t.type}'`)

  function orExpr() {
    let a = andExpr()
    while (isKw('OR')) {
      next()
      a = { t: 'or', a, b: andExpr() }
    }
    return a
  }
  function andExpr() {
    let a = notExpr()
    while (isKw('AND')) {
      next()
      a = { t: 'and', a, b: notExpr() }
    }
    return a
  }
  function notExpr() {
    if (isKw('NOT')) {
      next()
      return { t: 'not', a: notExpr() }
    }
    return predicate()
  }
  function predicate() {
    const start = peek().pos
    const a = additive()
    let neg = false
    if (isKw('NOT')) {
      const after = tokens[k + 1]
      if (after.type === 'kw' && ['IN', 'BETWEEN', 'LIKE', 'ILIKE', 'REGEXP', 'IREGEXP'].includes(after.value)) {
        next()
        neg = true
      }
    }
    const t = peek()
    if (t.type === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(t.value)) {
      next()
      const op = t.value === '==' ? '=' : t.value === '<>' ? '!=' : t.value
      return { t: 'cmp', op, a, b: additive(), pos: t.pos }
    }
    if (t.type === 'op' && ['~', '~*', '!~', '!~*'].includes(t.value)) {
      next()
      const pat = patternLiteral()
      return { t: 'regex', a, pat, ci: t.value.endsWith('*'), neg: t.value.startsWith('!'), pos: t.pos }
    }
    if (t.type === 'kw') {
      switch (t.value) {
        case 'IN': {
          next()
          expect('(', "'(' after IN")
          const list = [additive()]
          while (peek().type === ',') {
            next()
            list.push(additive())
          }
          expect(')', "')' to close the IN list")
          return { t: 'in', a, list, neg, pos: t.pos }
        }
        case 'BETWEEN': {
          next()
          const lo = additive()
          if (!isKw('AND')) throw new QueryError('Expected AND in BETWEEN ... AND ...', peek().pos)
          next()
          return { t: 'between', a, lo, hi: additive(), neg, pos: t.pos }
        }
        case 'LIKE':
        case 'ILIKE': {
          next()
          const pat = patternLiteral()
          let escape = '\\'
          if (isKw('ESCAPE')) {
            next()
            const e = expect('str', 'an escape character in quotes')
            if (e.value.length !== 1) throw new QueryError('ESCAPE must be a single character', e.pos)
            escape = e.value
          }
          return { t: 'like', a, pat, escape, neg, pos: t.pos }
        }
        case 'REGEXP':
        case 'IREGEXP': {
          next()
          return { t: 'regex', a, pat: patternLiteral(), ci: t.value === 'IREGEXP', neg, pos: t.pos }
        }
        case 'IS': {
          next()
          let not = false
          if (isKw('NOT')) {
            next()
            not = true
          }
          if (isKw('TRUE') || isKw('FALSE')) {
            const want = peek().value === 'TRUE'
            next()
            return { t: 'istruth', a, want, neg: not, pos: t.pos }
          }
          if (!isKw('NULL')) throw new QueryError('Expected NULL, TRUE or FALSE after IS', peek().pos)
          next()
          return { t: 'isnull', a, neg: not, pos: t.pos }
        }
        default:
      }
    }
    if (neg) throw new QueryError('Expected IN, BETWEEN, LIKE or REGEXP after NOT', peek().pos)
    // A bare value used as a condition, e.g. a logical column.
    return { t: 'truth', a, pos: start }
  }
  function patternLiteral() {
    const p = peek()
    if (p.type !== 'str') throw new QueryError('Expected a pattern in single quotes', p.pos)
    next()
    return p
  }
  function additive() {
    let a = multiplicative()
    while (isOp('+', '-')) {
      const op = next()
      a = { t: 'arith', op: op.value, a, b: multiplicative(), pos: op.pos }
    }
    return a
  }
  function multiplicative() {
    let a = unary()
    while (isOp('*', '/', '%')) {
      const op = next()
      a = { t: 'arith', op: op.value, a, b: unary(), pos: op.pos }
    }
    return a
  }
  function unary() {
    if (isOp('-')) {
      const op = next()
      return { t: 'neg', a: unary(), pos: op.pos }
    }
    if (isOp('+')) next()
    return primary()
  }
  function primary() {
    const t = peek()
    switch (t.type) {
      case 'num':
        next()
        return { t: 'lit', type: 'num', v: t.value, pos: t.pos }
      case 'str':
        next()
        return { t: 'lit', type: 'str', v: t.value, pos: t.pos }
      case 'kw':
        if (t.value === 'TRUE' || t.value === 'FALSE') {
          next()
          return { t: 'lit', type: 'bool', v: t.value === 'TRUE' ? 1 : 0, pos: t.pos }
        }
        if (t.value === 'NULL') {
          next()
          return { t: 'lit', type: 'null', v: null, pos: t.pos }
        }
        break
      case '(': {
        next()
        const e = orExpr()
        expect(')', "')'")
        return { t: 'paren', a: e, pos: t.pos }
      }
      case 'ident': {
        next()
        if (!t.quoted && peek().type === '(') {
          const name = t.value.toUpperCase()
          const fn = FUNCS[name]
          if (!fn) throw new QueryError(`Unknown function ${t.value}()`, t.pos)
          next()
          const args = [additive()]
          while (peek().type === ',') {
            next()
            args.push(additive())
          }
          expect(')', `')' to close ${name}(`)
          if (args.length !== fn.args) throw new QueryError(`${name}() takes ${fn.args} argument`, t.pos)
          return { t: 'fn', name, args, pos: t.pos }
        }
        columns.push({ name: t.value, pos: t.pos })
        return { t: 'col', name: t.value, pos: t.pos }
      }
      default:
    }
    throw new QueryError(`Unexpected ${describe(t)}`, t.pos)
  }

  if (peek().type === 'end') return { ast: null, columns }
  const ast = orExpr()
  if (peek().type !== 'end') throw new QueryError(`Unexpected ${describe(peek())}`, peek().pos)
  return { ast, columns }
}

/**
 * Match a column reference to a real column: exact name first, then a
 * unique case-insensitive match.
 * @returns {string|null}
 */
export function resolveColumn(name, names) {
  if (names.includes(name)) return name
  const lower = name.toLowerCase()
  const hits = names.filter((x) => x.toLowerCase() === lower)
  return hits.length === 1 ? hits[0] : null
}

// ---- compiler -------------------------------------------------------------
//
// A value compiles to { type, f } where f(i) returns the row's value or null.
//   type 'num'  numbers (dates and date-times carry unit 'date'/'datetime' and are epoch ms)
//   type 'str'  strings
//   type 'bool' 1 / 0
// Constant values also carry `lit` so literals can be specialised.

function likeToRegex(pattern, escape) {
  let src = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === escape && i + 1 < pattern.length) {
      src += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    } else if (c === '%') src += '[\\s\\S]*'
    else if (c === '_') src += '[\\s\\S]'
    else src += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(src + '$', 'iu')
}

/** Parse a date literal into the [lo, hi] epoch-ms period it names. */
function datePeriod(text, unit, zone, pos) {
  const lo = parseDateInput(text, false)
  const hi = parseDateInput(text, true)
  if (lo === null || lo !== lo) {
    throw new QueryError(`'${text}' is not a date; use YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DD HH:MM`, pos)
  }
  if (unit === 'date') return { lo, hi: Math.floor(hi / DAY_MS) * DAY_MS }
  return zone ? { lo: zone.toUtc(lo), hi: zone.toUtc(hi + 1) - 1 } : { lo, hi }
}

/**
 * @param {object} ast from parseQuery
 * @param {(name: string) => object} getCol decoded column for a resolved name
 * @returns {(i: number) => 0|1|2}
 */
export function compileQuery(ast, getCol) {
  function value(node) {
    switch (node.t) {
      case 'paren':
        if (['or', 'and', 'not', 'cmp', 'in', 'between', 'like', 'regex', 'isnull', 'istruth', 'truth'].includes(node.a.t)) {
          const p = pred(node.a)
          return { type: 'bool', f: (i) => { const r = p(i); return r === U ? null : r } }
        }
        return value(node.a)
      case 'lit':
        if (node.type === 'null') return { type: 'null', lit: true, v: null, f: () => null }
        return { type: node.type, lit: true, v: node.v, pos: node.pos, f: () => node.v }
      case 'col': {
        const col = getCol(node.name)
        const nul = col.isNull
        const base = { col, pos: node.pos }
        if (col.error) throw new QueryError(`Column '${col.name}' could not be decoded`, node.pos)
        switch (col.type) {
          case 'number':
            return { ...base, type: 'num', f: (i) => (nul[i] ? null : col.num[i]) }
          case 'date':
          case 'datetime':
            return { ...base, type: 'num', unit: col.type, zone: col.zone, f: (i) => (nul[i] ? null : col.num[i]) }
          case 'boolean':
            return { ...base, type: 'bool', f: (i) => (nul[i] ? null : col.num[i]) }
          case 'category': {
            const { codes, levels } = col
            return { ...base, type: 'str', f: (i) => (codes[i] < 0 ? null : levels[codes[i]]) }
          }
          default: {
            const str = col.str
            return { ...base, type: 'str', f: (i) => str[i] }
          }
        }
      }
      case 'neg': {
        const a = num(value(node.a), node.pos, '-')
        return { type: 'num', f: (i) => { const x = a.f(i); return x === null ? null : -x } }
      }
      case 'arith': {
        const a = num(value(node.a), node.pos, node.op)
        const b = num(value(node.b), node.pos, node.op)
        const op = node.op
        const calc = op === '+' ? (x, y) => x + y
          : op === '-' ? (x, y) => x - y
            : op === '*' ? (x, y) => x * y
              : op === '/' ? (x, y) => x / y
                : (x, y) => x % y
        return {
          type: 'num',
          f: (i) => {
            const x = a.f(i)
            if (x === null) return null
            const y = b.f(i)
            if (y === null) return null
            const r = calc(x, y)
            return r === r && Number.isFinite(r) ? r : null
          },
        }
      }
      case 'fn':
        return fn(node)
      default:
        throw new QueryError('Expected a value, not a condition', node.pos)
    }
  }

  function num(v, pos, what) {
    if (v.type === 'num' || v.type === 'null') return v
    if (v.type === 'bool') return { type: 'num', f: v.f }
    throw new QueryError(`'${what}' needs numbers${v.col ? `, but '${v.col.name}' is text` : ''}`, pos)
  }

  function text(v) {
    if (v.type === 'str' || v.type === 'null') return v
    if (v.col) {
      const t = displayText(v.col)
      return { type: 'str', col: v.col, f: (i) => t[i] }
    }
    if (v.type === 'bool') return { type: 'str', f: (i) => { const x = v.f(i); return x === null ? null : x ? 'TRUE' : 'FALSE' } }
    return { type: 'str', f: (i) => { const x = v.f(i); return x === null ? null : String(x) } }
  }

  function fn(node) {
    const a = value(node.args[0])
    switch (node.name) {
      case 'LOWER':
      case 'UPPER': {
        const s = text(a)
        const up = node.name === 'UPPER'
        return { type: 'str', f: (i) => { const x = s.f(i); return x === null ? null : up ? x.toUpperCase() : x.toLowerCase() } }
      }
      case 'LENGTH': {
        const s = text(a)
        return { type: 'num', f: (i) => { const x = s.f(i); return x === null ? null : [...x].length } }
      }
      case 'ABS': {
        const x = num(a, node.pos, 'ABS')
        return { type: 'num', f: (i) => { const v = x.f(i); return v === null ? null : Math.abs(v) } }
      }
      default: {
        if (a.type !== 'num' || !a.unit) throw new QueryError(`${node.name}() needs a date or date-time column`, node.pos)
        const zone = a.zone
        const part = node.name === 'YEAR' ? (d) => d.getUTCFullYear()
          : node.name === 'MONTH' ? (d) => d.getUTCMonth() + 1 : (d) => d.getUTCDate()
        return {
          type: 'num',
          f: (i) => {
            const ms = a.f(i)
            if (ms === null) return null
            return part(new Date(zone ? zone.wall(ms) : ms))
          },
        }
      }
    }
  }

  // Per-row test of a text value. Category columns are tested once per level.
  function textTest(v, test) {
    if (v.col && v.col.type === 'category') {
      const { codes, levels } = v.col
      const tab = levels.map((l) => (test(l) ? T : F))
      return (i) => (codes[i] < 0 ? U : tab[codes[i]])
    }
    const s = text(v)
    return (i) => {
      const x = s.f(i)
      return x === null ? U : test(x) ? T : F
    }
  }

  // Compare a value with another, handling date literals as whole periods.
  function compare(a, b, op, pos) {
    if (a.lit && !b.lit) {
      const flip = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }
      return compare(b, a, flip[op] || op, pos)
    }
    if (a.type === 'null' || b.type === 'null') return () => U

    // date or date-time against a text literal like '2024-03'
    if (a.type === 'num' && a.unit && b.lit && b.type === 'str') {
      const { lo, hi } = datePeriod(b.v, a.unit, a.zone, b.pos)
      const test = op === '=' ? (x) => x >= lo && x <= hi
        : op === '!=' ? (x) => x < lo || x > hi
          : op === '<' ? (x) => x < lo
            : op === '<=' ? (x) => x <= hi
              : op === '>' ? (x) => x > hi : (x) => x >= lo
      return (i) => { const x = a.f(i); return x === null ? U : test(x) ? T : F }
    }

    let x = a
    let y = b
    if (x.type !== y.type) {
      if (x.type === 'bool' && y.type === 'num') x = { type: 'num', f: x.f }
      else if (x.type === 'num' && y.type === 'bool') y = { type: 'num', f: y.f }
      else if (y.lit && y.type === 'str' && x.type === 'num') {
        const v = Number(y.v.trim())
        if (y.v.trim() === '' || v !== v) {
          throw new QueryError(`Cannot compare a number${x.col ? ` column ('${x.col.name}')` : ''} with text '${y.v}'`, y.pos)
        }
        y = { type: 'num', lit: true, f: () => v }
      } else if (y.lit && x.type === 'str') {
        const v = y.type === 'bool' ? (y.v ? 'TRUE' : 'FALSE') : String(y.v)
        y = { type: 'str', lit: true, v, f: () => v }
      } else if (x.type === 'str' || y.type === 'str') {
        x = text(x)
        y = text(y)
      } else {
        throw new QueryError(`Cannot compare ${x.type} with ${y.type}`, pos)
      }
    }
    const cmp = op === '=' ? (p, q) => p === q
      : op === '!=' ? (p, q) => p !== q
        : op === '<' ? (p, q) => p < q
          : op === '<=' ? (p, q) => p <= q
            : op === '>' ? (p, q) => p > q : (p, q) => p >= q
    if (y.lit && x.type === 'str') {
      const v = y.f(0)
      return textTest(x, (s) => cmp(s, v))
    }
    return (i) => {
      const p = x.f(i)
      if (p === null) return U
      const q = y.f(i)
      if (q === null) return U
      return cmp(p, q) ? T : F
    }
  }

  function negate(p) {
    return (i) => { const r = p(i); return r === U ? U : r === T ? F : T }
  }

  function pred(node) {
    switch (node.t) {
      case 'paren':
        return pred(node.a)
      case 'or': {
        const a = pred(node.a)
        const b = pred(node.b)
        return (i) => {
          const x = a(i)
          if (x === T) return T
          const y = b(i)
          return y === T ? T : x === F && y === F ? F : U
        }
      }
      case 'and': {
        const a = pred(node.a)
        const b = pred(node.b)
        return (i) => {
          const x = a(i)
          if (x === F) return F
          const y = b(i)
          return y === F ? F : x === T && y === T ? T : U
        }
      }
      case 'not':
        return negate(pred(node.a))
      case 'cmp':
        return compare(value(node.a), value(node.b), node.op, node.pos)
      case 'between': {
        const a = value(node.a)
        const lo = compare(a, value(node.lo), '>=', node.pos)
        const hi = compare(a, value(node.hi), '<=', node.pos)
        const p = (i) => {
          const x = lo(i)
          if (x === F) return F
          const y = hi(i)
          return y === F ? F : x === T && y === T ? T : U
        }
        return node.neg ? negate(p) : p
      }
      case 'in': {
        const a = value(node.a)
        const tests = node.list.map((item) => compare(a, value(item), '=', item.pos || node.pos))
        let p
        const lits = node.list.map(value)
        if (a.type === 'str' && lits.every((l) => l.lit && l.type !== 'null')) {
          const set = new Set(lits.map((l) => (l.type === 'bool' ? (l.v ? 'TRUE' : 'FALSE') : String(l.v))))
          p = textTest(a, (s) => set.has(s))
        } else {
          p = (i) => {
            let unknown = false
            for (let k = 0; k < tests.length; k++) {
              const r = tests[k](i)
              if (r === T) return T
              if (r === U) unknown = true
            }
            return unknown ? U : F
          }
        }
        return node.neg ? negate(p) : p
      }
      case 'like': {
        const re = likeToRegex(node.pat.value, node.escape)
        const p = textTest(value(node.a), (s) => re.test(s))
        return node.neg ? negate(p) : p
      }
      case 'regex': {
        let re
        try {
          re = new RegExp(node.pat.value, node.ci ? 'iu' : 'u')
        } catch (err) {
          throw new QueryError(`Invalid regular expression: ${String(err.message).replace(/^Invalid regular expression: /, '')}`, node.pat.pos)
        }
        const p = textTest(value(node.a), (s) => re.test(s))
        return node.neg ? negate(p) : p
      }
      case 'isnull': {
        const a = value(node.a)
        if (a.col) {
          const nul = a.col.isNull
          return node.neg ? (i) => (nul[i] ? F : T) : (i) => (nul[i] ? T : F)
        }
        return node.neg ? (i) => (a.f(i) === null ? F : T) : (i) => (a.f(i) === null ? T : F)
      }
      case 'istruth': {
        // Never unknown: a missing result is neither TRUE nor FALSE.
        const a = value(node.a)
        if (a.type !== 'bool') throw new QueryError('IS TRUE / IS FALSE needs a condition or a logical column', node.pos)
        const want = node.want ? 1 : 0
        const hit = node.neg ? F : T
        const miss = node.neg ? T : F
        return (i) => {
          const x = a.f(i)
          return x !== null && +x === want ? hit : miss
        }
      }
      case 'truth': {
        const a = value(node.a)
        if (a.type !== 'bool') {
          throw new QueryError(
            a.col ? `'${a.col.name}' is not a logical column; compare it with something, e.g. ${a.col.name} = ...` : 'Expected a condition',
            node.pos,
          )
        }
        return (i) => { const x = a.f(i); return x === null ? U : x ? T : F }
      }
      default:
        throw new QueryError('Expected a condition', node.pos)
    }
  }

  return pred(ast)
}

/**
 * Evaluate a compiled test over every row.
 * @returns {Uint8Array} 1 where the row is kept. Inverted keeps every row
 *   where the condition is not true, including unknown (NULL) results.
 */
export function evaluateQuery(test, n, invert = false) {
  const mask = new Uint8Array(n)
  if (invert) for (let i = 0; i < n; i++) mask[i] = test(i) === T ? 0 : 1
  else for (let i = 0; i < n; i++) mask[i] = test(i) === T ? 1 : 0
  return mask
}
