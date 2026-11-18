// End-to-end test of examples/demo.html in a real browser.
//
//   Rscript examples/make-demo.R            # from the package root
//   cd srcjs && npm run e2e                 # Chromium (or installed Chrome)
//   BROWSER=webkit npm run e2e              # WebKit, Safari's engine
//
// Row counts are compared with examples/demo-expected.json, which R writes
// alongside the demo by applying the same filters to the data frame.

import { chromium, webkit } from 'playwright'
import { readFileSync, existsSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const demo = path.join(root, 'examples/demo.html')
const expected = JSON.parse(readFileSync(path.join(root, 'examples/demo-expected.json'), 'utf8'))
const engine = process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium'
const shots = process.env.SHOTS || ''
if (shots && !existsSync(shots)) mkdirSync(shots, { recursive: true })

const results = []
const check = (name, actual, want) => {
  const ok = actual === want
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : '  (expected ' + JSON.stringify(want) + ')'}`)
}

const launch = engine === 'webkit'
  ? () => webkit.launch()
  : async () => {
    // Prefer an installed Chrome so local runs need no browser download.
    try {
      return await chromium.launch({ channel: 'chrome' })
    } catch {
      return chromium.launch()
    }
  }
const browser = await launch()
console.log(`engine: ${engine} ${browser.version()}`)
const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, acceptDownloads: true, colorScheme: 'light' })
if (engine === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
const page = await context.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

const url = pathToFileURL(demo).href
const ready = (p) => p.waitForFunction(() => document.querySelector('.pqv')?.pqview?.timings.firstTable, null, { timeout: 30000 })
await page.goto(url)
await ready(page)
const timings = await page.evaluate(() => document.querySelector('.pqv').pqview.timings)
console.log('timings (ms):', JSON.stringify(timings, (k, v) => (typeof v === 'number' ? +v.toFixed(1) : v)))

const pqv = page.locator('.pqv')
const undoBtn = page.locator('.pqv-undo .pqv-btn').nth(0)
const redoBtn = page.locator('.pqv-undo .pqv-btn').nth(1)
const step = () => page.waitForTimeout(650)
const toggleBtn = (text) => (text === 'Mono'
  ? page.locator('.pqv-prefs .pqv-pref-mono')
  : page.locator('.pqv-switches .pqv-toggle').getByText(text, { exact: true }))
const exportAs = async (format) => {
  await page.locator('.pqv-toolbar .pqv-btn', { hasText: 'Export' }).click()
  const [d] = await Promise.all([page.waitForEvent('download'), page.locator(`.pqv-export-item[data-format="${format}"]`).click()])
  await page.keyboard.press('Escape')
  return d
}
const settle = () => page.waitForTimeout(180)
const count = async () => +(/^([\d,]+)/.exec(await page.locator('.pqv-status').innerText())[1].replace(/,/g, ''))
const lastCompute = () => page.evaluate(() => +document.querySelector('.pqv').pqview.timings.lastCompute.toFixed(2))
const hcell = (name) => page.locator(`.pqv-hcell[data-name="${name}"]`)
const clearBtn = page.locator('.pqv-btn', { hasText: 'Clear filters' })
const clear = async () => {
  if (await clearBtn.isVisible()) await clearBtn.click()
  await settle()
  check('  cleared back to all rows', await count(), expected.total)
}
const firstRow = async () => {
  await page.evaluate(() => {
    const g = document.querySelector('.pqv').pqview.grid
    g.scroller.scrollLeft = 0
    g.render()
  })
  // A row is drawn in two parts: the pinned part (row number and pinned
  // columns) and the part that scrolls.
  const pinned = await page.locator('.pqv-pinrows .pqv-row').first().locator('.pqv-cell').allInnerTexts()
  const rest = await page.locator('.pqv-rows:not(.pqv-pinrows) .pqv-row').first().locator('.pqv-cell').allInnerTexts()
  return pinned.concat(rest)
}
const option = async (colName, value) => {
  await hcell(colName).locator('.pqv-opt').click()
  await page.locator(`.pqv-opts input[value="${value}"]`).check()
  await page.keyboard.press('Escape')
}
const query = async (text) => {
  await page.locator('.pqv-query-input').fill(text)
  await page.locator('.pqv-query-input').press('Enter')
  await settle()
}

// ---- basics -------------------------------------------------------------
check('status shows all rows', await page.locator('.pqv-status').innerText(), '100,000 rows')
check('columns listed in picker', await page.locator('.pqv-pitem').count(), 30)
check('columns shown by default', await page.locator('.pqv-hcell[data-name]').count(), 10)
check('no view is current at the start', await page.locator('.pqv-toolbar .pqv-viewsbtn').innerText(), 'Views')
check('rows in DOM are virtualised (< 80)', (await page.locator('.pqv-pinrows .pqv-row').count()) < 80, true)

// ---- standalone top offset ------------------------------------------------
const toolbarTop = await page.locator('.pqv-toolbar').evaluate((e) => e.getBoundingClientRect().top)
check('toolbar sits below the top offset (>= 56px)', toolbarTop >= 56, true)
check('page marked standalone', await pqv.evaluate((e) => e.classList.contains('pqv-standalone')), true)
check('monospace font by default', await pqv.evaluate((e) => e.classList.contains('pqv-mono')), true)
check('room above the title (>= 24px)', await page.locator('.pqv-header .pqv-title').evaluate((e) => e.getBoundingClientRect().top) >= 24, true)
check('no Wider/Narrower button', await page.locator('.pqv-picker button', { hasText: /Wider|Narrower/ }).count(), 0)
check('title in the top band', await page.locator('.pqv-header .pqv-title').innerText(), 'Synthetic demo')
check('notes under the title', /100,000 synthetic records/.test(await page.locator('.pqv-header .pqv-notes').innerText()), true)
check('data size shown', /^data\s*\d+(\.\d+)? MB$/i.test((await page.locator('.pqv-sizes .pqv-size').first().innerText()).replace(/\s+/g, ' ')), true)
if (shots) await page.screenshot({ path: `${shots}/${engine}-01-initial.png` })

// ---- column filters, invert and missing values ----------------------------
await hcell('age').locator('input').nth(0).fill('30')
await hcell('age').locator('input').nth(1).fill('40')
await settle()
check('age 30..40', await count(), expected.age_30_40)
await option('age', 'invert')
await settle()
check('age 30..40 inverted (NA included)', await count(), expected.total - expected.age_30_40)
check('NOT badge on age', await hcell('age').locator('.pqv-badge').first().innerText(), 'NOT')
check('options button highlighted', await hcell('age').locator('.pqv-opt.pqv-on').count(), 1)
await option('age', 'exclude')
await settle()
const ageNA = await page.evaluate(() => {
  const ds = document.querySelector('.pqv').pqview.ds
  return ds.peek('age').nullCount
})
check('inverted and missing hidden', await count(), expected.total - expected.age_30_40 - ageNA)
await clear()

await option('income', 'only')
await settle()
check('income missing only', await count(), expected.income_na)
await clear()

// category checklist, then inverted
await hcell('region').locator('.pqv-levels').click()
await page.locator('.pqv-pop .pqv-link', { hasText: 'None' }).click()
await page.locator('.pqv-pop-item', { has: page.getByText('West', { exact: true }) }).locator('input').check()
await page.locator('.pqv-pop-item', { has: page.getByText('South', { exact: true }) }).locator('input').check()
await page.keyboard.press('Escape')
await settle()
check('region in West, South', await count(), expected.region_west_south)
await option('region', 'invert')
await settle()
check('region not in West, South', await count(), expected.total - expected.region_west_south)
await clear()

// category value finder with a regex
await hcell('state').locator('.pqv-levels').click()
await page.locator('.pqv-pop-find input').fill('^ala')
await page.locator('.pqv-pop-find .pqv-toggle').click()
check('regex value finder shows 2 states', await page.locator('.pqv-pop-item:visible').count(), 2)
await page.locator('.pqv-pop .pqv-link', { hasText: 'Only these' }).click()
await page.keyboard.press('Escape')
await settle()
check('state via regex finder', await count(), expected.search_regex_ala)
await clear()

// text column: regex, case-sensitive regex, exact and invert
await option('comment', 'regex')
await hcell('comment').locator('input.pqv-input').fill('^needs|voicemail')
await settle()
check('comment regex', await count(), expected.comment_regex)
console.log('   compute ms:', await lastCompute())
await hcell('comment').locator('.pqv-opt').click()
await page.locator('.pqv-opts .pqv-opt-check input').check()
await page.keyboard.press('Escape')
await hcell('comment').locator('input.pqv-input').fill('^Needs|voicemail')
await settle()
check('comment regex, case sensitive', await count(), expected.comment_regex_cs)
await option('comment', 'invert')
await settle()
check('comment regex inverted (NA included)', await count(), expected.total - expected.comment_regex_cs)
await hcell('comment').locator('input.pqv-input').fill('(broken')
await settle()
check('invalid regex flagged', await hcell('comment').locator('input.pqv-bad').count(), 1)
check('invalid regex ignored', await count(), expected.total)
await clear()
check('clear resets column options', await hcell('comment').locator('.pqv-opt.pqv-on').count(), 0)

await hcell('enrolled').locator('select').selectOption('T')
await settle()
check('enrolled TRUE', await count(), expected.enrolled_true)
await clear()

await hcell('visit_date').locator('input').nth(0).fill('2023-06')
await hcell('visit_date').locator('input').nth(1).fill('2023-06')
await settle()
check('visit_date within 2023-06', await count(), expected.visit_2023_06)
await clear()

await hcell('updated_at').locator('input').nth(0).fill('2024-03-10')
await hcell('updated_at').locator('input').nth(1).fill('2024-03-10')
await settle()
check('updated_at on 2024-03-10 (Chicago time)', await count(), expected.updated_march_local)
await clear()

// ---- global search ------------------------------------------------------
await page.locator('.pqv-search').fill('alaska')
await settle()
check('search alaska', await count(), expected.search_alaska)
await page.locator('.pqv-searchgroup .pqv-toggle', { hasText: 'NOT' }).click()
await settle()
check('search NOT alaska', await count(), expected.total - expected.search_alaska)
await clear()
await page.locator('.pqv-searchgroup .pqv-toggle', { hasText: '.*' }).click()
await page.locator('.pqv-search').fill('^ala')
await settle()
check('search regex ^ala', await count(), expected.search_regex_ala)
await page.locator('.pqv-search').fill('[')
await settle()
check('invalid search regex flagged', await page.locator('.pqv-search.pqv-bad').count(), 1)
await page.locator('.pqv-searchgroup .pqv-toggle', { hasText: '.*' }).click()
await clear()

// ---- WHERE query --------------------------------------------------------
const queries = [
  ["age > 30 AND region IN ('West', 'South')", 'q_age_region'],
  ["comment REGEXP '^(called|left)'", 'q_regex'],
  ["comment LIKE '%REVIEW%'", 'q_like'],
  ['income IS NULL OR income < 20000', 'q_null'],
  ["visit_date BETWEEN '2023-01' AND '2023-06'", 'q_dates'],
  ['YEAR(visit_date) = 2024 AND NOT enrolled', 'q_year_not'],
  ['measure_03 > 30', 'q_hidden'],
  ['income / 1000 >= 50', 'q_arith'],
]
for (const [text, key] of queries) {
  await query(text)
  check(`WHERE ${text}`, await count(), expected[key])
}
console.log('   query ms:', await page.evaluate(() => +document.querySelector('.pqv').pqview.timings.lastQuery.toFixed(2)))

await query("age > 30 AND region IN ('West', 'South')")
await page.locator('.pqv-querybar .pqv-toggle', { hasText: 'NOT' }).click()
await settle()
check('WHERE inverted (NULLs included)', await count(), expected.total - expected.q_age_region)
await page.locator('.pqv-querybar .pqv-toggle', { hasText: 'NOT' }).click()
await settle()

// query combines with a column filter
await hcell('enrolled').locator('select').selectOption('T')
await settle()
check('WHERE + column filter', await count(), expected.q_age_region_enrolled)

await query('agee > 3')
check('unknown column error shown', /Unknown column 'agee'/.test(await page.locator('.pqv-query-msg').innerText()), true)
check('last valid query still applied', await count() < expected.total, true)
if (shots) await page.screenshot({ path: `${shots}/${engine}-02-query-error.png` })
await clear()
check('clear empties the query', await page.locator('.pqv-query-input').inputValue(), '')

// help examples insert into the box
await page.locator('.pqv-querybar .pqv-icon').click()
check('help lists examples', (await page.locator('.pqv-help-item').count()) >= 6, true)
if (shots) await page.screenshot({ path: `${shots}/${engine}-03-query-help.png` })
await page.locator('.pqv-help-item').first().click()
await settle()
check('help example runs', await count(), expected.q_age_region)
await clear()

// ---- sort ---------------------------------------------------------------
await hcell('income').locator('.pqv-hname').click()
await settle()
check('sort income asc: first record', (await firstRow())[1], expected.first_sorted_income)
await hcell('income').locator('.pqv-hname').click()
await hcell('income').locator('.pqv-hname').click()
await settle()
await hcell('comment').locator('.pqv-hname').click()
await settle()
check('sort text asc: first record', (await firstRow())[1], expected.first_sorted_comment)
console.log('   text sort ms:', await page.evaluate(() => +document.querySelector('.pqv').pqview.timings.lastCompute.toFixed(0)))
await hcell('comment').locator('.pqv-hname').click()
await settle()
check('sort text desc: first record', (await firstRow())[1], expected.last_sorted_comment)
await hcell('comment').locator('.pqv-hname').click()
await settle()

// ---- export: CSV, Excel, R, parquet and clipboard -------------------------
await query("region = 'West'")
const estText = await page.locator('.pqv-sizes .pqv-size').nth(1).locator('.pqv-size-v').innerText()
const download = await exportAs('csv')
check('CSV file name', download.suggestedFilename(), 'Synthetic_demo.csv')
const csvBytes = readFileSync(await download.path())
const csv = csvBytes.toString('utf8').trimEnd().split('\r\n')
check('CSV rows = filtered rows', csv.length - 1, expected.region_exact_west)
const est = (() => { const m = /([\d.]+) (KB|MB)/.exec(estText); return +m[1] * (m[2] === 'MB' ? 1048576 : 1024) })()
console.log(`   export estimate ${estText}, actual ${(csvBytes.length / 1048576).toFixed(2)} MB`)
check('export size estimate within 5%', Math.abs(est - csvBytes.length) / csvBytes.length < 0.05, true)
const outDir = mkdtempSync(path.join(os.tmpdir(), 'pqview-e2e-'))
for (const f of ['xlsx', 'rds', 'parquet']) {
  const d = await exportAs(f)
  check(`${f} file name`, d.suggestedFilename(), `Synthetic_demo.${f}`)
  copyFileSync(await d.path(), path.join(outDir, `west.${f}`))
}
console.log('   export ms (parquet):', await page.evaluate(() => +document.querySelector('.pqv').pqview.timings.lastExport.toFixed(1)))
const shownCols = (await page.locator('.pqv-hcell[data-name]').evaluateAll((els) => els.map((e) => e.dataset.name))).join('|')
let rcheck = null
try {
  rcheck = JSON.parse(execFileSync('Rscript', [path.join(root, 'srcjs/test-e2e/check-exports.R'), outDir], { encoding: 'utf8' }))
} catch (err) {
  console.log('SKIP  reading exports in R (' + String(err.message).split('\n')[0] + ')')
}
if (rcheck) {
  for (const f of ['rds', 'parquet', 'xlsx']) {
    const r = rcheck[f]
    if (!r) {
      console.log(`SKIP  ${f} not readable in this R installation`)
      continue
    }
    check(`${f}: rows`, r.nrow, expected.region_exact_west)
    check(`${f}: columns`, r.names.join('|'), shownCols)
    check(`${f}: sum of income`, Math.abs(r.income_sum - expected.west_income_sum) < 1e-6 * expected.west_income_sum, true)
    check(`${f}: missing ages`, r.age_na, expected.west_age_na)
    check(`${f}: dates`, r.visit_first, expected.west_visit_first)
  }
  check('rds: types kept', rcheck.rds.classes, 'character|factor|character|integer|numeric|numeric|logical|Date|POSIXct|character')
  check('rds: time zone kept', rcheck.rds.tz, 'America/Chicago')
  check('rds: local times', rcheck.rds.updated_first, expected.west_updated_first)
  check('parquet: types kept', rcheck.parquet.classes, 'character|character|character|integer|numeric|numeric|logical|Date|POSIXct|character')
  check('xlsx: dates are dates', rcheck.xlsx.classes.split('|')[7], 'POSIXct')
}
// clipboard: tab-separated text. Safari only allows copying while the click
// is being handled, so record whether the copy call happens inside it.
await page.evaluate(() => {
  window.__copyInClick = []
  let inClick = false
  document.addEventListener('click', () => {
    inClick = true
    setTimeout(() => { inClick = false }, 0)
  }, true)
  const exec = document.execCommand.bind(document)
  document.execCommand = (cmd, ...rest) => {
    if (cmd === 'copy') window.__copyInClick.push(inClick)
    return exec(cmd, ...rest)
  }
  if (navigator.clipboard) {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard)
    navigator.clipboard.writeText = (t) => {
      window.__copyInClick.push(inClick)
      return write(t)
    }
  }
})
await page.locator('.pqv-toolbar .pqv-btn', { hasText: 'Export' }).click()
await page.locator('.pqv-export-item[data-format="clip"]').click()
await page.waitForFunction(() => /Copied|did not allow/.test(document.querySelector('.pqv-export-msg')?.textContent || ''))
const clipMsg = await page.locator('.pqv-export-msg').innerText()
check('copy happens inside the click (Safari rule)', await page.evaluate(() => window.__copyInClick[0]), true)
check('clipboard copy reported', clipMsg, `Copied ${expected.region_exact_west.toLocaleString('en-US')} rows to the clipboard.`)
if (engine === 'chromium') {
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null)
  if (clip) {
    const lines = clip.trimEnd().split(/\r?\n/)
    check('clipboard rows', lines.length - 1, expected.region_exact_west)
    check('clipboard is tab-separated', lines[0], shownCols.replace(/\|/g, '\t'))
  }
}
await page.keyboard.press('Escape')
await clear()

// ---- AND/OR column filters ----------------------------------------------
await hcell('age').locator('input').nth(0).fill('61')
await option('age', 'or')
await hcell('income').locator('input').nth(0).fill('100000')
await option('income', 'or')
await settle()
check('age >= 61 OR income >= 100000', await count(), expected.or_age_income)
check('OR badge on age', await hcell('age').locator('.pqv-badge', { hasText: 'OR' }).count(), 1)
await hcell('region').locator('.pqv-levels').click()
await page.locator('.pqv-pop .pqv-link', { hasText: 'None' }).click()
await page.locator('.pqv-pop-item', { has: page.getByText('West', { exact: true }) }).locator('input').check()
await page.keyboard.press('Escape')
await settle()
check('(age OR income) AND region West', await count(), expected.or_age_income_west)
await option('income', 'and')
await settle()
check('single OR acts like AND', await count(),
  await page.evaluate(() => {
    const p = document.querySelector('.pqv').pqview
    const age = p.ds.peek('age'), inc = p.ds.peek('income'), reg = p.ds.peek('region')
    const west = reg.levels.indexOf('West')
    let k = 0
    for (let i = 0; i < p.ds.n; i++) if (age.num[i] >= 61 && inc.num[i] >= 100000 && reg.codes[i] === west) k++
    return k
  }))
await clear()

// ---- column list: selected first, tick order, drag to reorder -------------
const headNames = () => page.locator('.pqv-hcell[data-name]').evaluateAll((els) => els.map((e) => e.dataset.name))
const pickNames = (sel) => page.locator(`${sel} .pqv-pitem`).evaluateAll((els) => els.map((e) => e.dataset.name))
await page.locator('.pqv-pitem[data-name="measure_03"] input').check()
await settle()
check('ticked column joins the selected group last', (await pickNames('.pqv-psel')).slice(-1)[0], 'measure_03')
check('ticked column appears at the right of the table', (await headNames()).slice(-1)[0], 'measure_03')
// drag measure_03 by its grip to just above 'comment'
await page.locator('.pqv-pitem[data-name="measure_03"]').scrollIntoViewIfNeeded()
const src = await page.locator('.pqv-pitem[data-name="measure_03"] .pqv-grip').boundingBox()
const dst = await page.locator('.pqv-pitem[data-name="comment"]').boundingBox()
await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2)
await page.mouse.down()
await page.mouse.move(src.x + 6, src.y - 10, { steps: 4 })
await page.mouse.move(dst.x + 40, dst.y + 6, { steps: 12 })
await page.mouse.up()
await settle()
let order = await headNames()
check('dragged column lands before comment', order[order.indexOf('comment') - 1], 'measure_03')
// and with the keyboard: Alt+Up moves it to the front
for (let k = 0; k < 10; k++) await page.locator('.pqv-pitem[data-name="measure_03"] input').press('Alt+ArrowUp')
await settle()
order = await headNames()
check('reordered column leads the table', order[0], 'measure_03')
check('picker selected group matches the table', JSON.stringify(await pickNames('.pqv-psel')), JSON.stringify(order))
await page.locator('.pqv-pitem[data-name="measure_03"] input').uncheck()
await settle()
check('unticked column returns to the other group',
  (await pickNames('.pqv-plist .pqv-pgroup-list:not(.pqv-psel)')).includes('measure_03'), true)

// ---- distribution charts ---------------------------------------------------
await page.waitForFunction(() => document.querySelectorAll('.pqv-pchart svg').length === 30, null, { timeout: 30000 })
check('every column has a chart', await page.locator('.pqv-pchart svg').count(), 30)
check('no overlay without filters', await page.locator('.pqv-pchart svg[data-on]').count(), 0)
await hcell('age').locator('input').nth(0).fill('30')
await hcell('age').locator('input').nth(1).fill('40')
await settle()
await page.waitForFunction((n) => {
  const els = Array.from(document.querySelectorAll('.pqv-pchart svg'))
  return els.length && els.every((e) => +e.getAttribute('data-on') === n)
}, expected.age_30_40, { timeout: 5000 }).catch(() => {})
const overlay = await page.locator('.pqv-pchart svg').evaluateAll((els) => els.map((e) => e.dataset.on))
check('every chart shows the filtered rows', overlay.every((v) => v !== undefined), true)
check('overlay totals equal the shown rows', overlay.every((v) => +v === +overlay[0]) && +overlay[0], expected.age_30_40)
if (shots) await page.screenshot({ path: `${shots}/${engine}-06-charts-or.png` })
await clear()
await page.waitForTimeout(400)
check('overlay cleared with filters', await page.locator('.pqv-pchart svg[data-on]').count(), 0)

// ---- marker columns --------------------------------------------------------
const markBtn = page.locator('.pqv-toolbar .pqv-btn', { hasText: 'Mark' })
await query("region = 'West'")
await markBtn.click()
check('mark value defaults to 1', await page.locator('.pqv-markpanel input[aria-label="Value to mark"]').inputValue(), '1')
check('mark note', /Marks are saved in this browser; Export includes them\.$/.test(await page.locator('.pqv-markpanel .pqv-opt-note').innerText()), true)
await page.locator('.pqv-markpanel input[aria-label="New column name"]').fill('review')
await page.locator('.pqv-markpanel input[aria-label="Value to mark"]').fill('yes')
await page.locator('.pqv-markpanel .pqv-btn', { hasText: 'filtered rows' }).first().click()
await settle()
check('mark message', /Marked 'review' = 'yes' on 24,?929|Marked 'review'/.test(await page.locator('.pqv-mark-msg').innerText()), true)
await page.keyboard.press('Escape')
check('marker column added to the table', (await headNames()).slice(-1)[0], 'review')
check('marker column in the picker', await page.locator('.pqv-pitem[data-name="review"]').count(), 1)
await clear()
await query("review = 'yes'")
check('WHERE on the marker column', await count(), expected.region_exact_west)
await query('')
await option('review', 'exclude')
await settle()
check('marker filter: marked rows only', await count(), expected.region_exact_west)
await clear()

// set one cell by hand
await query("region = 'South'")
await page.evaluate(() => { const g = document.querySelector('.pqv').pqview.grid; g.scroller.scrollLeft = g.scroller.scrollWidth; g.render() })
await page.locator('.pqv-row').first().locator('.pqv-markcell').click()
await page.locator('.pqv-cellmark input').fill('maybe')
await page.locator('.pqv-cellmark input').press('Enter')
await settle()
await query("review = 'maybe'")
check('single cell marked', await count(), 1)
await query('review IS NOT NULL')
const mdl = await exportAs('csv')
const mcsv = readFileSync(await mdl.path(), 'utf8').trimEnd().split('\r\n')
check('CSV with markers starts with a row column', mcsv[0].split(',')[0], 'row')
check('CSV includes the marker column', mcsv[0].split(',').slice(-1)[0], 'review')
check('CSV marked rows', mcsv.length - 1, expected.region_exact_west + 1)
await clear()

const markStorage = await page.evaluate(() => { try { localStorage.setItem('pqview.t', '1'); return true } catch { return false } })
if (markStorage) {
  await page.evaluate(() => document.querySelector('.pqv').pqview.saveMarks())
  await page.reload()
  await ready(page)
  check('marker column restored after reload', await hcell('review').count(), 1)
  await query("review = 'yes'")
  check('restored marks', await count(), expected.region_exact_west)
  await clear()
} else {
  console.log('SKIP  marker persistence (storage unavailable for file:// pages in this browser)')
}
await markBtn.click()
await page.locator('.pqv-markpanel .pqv-link', { hasText: 'Delete column' }).click()
await page.locator('.pqv-markpanel .pqv-mark-confirm .pqv-link', { hasText: 'Delete' }).click()
await page.keyboard.press('Escape')
await settle()
check('marker column deleted', await hcell('review').count() + await page.locator('.pqv-pitem[data-name="review"]').count(), 0)
await step()
await undoBtn.click()
await step()
check('undo restores a deleted marker column', await hcell('review').count() + await page.locator('.pqv-pitem[data-name="review"]').count(), 2)
check('undo restores its marks', await page.evaluate(() => {
  const p = document.querySelector('.pqv').pqview
  return p.ds.n - p.markers.get('review').nullCount
}) >= expected.region_exact_west, true)
await redoBtn.click()
await step()
check('redo deletes it again', await hcell('review').count(), 0)

// ---- column list: All / None, and the found columns ------------------------
const pact = (text) => page.locator('.pqv-ptop .pqv-link').getByText(text, { exact: true })
const orderBefore = await headNames()
await page.locator('.pqv-ptop input').fill('measure')
check('found bar shows the count', await page.locator('.pqv-pfound .pqv-pcount').innerText(), '10 found')
await pact('Add').click()
await settle()
check('Add ticks only the found columns', (await headNames()).length, orderBefore.length + 10)
await pact('Remove').click()
await settle()
check('Remove unticks only the found columns', (await headNames()).join('|'), orderBefore.join('|'))
await pact('Only').click()
await settle()
check('Only leaves just the found columns', (await headNames()).join('|'), Array.from({ length: 10 }, (_, i) => `measure_${String(i + 1).padStart(2, '0')}`).join('|'))
await pact('All').click()
await settle()
check('All ticks every column despite the search', (await headNames()).length, 30)
await pact('None').click()
await settle()
check('None unticks every column despite the search', (await headNames()).length, 0)
await page.locator('.pqv-ptop input').fill('')
check('found bar hides without a search', await page.locator('.pqv-pfound').isVisible(), false)
await page.evaluate((names) => {
  const p = document.querySelector('.pqv').pqview
  p.picker.setSelected(names)
  p.picker.emit()
}, orderBefore)
await settle()
check('columns restored', (await headNames()).join('|'), orderBefore.join('|'))

// ---- undo / redo -------------------------------------------------------------
await step()
await hcell('age').locator('input').nth(0).fill('30')
await hcell('age').locator('input').nth(1).fill('40')
await step()
check('undo enabled after a change', await undoBtn.isEnabled(), true)
await page.locator('.pqv-pitem[data-name="age"] input[type=checkbox]').uncheck()
await step()
check('unticking a filtered column drops its filter', await count(), expected.total)
await undoBtn.click()
await step()
check('undo brings the column back', await hcell('age').count(), 1)
check('undo brings its filter back', await count(), expected.age_30_40)
check('undo restores the filter inputs', await hcell('age').locator('input').nth(0).inputValue(), '30')
check('column returns to its place', (await headNames()).indexOf('age'), 3)
await undoBtn.click()
await step()
check('second undo removes the filter', await count(), expected.total)
check('filter inputs emptied', await hcell('age').locator('input').nth(0).inputValue(), '')
await redoBtn.click()
await step()
check('redo re-applies the filter', await count(), expected.age_30_40)
await redoBtn.click()
await step()
check('redo unticks the column again', await hcell('age').count(), 0)
check('redo exhausted', await redoBtn.isDisabled(), true)
await page.locator('.pqv-status').click()
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
await step()
check('keyboard undo', await count(), expected.age_30_40)
await query("region = 'West'")
await step()
await hcell('income').locator('.pqv-hname').click()
await step()
await undoBtn.click()
await step()
check('undo removes a sort', await hcell('income').getAttribute('aria-sort'), null)
await undoBtn.click()
await step()
check('undo restores the WHERE text', await page.locator('.pqv-query-input').inputValue(), '')
check('and its rows', await count(), expected.age_30_40)
await clear()

// ---- header filter switch ----------------------------------------------------
await hcell('age').locator('input').nth(0).fill('30')
await hcell('age').locator('input').nth(1).fill('40')
await settle()
check('funnel shown on a filtered column', await hcell('age').locator('.pqv-fbtn:visible').count(), 1)
check('no funnel on other columns', await page.locator('.pqv-fbtn:visible').count(), 1)
await hcell('age').locator('.pqv-fbtn').click()
await settle()
check('funnel switches the filter off', await count(), expected.total)
check('switched-off filter keeps its values', await hcell('age').locator('input').nth(0).inputValue(), '30')
await hcell('age').locator('.pqv-fbtn').click()
await settle()
check('funnel switches it back on', await count(), expected.age_30_40)

// ---- full query --------------------------------------------------------------
await toggleBtn('See Query').click()
await hcell('enrolled').locator('select').selectOption('T')
await option('age', 'invert')
await query("region IN ('West', 'South')")
const before = await count()
const fullText = await page.locator('.pqv-full-text').innerText()
console.log('   ' + fullText.replace(/\n/g, '\n   '))
check('full query lists every part', /age BETWEEN 30 AND 40\) IS NOT TRUE/.test(fullText) && /enrolled = TRUE/.test(fullText) && /region IN/.test(fullText), true)
await page.locator('.pqv-full .pqv-btn', { hasText: 'Edit as WHERE' }).click()
await settle()
await settle()
check('edit as WHERE keeps the same rows', await count(), before)
check('edit as WHERE clears the column filters', await page.locator('.pqv-fbtn:visible').count(), 0)
await clear()
check('full query empty after clear', await page.locator('.pqv-full-text').innerText(), 'No filters: every row is shown.')
await toggleBtn('See Query').click()
check('full query box hidden', await page.locator('.pqv-full').isVisible(), false)

// ---- column list: checkbox only, details, tooltips, drag from the item, resize --
const scoreBox = page.locator('.pqv-pitem[data-name="score"] input[type=checkbox]')
const scoreWas = await scoreBox.isChecked()
await page.locator('.pqv-pitem[data-name="region"] .pqv-pmain').click()
check('clicking an item does not toggle its checkbox', await page.locator('.pqv-pitem[data-name="region"] input[type=checkbox]').isChecked(), true)
check('clicking an item opens its details', await page.locator('.pqv-pitem[data-name="region"] .pqv-pdetail').isVisible(), true)
check('details list every region', await page.locator('.pqv-pitem[data-name="region"] .pqv-dtable tbody tr').count(), 4)
await page.locator('.pqv-pitem[data-name="region"] .pqv-pmain').click()
check('second click closes details', await page.locator('.pqv-pitem[data-name="region"] .pqv-pdetail').isVisible(), false)
await page.locator('.pqv-pitem[data-name="age"] .pqv-pmain').click()
check('number details show a summary', await page.locator('.pqv-pitem[data-name="age"] .pqv-dsum dt', { hasText: 'median' }).count(), 1)
await page.locator('.pqv-pitem[data-name="age"] .pqv-pmain').click()
check('score checkbox untouched', await scoreBox.isChecked(), scoreWas)
await page.locator('.pqv-pitem[data-name="region"]').scrollIntoViewIfNeeded()
await page.locator('.pqv-pitem[data-name="region"] .pqv-pchart svg g').first().hover()
check('chart bar tooltip', /rows \(\d+%\)/.test(await page.locator('.pqv-tip').innerText()) && await page.locator('.pqv-tip').isVisible(), true)
await page.mouse.move(700, 500)
check('tooltip hides', await page.locator('.pqv-tip').isVisible(), false)
// drag an unselected column by its name into the table, before 'comment'
await page.locator('.pqv-pitem[data-name="measure_01"]').scrollIntoViewIfNeeded()
const src2 = await page.locator('.pqv-pitem[data-name="measure_01"] .pqv-pmain').boundingBox()
const dst2 = await page.locator('.pqv-pitem[data-name="comment"]').boundingBox()
await page.mouse.move(src2.x + 30, src2.y + 8)
await page.mouse.down()
await page.mouse.move(src2.x + 30, src2.y - 20, { steps: 4 })
await page.mouse.move(dst2.x + 40, dst2.y + 6, { steps: 15 })
await page.mouse.up()
await settle()
order = await headNames()
check('dragging an unselected column adds it at the drop point', order[order.indexOf('comment') - 1], 'measure_01')
check('dragging did not open its details', await page.locator('.pqv-pitem[data-name="measure_01"] .pqv-pdetail').isVisible(), false)
await page.locator('.pqv-pitem[data-name="measure_01"] input').uncheck()
await settle()
// resize the panel
const w0 = await page.locator('.pqv-picker').evaluate((e) => e.offsetWidth)
const rz = await page.locator('.pqv-presizer').boundingBox()
await page.mouse.move(rz.x + 4, rz.y + 200)
await page.mouse.down()
await page.mouse.move(rz.x + 154, rz.y + 200, { steps: 6 })
await page.mouse.up()
const w1 = await page.locator('.pqv-picker').evaluate((e) => e.offsetWidth)
check('panel resized by dragging its edge', Math.abs(w1 - w0 - 150) <= 3, true)
await page.locator('.pqv-presizer').dblclick()
check('double-clicking the edge toggles the width', await page.locator('.pqv-picker').evaluate((e) => e.offsetWidth), 270)

// ---- counts panel --------------------------------------------------------------
const countsBtn = page.locator('.pqv-toolbar .pqv-btn', { hasText: /^Counts$/ })
const cpanel = page.locator('.pqv-counts')
const csel = (label) => cpanel.locator(`select[aria-label="${label}"]`)
const cwait = () => page.waitForTimeout(400)
const crows = () => cpanel.locator('tbody tr').evaluateAll((trs) => trs.map((tr) =>
  Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.trim())))
const num = (t) => +t.replace(/,/g, '')
const crowOf = (label) => cpanel.locator('tbody tr').filter({ has: page.locator('td.pqv-ck', { hasText: new RegExp(`^${label}$`) }) })
const sorted = (o) => JSON.stringify(Object.entries(o).sort())
// Finds a group by its label(s) through the panel's API: [index, count]
const cgroup = (label) => page.evaluate((label) => {
  const r = document.querySelector('.pqv').pqview.counts.result
  const j = r.groups.findIndex((g) => r.keys.map((k, i) => k.label(i ? g.b : g.a)).join(' ') === label)
  return j < 0 ? null : [j, r.groups[j].count]
}, label)
await clear()
await countsBtn.click()
await cwait()
check('counts panel opens', await cpanel.isVisible(), true)
check('counts button pressed', await countsBtn.getAttribute('aria-pressed'), 'true')
check('counts by the first shown factor at first', await csel('Count rows by').inputValue(), 'state')
await csel('Count rows by').selectOption('region')
await cwait()
let crow = await crows()
check('one row per region', crow.length, 4)
check('region counts match R', sorted(Object.fromEntries(crow.map((r) => [r[0], num(r[1])]))), sorted(expected.counts_region))
check('largest group first', crow[0][0], 'South')
check('shares add to 100%', Math.round(crow.reduce((a, r) => a + parseFloat(r[2]), 0)), 100)
check('counts info line', await cpanel.locator('.pqv-counts-info').innerText(), '4 groups · 100,000 rows')
await cpanel.locator('th button', { hasText: 'Rows' }).click()
check('sorting by rows ascending', (await crows())[0][0], 'Northeast')
await csel('Then by').selectOption('enrolled')
await cwait()
crow = await crows()
check('two columns: every combination, missing included', sorted(Object.fromEntries(crow.map((r) => [`${r[0]} ${r[1]}`, num(r[2])]))), sorted(expected.counts_region_enrolled))
await csel('Then by').selectOption('')
await csel('Value column').selectOption('income')
await cwait()
crow = await crows()
check('mean income per region matches R', sorted(Object.fromEntries(crow.map((r) => [r[0], r[3]]))),
  sorted(Object.fromEntries(Object.entries(expected.mean_income_region).map(([k, v]) => [k, String(v)]))))
check('value column header', await cpanel.locator('thead th').nth(3).innerText(), 'Mean income')
await csel('Value column').selectOption('')
await cwait()

// click a group to keep only it; Exclude hides it
await step()
await crowOf('West').locator('td').first().click()
await settle()
check('clicking a group filters to it', await count(), expected.region_exact_west)
check('the group condition goes into WHERE', await page.locator('.pqv-query-input').inputValue(), "region = 'West'")
await cwait()
check('counts follow the filters', (await crows()).length, 1)
await step()
await undoBtn.click()
await settle()
check('undo removes the group filter', await count(), expected.total)
await cwait()
const westRow = crowOf('West')
await westRow.hover()
await westRow.locator('.pqv-counts-ex').click()
await settle()
check('Exclude hides the group', await count(), expected.total - expected.region_exact_west)
check('exclude condition', await page.locator('.pqv-query-input').inputValue(), "region != 'West'")
await query("age > 30 OR age IS NULL")
const beforeGroup = await count()
await cwait()
await crowOf('South').locator('td').first().click()
await settle()
check('a group adds to an existing WHERE with brackets', await page.locator('.pqv-query-input').inputValue(), "(age > 30 OR age IS NULL) AND region = 'South'")
check('rows after adding a group', await count() < beforeGroup, true)
await clear()

// dates by month, numbers in ranges, date-times by local hour
await csel('Count rows by').selectOption('visit_date')
await cwait()
await csel('Group values of the first column by').selectOption('month')
await cwait()
check('months of visit_date, plus missing', await page.evaluate(() => document.querySelector('.pqv').pqview.counts.result.groups.length), expected.visit_months)
check('June 2023 visits', (await cgroup('2023-06'))[1], expected.visit_2023_06)
await csel('Count rows by').selectOption('income')
await cwait()
check('incomes fall in ranges by default', await csel('Group values of the first column by').inputValue(), 'range')
check('incomes under 100,000', (await cgroup('[0, 100000)'))[1], expected.income_under_100k)
await csel('Count rows by').selectOption('updated_at')
await cwait()
await csel('Group values of the first column by').selectOption('hour')
await cwait()
const dstHour = await cgroup('2024-03-10 01:00')
check('the hour before clocks went forward', dstHour && dstHour[1], expected.updated_dst_hour)
await page.evaluate((j) => document.querySelector('.pqv').pqview.counts.drill(j, false), dstHour[0])
await settle()
check('filtering to that hour finds the same rows', await count(), expected.updated_dst_hour)
await clear()

// copy and download the counts
await csel('Count rows by').selectOption('region')
await cwait()
const [cdl] = await Promise.all([page.waitForEvent('download'), cpanel.locator('.pqv-btn', { hasText: 'CSV' }).click()])
check('counts CSV file name', cdl.suggestedFilename(), 'Synthetic_demo_counts.csv')
const ccsv = readFileSync(await cdl.path(), 'utf8').trimEnd().split('\r\n')
check('counts CSV header', ccsv[0], 'region,rows,percent')
check('counts CSV rows', ccsv.length, 5)
if (engine === 'chromium') {
  await cpanel.locator('.pqv-btn', { hasText: 'Copy' }).click()
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  check('counts copied as tab-separated text', clip.split(/\r?\n/)[0], 'region\trows\tpercent')
}
if (shots) await page.screenshot({ path: `${shots}/${engine}-06-counts.png` })
await cpanel.locator('.pqv-btn[aria-label="Close the Counts panel"]').click()
check('counts panel closes', await cpanel.isVisible(), false)
check('counts button released', await countsBtn.getAttribute('aria-pressed'), 'false')

// ---- views ----------------------------------------------------------------------
const viewsBtn = page.locator('.pqv-toolbar .pqv-viewsbtn')
const vpanel = page.locator('.pqv-viewspanel')
const openViews = async () => {
  if (!(await vpanel.isVisible())) await viewsBtn.click()
}
const applyView = async (name) => {
  await openViews()
  await vpanel.locator('.pqv-view-apply').filter({ has: page.locator('.pqv-view-name', { hasText: new RegExp(`^${name}$`) }) }).click()
  await settle()
  await step()
}
await openViews()
check('views from R are listed', (await vpanel.locator('.pqv-view-name').allInnerTexts()).join('|'), 'Older West|Region by enrolment')
await applyView('Older West')
check('R view: rows', await count(), expected.view_older_west)
check('R view: columns', (await headNames()).join('|'), 'record_id|state|region|age|income|enrolled')
check('R view: sorted by income, largest first', (await firstRow())[1], expected.view_older_west_first)
check('R view: WHERE shown', await page.locator('.pqv-query-input').inputValue(), "age >= 65 AND region = 'West'")
check('Views button names the current view', await viewsBtn.innerText(), 'View: Older West')
await hcell('age').locator('input').nth(0).fill('70')
await settle()
await step()
check('changing a filter leaves the view', await viewsBtn.innerText(), 'Views')
const c70 = await count()
await openViews()
await vpanel.locator('input[aria-label="View name"]').fill('Seventy')
await vpanel.locator('.pqv-btn', { hasText: 'Save' }).click()
check('view saved', await vpanel.locator('.pqv-mark-msg').innerText(), "Saved 'Seventy'.")
check('saved view listed', (await vpanel.locator('.pqv-view-name').allInnerTexts()).join('|'), 'Older West|Region by enrolment|Seventy')
check('saved view is current', await vpanel.locator('.pqv-view-on .pqv-view-name').innerText(), 'Seventy')
const rCode = await page.evaluate(() => document.querySelector('.pqv').pqview.views.rCode())
check('R code for the view', rCode, [
  '"Seventy" = pqview_view(',
  '  columns = c("record_id", "state", "region", "age", "income", "enrolled"),',
  '  where = "age >= 70 AND (age >= 65 AND region = \'West\')",',
  '  sort = "-income"',
  ')',
].join('\n'))
await page.keyboard.press('Escape')
await applyView('Region by enrolment')
check('view with counts: all rows', await count(), expected.total)
check('view with counts: default columns', (await headNames()).length, 10)
await cwait()
check('view with counts opens the panel', await cpanel.isVisible(), true)
check('view with counts: two columns', (await crows()).length, 12)
check('view with counts is current', await viewsBtn.innerText(), 'View: Region by enrolment')
await cpanel.locator('.pqv-btn[aria-label="Close the Counts panel"]').click()
await page.waitForTimeout(400)
check('closing its counts leaves the view', await viewsBtn.innerText(), 'Views')
await applyView('Seventy')
check('saved view restores rows', await count(), c70)
check('saved view restores the column filter', await hcell('age').locator('input').nth(0).inputValue(), '70')
await undoBtn.click()
await settle()
check('undo goes back to the previous view', await count(), expected.total)
await step()
await redoBtn.click()
await settle()
check('redo returns to the saved view', await count(), c70)
if (markStorage) {
  await page.reload()
  await ready(page)
  await openViews()
  check('saved view kept after reload', (await vpanel.locator('.pqv-view-name').allInnerTexts()).includes('Seventy'), true)
  await applyView('Seventy')
  check('saved view works after reload', await count(), c70)
  check('restored filter after reload', await hcell('age').locator('input').nth(0).inputValue(), '70')
} else {
  console.log('SKIP  view persistence (storage unavailable for file:// pages in this browser)')
}
await openViews()
const myView = vpanel.locator('.pqv-view').filter({ has: page.locator('.pqv-view-name', { hasText: /^Seventy$/ }) })
await myView.locator('.pqv-link', { hasText: 'Rename' }).click()
await vpanel.locator('input[aria-label="New name for Seventy"]').fill('Over seventy')
await vpanel.locator('input[aria-label="New name for Seventy"]').press('Enter')
check('view renamed', (await vpanel.locator('.pqv-view-name').allInnerTexts()).join('|'), 'Older West|Region by enrolment|Over seventy')
const renamed = vpanel.locator('.pqv-view').filter({ has: page.locator('.pqv-view-name', { hasText: /^Over seventy$/ }) })
await renamed.locator('.pqv-link', { hasText: 'Delete' }).click()
await renamed.locator('.pqv-link.pqv-danger', { hasText: 'Delete' }).click()
check('view deleted', (await vpanel.locator('.pqv-view-name').allInnerTexts()).join('|'), 'Older West|Region by enrolment')
await page.keyboard.press('Escape')
if (await cpanel.isVisible()) await cpanel.locator('.pqv-btn[aria-label="Close the Counts panel"]').click()
await applyView('Older West')
await page.locator('.pqv-query-input').fill('')
await page.locator('.pqv-query-input').press('Enter')
await clear()
const defaultCols = ['record_id', 'state', 'region', 'age', 'income', 'score', 'enrolled', 'visit_date', 'updated_at', 'comment']
await page.evaluate(async (cols) => {
  const p = document.querySelector('.pqv').pqview
  p.picker.setSelected(cols)
  p.picker.emit()
}, defaultCols)
await settle()

// ---- row panel -------------------------------------------------------------------
const dpanel = page.locator('.pqv-detail')
const dvalue = (name) => dpanel.locator('.pqv-detail-item').filter({ has: page.locator('.pqv-detail-cname', { hasText: new RegExp(`^${name}$`) }) }).locator('.pqv-detail-value').innerText()
const rowNum = (k) => page.locator('.pqv-pinrows .pqv-row').nth(k).locator('.pqv-rownum')
await page.evaluate(async () => {
  const p = document.querySelector('.pqv').pqview
  p.state.sort = []
  p.grid.setSort([])
  await p.runQuery()
  p.grid.scroller.scrollTop = 0
  p.grid.scroller.scrollLeft = 0
  p.grid.render()
})
check('row panel closed at first', await dpanel.isVisible(), false)
await rowNum(0).click()
await settle()
check('clicking a row number opens the row panel', await dpanel.isVisible(), true)
check('row panel title', await dpanel.locator('.pqv-detail-title').innerText(), 'Row 1')
check('row panel place in the rows', await dpanel.locator('.pqv-detail-where').innerText(), '1 of 100,000 shown')
check('row panel value', await dvalue('record_id'), 'R000001')
await page.waitForTimeout(400)
check('row panel reads columns not in the table', /^\d/.test(await dvalue('measure_01')), true)
check('row panel: every column listed', await dpanel.locator('.pqv-detail-item').count(), 30)
check('the row is highlighted in the table', await page.locator('.pqv-pinrows .pqv-row.pqv-current .pqv-rownum').innerText(), '1')
await dpanel.locator('button[aria-label="Next row"]').click()
check('next row', await dpanel.locator('.pqv-detail-title').innerText(), 'Row 2')
await page.keyboard.press('ArrowDown')
check('down key steps to the next row', await dpanel.locator('.pqv-detail-title').innerText(), 'Row 3')
await page.keyboard.press('ArrowUp')
check('up key steps back', await dvalue('record_id'), 'R000002')
await dpanel.locator('input[aria-label="Find column in this row"]').fill('measure')
check('find a column in the row panel', await dpanel.locator('.pqv-detail-item:visible').count(), 10)
await dpanel.locator('input[aria-label="Find column in this row"]').fill('')
const fullIncome = await page.evaluate(() => {
  const p = document.querySelector('.pqv').pqview
  return String(p.ds.peek('score').num[1])
})
check('row panel shows full precision', await dvalue('score'), fullIncome)
if (engine === 'chromium') {
  await dpanel.locator('.pqv-btn', { hasText: 'Copy' }).click()
  await page.waitForTimeout(300)
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  check('row copied as name and value lines', clip.split(/\r?\n/)[0], 'record_id\tR000002')
  check('row copy has every column', clip.trimEnd().split(/\r?\n/).length, 30)
}
await query("region = 'West'")
check('row panel: row filtered out', await dpanel.locator('.pqv-detail-where').innerText(), 'Not in the filtered rows')
check('row panel: no next row outside the filter', await dpanel.locator('button[aria-label="Next row"]').isDisabled(), true)
await page.locator('.pqv-rows .pqv-row').first().locator('.pqv-cell').first().click()
await settle()
check('while open, clicking a row shows it', await dvalue('region'), 'West')
check('row panel follows the filtered rows', await dpanel.locator('.pqv-detail-where').innerText(), `1 of ${expected.region_exact_west.toLocaleString('en-US')} shown`)
await page.keyboard.press('Escape')
check('Escape closes the row panel', await dpanel.isVisible(), false)
check('no row highlighted after closing', await page.locator('.pqv-row.pqv-current').count(), 0)
await rowNum(0).click()
await rowNum(0).click()
check('clicking the same row number again closes it', await dpanel.isVisible(), false)
await clear()

// ---- pinned columns ----------------------------------------------------------------
const pinBtn = (name) => hcell(name).locator('.pqv-pinbtn')
const sortBy = async (name) => {
  await hcell(name).locator('.pqv-hname').click()
  await settle()
}
const pinOrder = await headNames()
await hcell('income').hover()
await pinBtn('income').click()
await settle()
let order2 = await headNames()
check('pinning moves the column to the left', order2[0], 'income')
check('pinned column marked', await hcell('income').evaluate((e) => e.classList.contains('pqv-hpin')), true)
await hcell('comment').hover()
await pinBtn('comment').click()
await settle()
order2 = await headNames()
check('second pinned column follows the first', order2.slice(0, 2).join('|'), 'income|comment')
check('picker follows the table order', (await pickNames('.pqv-psel')).slice(0, 2).join('|'), 'income|comment')
const pinX = await hcell('comment').evaluate((e) => e.getBoundingClientRect().left)
await page.evaluate(() => { const g = document.querySelector('.pqv').pqview.grid; g.scroller.scrollLeft = 600; g.render() })
await settle()
check('pinned header stays put when scrolling sideways', Math.abs(await hcell('comment').evaluate((e) => e.getBoundingClientRect().left) - pinX) < 1, true)
const pinCellX = await page.locator('.pqv-pinrows .pqv-row').first().locator('.pqv-cell').nth(2).evaluate((e) => e.getBoundingClientRect().left)
check('pinned cells stay under their header', Math.abs(pinCellX - pinX) < 1, true)
check('pinned layer shows the right values', await page.locator('.pqv-pinrows .pqv-row').first().locator('.pqv-cell').nth(0).innerText(), '1')
check('scrolled columns are drawn too', await page.locator('.pqv-rows:not(.pqv-pinrows) .pqv-row').first().locator('.pqv-cell').count() > 0, true)
await page.evaluate(() => { const g = document.querySelector('.pqv').pqview.grid; g.scroller.scrollLeft = 0; g.render() })
await sortBy('income')
check('sorting a pinned column', (await firstRow())[1], String(+(await page.evaluate(() => Math.min(...document.querySelector('.pqv').pqview.ds.peek('income').num.filter((v) => v === v)))).toPrecision(7)))
await sortBy('income')
await sortBy('income')
await step()
await hcell('income').hover()
await pinBtn('income').click()
await settle()
order2 = await headNames()
check('unpinned column goes after the pinned ones', order2.slice(0, 2).join('|'), 'comment|income')
await step()
await undoBtn.click()
await settle()
check('undo pins it again', (await headNames()).slice(0, 2).join('|'), 'income|comment')
check('undo restores the pin marks', await hcell('income').evaluate((e) => e.classList.contains('pqv-hpin')), true)
check('R code includes pinned columns', /pin = c\("income", "comment"\)/.test(await page.evaluate(() => document.querySelector('.pqv').pqview.views.rCode())), true)
await page.evaluate(() => { const p = document.querySelector('.pqv').pqview; p.togglePin('income'); p.togglePin('comment') })
await settle()
await page.evaluate(async (cols) => {
  const p = document.querySelector('.pqv').pqview
  p.picker.setSelected(cols)
  p.picker.emit()
}, pinOrder)
await settle()
check('no pinned columns left', await page.locator('.pqv-hcell.pqv-hpin[data-name]').count(), 0)

// ---- number formats ------------------------------------------------------------
await page.evaluate(() => { const g = document.querySelector('.pqv').pqview.grid; g.scroller.scrollTop = 0; g.scroller.scrollLeft = 0; g.render() })
const incomeIdx = (await headNames()).indexOf('income') + 1
const incomeBefore = (await firstRow())[incomeIdx]
await hcell('income').locator('.pqv-opt').click()
await page.locator('.pqv-opts select[aria-label="income decimals"]').selectOption('2')
await page.locator('.pqv-opt-format input[type=checkbox]').check()
check('format options stay open while changing', await page.locator('.pqv-opts').isVisible(), true)
await page.keyboard.press('Escape')
await settle()
const incomeRaw = await page.evaluate(() => { const p = document.querySelector('.pqv').pqview; return p.ds.peek('income').num[p.state.view[0]] })
const want = incomeRaw.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
check('income shown with 2 decimals and separators', (await firstRow())[incomeIdx], want)
check('format leaves filters alone', await count(), expected.total)
await hcell('income').locator('input').nth(0).fill('100000')
await settle()
check('filters still use plain numbers', await count(), expected.total - expected.income_under_100k - expected.income_na)
await clear()
await step()
await undoBtn.click()
await settle()
await undoBtn.click()
await settle()
check('undo removes the format', (await firstRow())[incomeIdx], incomeBefore)
await redoBtn.click()
await settle()
await redoBtn.click()
await settle()
check('redo brings it back', (await firstRow())[incomeIdx], want)
await clear()

// ---- Shiny inputs -------------------------------------------------------------------
const shinyIn = await page.evaluate(async () => {
  const sent = {}
  window.Shiny = { setInputValue: (k, v) => { sent[k] = v } }
  const el = document.querySelector('.pqv')
  el.id = 'tbl'
  const p = el.pqview
  await p.runQuery()
  p.openDetail(4)
  await new Promise((r) => setTimeout(r, 500))
  const out = { rows: sent.tbl_rows.length, first: sent.tbl_rows[0], state: sent.tbl_state, row: sent.tbl_row }
  p.closeDetail()
  out.closed = sent.tbl_row
  delete window.Shiny
  el.removeAttribute('id')
  return out
})
check('Shiny: filtered row numbers', shinyIn.rows, expected.total)
check('Shiny: row numbers count from 1', shinyIn.first, 1)
check('Shiny: state', [shinyIn.state.rows_shown, shinyIn.state.rows_total, shinyIn.state.columns.length].join(), `${expected.total},${expected.total},10`)
check('Shiny: open row', shinyIn.row, 5)
check('Shiny: closed row', shinyIn.closed, null)

// ---- theme and mono switches persist across reloads ------------------------
const themeBtn = page.locator('.pqv-prefs .pqv-pref-icon')
await themeBtn.click() // auto -> light
await themeBtn.click() // light -> dark
check('theme switched to dark', await pqv.getAttribute('data-theme'), 'dark')
const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
check('page background follows the theme', bodyBg !== 'rgb(255, 255, 255)' && bodyBg !== 'rgba(0, 0, 0, 0)', true)
const monoFont = await page.locator('.pqv-cell').first().evaluate((e) => getComputedStyle(e).fontFamily)
check('mono font in use', /mono|Menlo|Consolas/i.test(monoFont), true)
await toggleBtn('Mono').click()
await settle()
const cellFont = await page.locator('.pqv-cell').first().evaluate((e) => getComputedStyle(e).fontFamily)
check('Mono switch turns it off', /mono|Menlo|Consolas/i.test(cellFont), false)
if (shots) await page.screenshot({ path: `${shots}/${engine}-04-dark-mono.png` })
await page.reload()
await ready(page)
const storage = await page.evaluate(() => { try { localStorage.setItem('pqview.t', '1'); return true } catch { return false } })
if (storage) {
  check('theme remembered after reload', await pqv.getAttribute('data-theme'), 'dark')
  check('mono choice remembered after reload', await pqv.evaluate((e) => e.classList.contains('pqv-mono')), false)
} else {
  console.log('SKIP  preference persistence (storage unavailable for file:// pages in this browser)')
}
await themeBtn.click() // dark -> auto
await toggleBtn('Mono').click()

// query bar can be hidden with the WHERE switch
await toggleBtn('WHERE').click()
check('query bar hidden', await page.locator('.pqv-querybar').isVisible(), false)
await toggleBtn('WHERE').click()

// ---- scrolling ----------------------------------------------------------
const scroll = await page.evaluate(() => {
  const g = document.querySelector('.pqv').pqview.grid
  const max = g.scroller.scrollHeight - g.scroller.clientHeight
  const times = []
  for (let k = 0; k < 200; k++) {
    g.scroller.scrollTop = Math.random() * max
    const t = performance.now()
    g.render()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  g.scroller.scrollTop = max
  g.render()
  const lastRow = g.pinEl.lastChild.firstChild.textContent
  g.scroller.scrollTop = 0
  return { median: +times[100].toFixed(2), p95: +times[190].toFixed(2), lastRow }
})
console.log('render per scroll frame (ms):', JSON.stringify(scroll))
check('scrolling reaches the last row', scroll.lastRow, '100000')

// ---- sort and counts given in R ----------------------------------------------
const remount = await page.evaluate(async () => {
  const el = document.querySelector('.pqv')
  const x = JSON.parse(document.querySelector('script[type="application/json"][data-for]').textContent).x
  const api = window.PQView.mount(el, { ...x, sort: [{ name: 'income', dir: 'desc' }], counts: ['region'], pin: ['comment'] })
  await api.ready
  await new Promise((resolve) => setTimeout(resolve, 500))
  return {
    open: !el.querySelector('.pqv-counts').hidden,
    groups: api.counts.result ? api.counts.result.groups.length : null,
    sort: api.state.sort.map((s) => s.name + ' ' + s.dir).join(),
    pinned: api.state.pinned.join(),
    first: api.state.cols[0].name,
  }
})
check('sort from R applied at start', remount.sort, 'income desc')
check('pin from R applied at start', remount.pinned + ' ' + remount.first, 'comment comment')
check('counts from R open the panel', remount.open, true)
check('counts from R: one row per region', remount.groups, 4)
check('first row is the largest income', (await firstRow())[6], String(+expected.top_income.toPrecision(7)))

// ---- narrow screen --------------------------------------------------------
const narrow = await browser.newContext({ viewport: { width: 420, height: 800 } })
const npage = await narrow.newPage()
await npage.goto(url)
await ready(npage)
if (shots) await npage.screenshot({ path: `${shots}/${engine}-05-narrow.png` })
check('no page-level horizontal scroll at 420px', await npage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)

check('no console errors', errors.length, 0)
if (errors.length) console.log(errors.slice(0, 5).join('\n'))
const passed = results.filter(Boolean).length
console.log(`\n${engine}: ${passed}/${results.length} checks passed`)
await browser.close()
process.exit(passed === results.length ? 0 : 1)
