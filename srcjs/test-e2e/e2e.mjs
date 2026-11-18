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
const toggleBtn = (text) => page.locator('.pqv-switches .pqv-toggle').getByText(text, { exact: true })
// Picks a choice in the Appearance window, opening it first if needed.
const lookBtn = page.locator('.pqv-header .pqv-pref')
const lookPanel = page.locator('.pqv-appearance')
const pickLook = async (group, value) => {
  if (!(await lookPanel.isVisible())) await lookBtn.click()
  await lookPanel.locator(`.pqv-ap-group[aria-label="${group}"] .pqv-ap-choice[data-value="${value}"]`).click()
}
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
check('compact top band: toolbar within 48px of the top', toolbarTop > 20 && toolbarTop <= 48, true)
check('page marked standalone', await pqv.evaluate((e) => e.classList.contains('pqv-standalone')), true)
check('monospace font by default', await pqv.evaluate((e) => e.classList.contains('pqv-mono')), true)
const titleTop = await page.locator('.pqv-header .pqv-title').evaluate((e) => e.getBoundingClientRect().top)
check('a little room above the title (4-16px)', titleTop >= 4 && titleTop <= 16, true)
check('no Wider/Narrower button', await page.locator('.pqv-picker button', { hasText: /Wider|Narrower/ }).count(), 0)
check('title in the top band', await page.locator('.pqv-header .pqv-title').innerText(), 'Synthetic demo')
check('notes beside the title', /100,000 synthetic records/.test(await page.locator('.pqv-header .pqv-notes').innerText()), true)
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
const pact = (text) => page.locator('.pqv-ptop > .pqv-pactions:not(.pqv-pfound) .pqv-link').getByText(text, { exact: true })
const fact = (text) => page.locator('.pqv-pfound .pqv-link').getByText(text, { exact: true })
const orderBefore = await headNames()
await page.locator('.pqv-ptop input').fill('measure')
check('found bar shows the count', await page.locator('.pqv-pfound .pqv-pcount').innerText(), '10 found')
check('found bar reads count · All · None · Only', (await page.locator('.pqv-pfound').innerText()).replace(/\s+/g, ' ').trim(), '10 found · All · None · Only')
await fact('All').click()
await settle()
check('found All ticks only the found columns', (await headNames()).length, orderBefore.length + 10)
await fact('None').click()
await settle()
check('found None unticks only the found columns', (await headNames()).join('|'), orderBefore.join('|'))
await fact('Only').click()
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
// R rounds to 7 significant digits; the panel shows every mean with the same decimals
check('mean income per region matches R', sorted(Object.fromEntries(crow.map((r) => [r[0], num(r[3])]))),
  sorted(expected.mean_income_region))
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

// ---- theme and font choices persist across reloads ------------------------
await pickLook('Theme', 'dark')
check('theme switched to dark', await pqv.getAttribute('data-theme'), 'dark')
const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
check('page background follows the theme', bodyBg !== 'rgb(255, 255, 255)' && bodyBg !== 'rgba(0, 0, 0, 0)', true)
const monoFont = await page.locator('.pqv-cell').first().evaluate((e) => getComputedStyle(e).fontFamily)
check('mono font in use', /mono|Menlo|Consolas/i.test(monoFont), true)
await pickLook('Font', 'sans')
await settle()
const cellFont = await page.locator('.pqv-cell').first().evaluate((e) => getComputedStyle(e).fontFamily)
check('Sans font turns monospace off', /mono|Menlo|Consolas/i.test(cellFont), false)
if (shots) await page.screenshot({ path: `${shots}/${engine}-04-dark-sans.png` })
await page.keyboard.press('Escape')
await page.reload()
await ready(page)
const storage = await page.evaluate(() => { try { localStorage.setItem('pqview.t', '1'); return true } catch { return false } })
if (storage) {
  check('theme remembered after reload', await pqv.getAttribute('data-theme'), 'dark')
  check('font choice remembered after reload', await pqv.evaluate((e) => e.classList.contains('pqv-mono')), false)
} else {
  console.log('SKIP  preference persistence (storage unavailable for file:// pages in this browser)')
}
await pickLook('Theme', 'auto')
await pickLook('Font', 'mono')
await page.keyboard.press('Escape')

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

// ---- top band, toolbar order and the Appearance window ------------------------
await page.reload()
await ready(page)
const box = (loc) => loc.boundingBox()
{
  const searchBox = await box(page.locator('.pqv-toolbar .pqv-search'))
  const colsBox = await box(page.locator('.pqv-toolbar > .pqv-btn').first())
  const whereBox = await box(toggleBtn('WHERE'))
  const fullBox = await box(toggleBtn('See Query'))
  check('toolbar: Columns starts the toolbar', /^Columns/.test(await page.locator('.pqv-toolbar > .pqv-btn').first().innerText()), true)
  check('toolbar: Columns, WHERE, See Query left of the search box',
    colsBox.x + colsBox.width <= whereBox.x && whereBox.x + whereBox.width <= fullBox.x && fullBox.x + fullBox.width <= searchBox.x, true)
  const rights = await page.locator('.pqv-toolbar button:visible').evaluateAll((els) =>
    els.map((e) => ({ views: e.classList.contains('pqv-viewsbtn'), right: e.getBoundingClientRect().right })))
  const maxRight = Math.max(...rights.map((r) => r.right))
  check('toolbar: Views is the right-most control', rights.find((r) => r.views).right, maxRight)
  const exportBox = await box(page.locator('.pqv-toolbar .pqv-btn', { hasText: 'Export' }))
  const undoBox = await box(undoBtn)
  check('toolbar: undo, Counts, Mark, Export to the right of the search', undoBox.x > searchBox.x + searchBox.width && exportBox.x > undoBox.x, true)
}

// the row count sits in the top band, left of the data size
check('row count left the toolbar', await page.locator('.pqv-toolbar .pqv-status').count(), 0)
const status = page.locator('.pqv-header .pqv-status')
check('row count in the top band', await status.innerText(), '100,000 rows')
check('row count keeps role=status', await status.getAttribute('role'), 'status')
{
  const sBox = await box(status)
  const dBox = await box(page.locator('.pqv-sizes .pqv-size').first())
  check('row count just left of DATA', sBox.x + sBox.width <= dBox.x && dBox.x - (sBox.x + sBox.width) < 40, true)
  check('row count on the line of the sizes', Math.abs((sBox.y + sBox.height / 2) - (dBox.y + dBox.height / 2)) <= 4, true)
}
await page.locator('.pqv-search').fill('Alaska')
await settle()
check('row count updates when filtering', await status.innerText(), `${expected.search_alaska.toLocaleString('en-US')} of 100,000 rows`)
await page.locator('.pqv-search').fill('')
await settle()

// notes fit on a wide screen: no expand button
check('notes fit: no expand button', await page.locator('.pqv-notes-more').isVisible(), false)

// the Appearance window
check('Appearance button labelled', await lookBtn.getAttribute('aria-label'), 'Appearance')
await lookBtn.click()
check('Appearance window opens', await lookPanel.isVisible(), true)
check('Appearance button expanded', await lookBtn.getAttribute('aria-expanded'), 'true')
check('Appearance window is a dialog', await lookPanel.getAttribute('role'), 'dialog')
check('focus moves to the chosen theme', await page.evaluate(() => document.activeElement.dataset.value), 'auto')
{
  const pBox = await box(lookPanel)
  const bBox = await box(lookBtn)
  check('Appearance window sits below its button', pBox.y >= bBox.y + bBox.height, true)
}
for (const theme of ['classic', 'modern', 'dark', 'vintage', 'terminal', 'auto']) {
  await pickLook('Theme', theme)
  check(`preset ${theme} sets data-theme`, await pqv.getAttribute('data-theme'), theme)
}
check('one preset checked', await lookPanel.locator('.pqv-ap-themes [aria-checked="true"]').count(), 1)
// arrow keys move the theme choice
await lookPanel.locator('.pqv-ap-themes [aria-checked="true"]').focus()
await page.keyboard.press('ArrowRight')
check('arrow key picks the next theme', await pqv.getAttribute('data-theme'), 'classic')
await pickLook('Theme', 'terminal')
const toolbarFont = await page.locator('.pqv-toolbar > .pqv-btn').first().evaluate((e) => getComputedStyle(e).fontFamily)
check('Terminal: toolbar in monospace', /mono|Menlo|Consolas/i.test(toolbarFont), true)
check('Terminal: font setting disabled', await lookPanel.locator('.pqv-ap-group[aria-label="Font"] .pqv-ap-choice').first().isDisabled(), true)
check('Terminal: monospace note shown', await lookPanel.locator('.pqv-ap-note').isVisible(), true)
if (shots) await page.screenshot({ path: `${shots}/${engine}-06-terminal.png` })
await pickLook('Accent colour', 'pink')
check('accent colour applied', await pqv.getAttribute('data-accent'), 'pink')
const pinkDark = await pqv.evaluate((e) => getComputedStyle(e).getPropertyValue('--pqv-accent').trim())
await pickLook('Theme', 'classic')
const pinkLight = await pqv.evaluate((e) => getComputedStyle(e).getPropertyValue('--pqv-accent').trim())
check('accent has a light and a dark shade', pinkDark !== pinkLight && !!pinkLight, true)
await pickLook('Accent colour', '')
check('theme default accent', await pqv.getAttribute('data-accent'), null)
await page.keyboard.press('Escape')
check('Escape closes the Appearance window', await lookPanel.count(), 0)
check('focus returns to the Appearance button', await lookBtn.evaluate((e) => e === document.activeElement), true)
await lookBtn.click()
await lookBtn.click()
check('the button closes the window again', await lookPanel.count(), 0)
await lookBtn.click()
await page.locator('.pqv-gridwrap').click({ position: { x: 400, y: 300 } })
check('an outside click closes the window', await lookPanel.count(), 0)

// font, text size and row spacing change the table
const cellStyle = () => page.locator('.pqv-rows:not(.pqv-pinrows) .pqv-cell').first().evaluate((e) => {
  const cs = getComputedStyle(e)
  return { font: cs.fontFamily, size: cs.fontSize, row: e.parentNode.getBoundingClientRect().height }
})
const lookBefore = await cellStyle()
await pickLook('Font', 'serif')
await pickLook('Text size', 'large')
await pickLook('Row spacing', 'roomy')
await settle()
const lookAfter = await cellStyle()
check('serif font in the table', /Palatino|Georgia|Iowan|serif/i.test(lookAfter.font) && !/mono/i.test(lookAfter.font), true)
check('larger text in the table', parseFloat(lookAfter.size) > parseFloat(lookBefore.size), true)
check('roomy rows are taller', lookAfter.row, 32)
check('Appearance window stays open while changing settings', await lookPanel.isVisible(), true)
{
  const aligned = await page.evaluate(() => {
    const g = document.querySelector('.pqv').pqview.grid
    g.scroller.scrollTop = 5000
    g.render()
    const pin = g.pinEl.firstChild.getBoundingClientRect().top
    const row = g.rowsEl.firstChild.getBoundingClientRect().top
    g.scroller.scrollTop = g.scroller.scrollHeight
    g.render()
    const last = g.pinEl.lastChild.firstChild.textContent
    g.scroller.scrollTop = 0
    g.render()
    return { same: Math.abs(pin - row) < 0.5, last }
  })
  check('roomy rows: pinned layer stays aligned when scrolling', aligned.same, true)
  check('roomy rows: scrolling reaches the last row', aligned.last, '100000')
}
await pickLook('Text size', 'small')
await pickLook('Row spacing', 'compact')
await settle()
const lookSmall = await cellStyle()
check('smaller text in the table', parseFloat(lookSmall.size) < parseFloat(lookBefore.size), true)
check('compact rows are shorter', lookSmall.row, 22)
if (shots) await page.screenshot({ path: `${shots}/${engine}-07-serif-compact.png` })
await page.keyboard.press('Escape')
if (storage) {
  await page.reload()
  await ready(page)
  const kept = await cellStyle()
  check('font kept after reload', /Palatino|Georgia|Iowan|serif/i.test(kept.font), true)
  check('text size kept after reload', kept.size, lookSmall.size)
  check('row spacing kept after reload', kept.row, 22)
  // saved choices from older versions still count
  await page.evaluate(() => {
    for (const k of ['font', 'size', 'density', 'accent']) localStorage.removeItem('pqview.' + k)
    localStorage.setItem('pqview.theme', 'light')
    localStorage.setItem('pqview.mono', '0')
  })
  await page.reload()
  await ready(page)
  check('old theme "light" becomes Classic', await pqv.getAttribute('data-theme'), 'classic')
  check('old Mono off becomes the sans font', await pqv.getAttribute('data-font'), 'sans')
}
await lookBtn.click()
await lookPanel.locator('.pqv-link', { hasText: 'Reset to defaults' }).click()
check('reset: theme back to auto', await pqv.getAttribute('data-theme'), 'auto')
check('reset: font back to mono', await pqv.getAttribute('data-font'), 'mono')
check('reset: normal row height', (await cellStyle()).row, 26)
await page.keyboard.press('Escape')

// top_offset from R adds its pixels above the band; the band is always
// shown, even without a title or notes and outside a page of its own
{
  const offset = await page.evaluate(async () => {
    const el = document.querySelector('.pqv')
    const x = JSON.parse(document.querySelector('script[type="application/json"][data-for]').textContent).x
    const top = () => el.querySelector('.pqv-toolbar').getBoundingClientRect().top
    await window.PQView.mount(el, { ...x, top_offset: 0 }).ready
    const t0 = top()
    await window.PQView.mount(el, { ...x, top_offset: 40 }).ready
    const t40 = top()
    await window.PQView.mount(el, x).ready
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:400px'
    document.body.append(host)
    const { title, notes, ...plain } = x
    await window.PQView.mount(host, plain).ready
    const header = host.querySelector('.pqv-header')
    const out = {
      diff: Math.round(t40 - t0),
      shown: !!header && header.getBoundingClientRect().height > 0,
      count: header ? header.querySelector('.pqv-status').textContent : '',
      standalone: host.classList.contains('pqv-standalone'),
    }
    host.pqview.destroy()
    host.remove()
    return out
  })
  check('top_offset adds its pixels above the band', offset.diff, 40)
  check('band shown without title or notes, inside a page', offset.shown && !offset.standalone, true)
  check('band holds the row count there', offset.count, '100,000 rows')
}

// narrow screens: three toolbar rows, the notes button and the window fit
{
  const smallCtx = await browser.newContext({ viewport: { width: 375, height: 812 } })
  const spage = await smallCtx.newPage()
  await spage.goto(url)
  await ready(spage)
  check('no page-level horizontal scroll at 375px', await spage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  const top = (sel) => spage.locator(sel).first().evaluate((e) => Math.round(e.getBoundingClientRect().top))
  const row1 = await top('.pqv-toolbar > .pqv-btn')
  check('375px: WHERE and See Query on the first row', [await top('.pqv-switches')].every((t) => Math.abs(t - row1) <= 2), true)
  check('375px: Views on the first row', Math.abs((await top('.pqv-viewsbtn')) - row1) <= 2, true)
  const row2 = await top('.pqv-searchgroup')
  const row3 = await top('.pqv-undo')
  check('375px: search on its own row, actions below', row2 > row1 + 20 && row3 > row2 + 20, true)
  check('375px: Export on the actions row', Math.abs((await top('.pqv-toolbar .pqv-btn:text("Export")')) - row3) <= 2, true)
  const overlap = await spage.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.pqv-toolbar > *, .pqv-header .pqv-status, .pqv-header .pqv-size, .pqv-header .pqv-pref'))
      .filter((e) => e.offsetParent !== null && !e.classList.contains('pqv-tsep')).map((e) => e.getBoundingClientRect())
    for (let a = 0; a < els.length; a++) {
      for (let b = a + 1; b < els.length; b++) {
        const p = els[a]
        const q = els[b]
        if (p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1) return true
      }
    }
    return els.some((r) => r.right > window.innerWidth + 0.5)
  })
  check('375px: nothing in the band or toolbar overlaps', overlap, false)
  const more = spage.locator('.pqv-notes-more')
  check('375px: long notes get an expand button', await more.isVisible(), true)
  check('expand button starts collapsed', await more.getAttribute('aria-expanded'), 'false')
  await more.click()
  check('expand button expands the notes', await more.getAttribute('aria-expanded'), 'true')
  check('expanded notes wrap', await spage.locator('.pqv-notes').evaluate((e) => getComputedStyle(e).whiteSpace), 'pre-line')
  check('expand button now says less', await more.innerText(), 'less')
  await more.click()
  check('collapses again', await more.getAttribute('aria-expanded'), 'false')
  await spage.locator('.pqv-header .pqv-pref').click()
  const pop = await spage.locator('.pqv-appearance').boundingBox()
  check('375px: Appearance window fits on screen', pop.x >= 0 && pop.x + pop.width <= 375 && pop.y + pop.height <= 812, true)
  if (shots) await spage.screenshot({ path: `${shots}/${engine}-08-narrow-appearance.png` })
  await smallCtx.close()
}

// ---- column list: All / None on the group headings ---------------------------
{
  const gsel = page.locator('.pqv-pgroup', { has: page.locator('.pqv-pgroup-link', { hasText: 'None' }) })
  const gother = page.locator('.pqv-pgroup', { has: page.locator('.pqv-pgroup-link', { hasText: 'All' }) })
  const selNone = gsel.locator('.pqv-pgroup-link')
  const otherAll = gother.locator('.pqv-pgroup-link')
  const findBox = page.locator('.pqv-ptop input')
  const fileOrder = await page.evaluate(() => document.querySelector('.pqv').pqview.picker.fileOrder.slice())
  const setCols = async (names) => {
    await page.evaluate((n) => {
      const p = document.querySelector('.pqv').pqview
      p.picker.setSelected(n)
      p.picker.emit()
    }, names)
    await settle()
  }
  const pcount = () => page.locator('.pqv-ptop > .pqv-pactions:not(.pqv-pfound) .pqv-pcount').innerText()
  await findBox.fill('')
  await setCols(['comment', 'age', 'region'])
  check('group headings show their links', [await selNone.isVisible(), await otherAll.isVisible()].join(), 'true,true')
  check('In table None title', await selNone.getAttribute('title'), 'Remove the 3 columns in the table')
  check('Other All title', await otherAll.getAttribute('title'), `Add the ${fileOrder.length - 3} other columns to the table, in file order`)
  await selNone.click()
  await settle()
  check('In table None empties the table header', (await headNames()).length, 0)
  check('In table None: picker count updates', await pcount(), `0 of ${fileOrder.length} selected`)
  check('In table None: every column back in file order', (await pickNames('.pqv-plist .pqv-pgroup-list:not(.pqv-psel)')).join('|'), fileOrder.join('|'))
  check('headings hide when nothing is in the table', await page.locator('.pqv-pgroup:visible').count(), 0)

  await setCols(['comment', 'age'])
  await otherAll.click()
  await settle()
  const appended = ['comment', 'age'].concat(fileOrder.filter((n) => n !== 'comment' && n !== 'age'))
  check('Other All appends the others in file order', (await headNames()).join('|'), appended.join('|'))
  check('Other All: picker count updates', await pcount(), `${fileOrder.length} of ${fileOrder.length} selected`)
  check('Other columns heading hides when it is empty', await gother.isVisible(), false)
  check('focus moves to In table None after Other All', await page.evaluate(() => document.activeElement?.textContent), 'None')

  // with a search typed, the links act on just the found columns
  const base = ['comment', 'age', 'measure_02', 'measure_05', 'region']
  await setCols(base)
  await findBox.fill('measure')
  await settle()
  check('search: In table None title', await selNone.getAttribute('title'), 'Remove the 2 found columns in the table')
  check('search: Other All title', await otherAll.getAttribute('title'), 'Add the 8 found columns not in the table, in file order')
  await selNone.click()
  await settle()
  check('search: In table None removes only found columns', (await headNames()).join('|'), 'comment|age|region')
  check('search: In table heading hides with no found columns in it', await gsel.isVisible(), false)
  await setCols(['comment', 'measure_04'])
  await findBox.fill('measure')
  await settle()
  await otherAll.click()
  await settle()
  const measures = fileOrder.filter((n) => n.startsWith('measure') && n !== 'measure_04')
  check('search: Other All appends only found columns', (await headNames()).join('|'), ['comment', 'measure_04'].concat(measures).join('|'))
  check('search: Other All link hides when it would do nothing', await otherAll.isVisible(), false)
  check('search: other columns untouched', (await headNames()).includes('age'), false)

  // keyboard, and the list keeps its scroll position
  await findBox.fill('')
  await setCols(fileOrder.slice(0, 15))
  const plist = page.locator('.pqv-plist')
  // scroll into the Other columns group, so its heading is stuck at the top
  await plist.evaluate((e) => {
    const head = e.querySelector('.pqv-pgroup-list.pqv-psel + .pqv-pgroup')
    e.scrollTop = head.getBoundingClientRect().top - e.getBoundingClientRect().top + e.scrollTop + 120
  })
  const top0 = await plist.evaluate((e) => e.scrollTop)
  await otherAll.focus()
  await page.keyboard.press('Enter')
  await settle()
  check('Other All by keyboard', (await headNames()).length, fileOrder.length)
  check('list keeps its scroll position', Math.abs(await plist.evaluate((e) => e.scrollTop) - top0) <= 30, true)
  // focus moved to the In table None link, so Enter again removes them all
  await page.keyboard.press('Enter')
  await settle()
  check('In table None by keyboard', (await headNames()).length, 0)
  check('focus stays in the column list', await page.evaluate(() => !!document.activeElement?.closest('.pqv-picker')), true)
  check('list does not jump to the top', await plist.evaluate((e) => e.scrollTop) > 0, true)
  if (shots) await page.screenshot({ path: `${shots}/${engine}-picker-groups.png` })
}

// ---- counts: bars for the value, resizable columns, shared decimals ---------
{
  if (!(await cpanel.isVisible())) await countsBtn.click()
  await cwait()
  await csel('Count rows by').selectOption('region')
  await csel('Value column').selectOption('income')
  await csel('Statistic').selectOption('mean')
  await cwait()
  const barsBox = cpanel.locator('.pqv-counts-bars')
  const barsOn = () => barsBox.locator('button[aria-pressed="true"]').innerText()
  // Per row: the group, the value text, the width of the value cell's bar and whether the % cell has one.
  const vbars = () => cpanel.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => {
    const bar = tr.querySelector('td.pqv-cv .pqv-cbar')
    return {
      label: tr.querySelector('td.pqv-ck').innerText.trim(),
      value: tr.querySelector('td.pqv-cv').innerText.trim(),
      w: bar ? bar.getBoundingClientRect().width : null,
      neg: !!(bar && bar.classList.contains('pqv-cbar-neg')),
      pctBar: !!tr.querySelector('td.pqv-cp .pqv-cbar'),
    }
  }))
  const decimals = (rows) => Array.from(new Set(rows.map((r) => (r.value.split('.')[1] || '').length)))
  check('Bars choice shown with a value column', await barsBox.isVisible(), true)
  check('bars show the value by default', await barsOn(), 'Value')
  let vb = await vbars()
  check('value bars: one bar in each value cell, none in %', vb.every((r) => r.w > 0 && !r.pctBar), true)
  const widest = vb.reduce((a, r) => (r.w > a.w ? r : a)).label
  const largest = Object.entries(expected.mean_income_region).reduce((a, e) => (e[1] > a[1] ? e : a))[0]
  check('the widest bar is the group with the largest mean', widest, largest)
  check('every mean shows the same decimals', decimals(vb).join(), '2')
  await barsBox.locator('button', { hasText: 'Rows' }).click()
  vb = await vbars()
  check('Rows moves the bars back to the % cells', vb.every((r) => r.w === null && r.pctBar), true)
  check('Rows is pressed', await barsOn(), 'Rows')

  // a saved view keeps the Bars choice
  await openViews()
  await vpanel.locator('input[aria-label="View name"]').fill('Bars by rows')
  await vpanel.locator('.pqv-btn', { hasText: 'Save' }).click()
  await page.keyboard.press('Escape')
  await barsBox.locator('button', { hasText: 'Value' }).click()
  check('Value is pressed again', await barsOn(), 'Value')
  await applyView('Bars by rows')
  await cwait()
  check('a saved view keeps the Bars choice', await barsOn(), 'Rows')
  check('the view saved bars: rows', await page.evaluate(() => document.querySelector('.pqv').pqview.counts.config().bars), 'rows')
  await barsBox.locator('button', { hasText: 'Value' }).click()

  // negative statistics: bars diverge from a zero line
  await csel('Value column').selectOption('score')
  await csel('Statistic').selectOption('min')
  await cwait()
  vb = await vbars()
  check('a negative minimum gets a bar of its own colour', vb.filter((r) => r.neg).map((r) => r.label).join(), 'South')
  check('the zero line is drawn in every value cell', await cpanel.locator('td.pqv-cv .pqv-czero').count(), vb.length)
  check('minimum scores share their decimals', decimals(vb).join(), '4')
  const south = await crowOf('South').evaluate((tr) => {
    const bar = tr.querySelector('td.pqv-cv .pqv-cbar').getBoundingClientRect()
    const zero = tr.querySelector('td.pqv-cv .pqv-czero').getBoundingClientRect()
    return Math.abs(bar.right - (zero.left + zero.width / 2))
  })
  check('the negative bar ends at the zero line', south < 1.5, true)
  if (shots) await cpanel.screenshot({ path: `${shots}/${engine}-07-counts-negative.png` })
  await csel('Value column').selectOption('income')
  await csel('Statistic').selectOption('mean')
  await cwait()

  // drag the right edge of the Rows header
  const rowsTh = cpanel.locator('thead th[data-col="count"]')
  const thWidth = () => rowsTh.evaluate((e) => e.getBoundingClientRect().width)
  const sortState = () => rowsTh.getAttribute('aria-sort')
  const sort0 = await sortState()
  const w0 = await thWidth()
  const gb = await rowsTh.locator('.pqv-ccol-grip').boundingBox()
  const gx = gb.x + gb.width / 2
  const gy = gb.y + gb.height / 2
  await page.mouse.move(gx, gy)
  await page.mouse.down()
  await page.mouse.move(gx + 30, gy, { steps: 3 })
  await page.mouse.move(gx + 60, gy, { steps: 3 })
  await page.mouse.up()
  const w1 = await thWidth()
  check('dragging a header edge widens that column by the drag', Math.abs(w1 - w0 - 60) <= 2, true)
  check('the table switches to fixed widths', await cpanel.locator('table.pqv-counts-fixed').count(), 1)
  check('the handle does not sort', await sortState(), sort0)
  await query("region != 'West'")
  await cwait()
  check('recounted after the filter', (await crows()).length, 3)
  check('the width survives a recount', Math.round(await thWidth()), Math.round(w1))
  await cpanel.locator('th button', { hasText: 'Rows' }).click()
  check('the width survives sorting', Math.round(await thWidth()), Math.round(w1))
  await rowsTh.locator('.pqv-ccol-grip').focus()
  await page.keyboard.press('ArrowLeft')
  check('arrow keys resize too', Math.round(await thWidth()), Math.round(w1) - 10)
  await rowsTh.locator('.pqv-ccol-grip').dblclick()
  check('double-click goes back to automatic widths', await cpanel.locator('table.pqv-counts-fixed').count(), 0)
  await page.mouse.move(gx, gy)
  await page.mouse.down()
  await page.mouse.move(gx + 40, gy, { steps: 3 })
  await page.mouse.up()
  await csel('Then by').selectOption('enrolled')
  await cwait()
  check('widths reset when the columns change', await cpanel.locator('table.pqv-counts-fixed').count(), 0)
  await csel('Then by').selectOption('')
  await cwait()
  await query('')
}

// ---- export: missing values as ----------------------------------------------
// RFC 4180 reader that remembers which cells were quoted.
const parseCSV = (text) => {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  let inQuotes = false
  const end = () => {
    row.push({ v: cell, q: quoted })
    cell = ''
    quoted = false
  }
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]
    if (inQuotes) {
      if (ch !== '"') cell += ch
      else if (text[k + 1] === '"') cell += text[++k]
      else inQuotes = false
    } else if (ch === '"') {
      inQuotes = quoted = true
    } else if (ch === ',') {
      end()
    } else if (ch === '\r' && text[k + 1] === '\n') {
      end()
      rows.push(row)
      row = []
      k++
    } else {
      cell += ch
    }
  }
  return rows
}
const openExport = () => page.locator('.pqv-toolbar .pqv-btn', { hasText: 'Export' }).click()
const setMissing = async (mode, custom) => {
  await openExport()
  await page.locator('.pqv-export-na-mode').selectOption(mode)
  if (custom !== undefined) await page.locator('.pqv-export-na-text').fill(custom)
  await page.keyboard.press('Escape')
}
const csvColumn = async (name) => {
  const d = await exportAs('csv')
  const text = readFileSync(await d.path(), 'utf8')
  const rows = parseCSV(text)
  const k = rows[0].findIndex((c) => c.v === name)
  return { text, rows, cells: rows.slice(1).map((r) => r[k]) }
}
await page.reload()
await ready(page)
await query("region = 'West'")
const westNulls = await page.evaluate(() => {
  const api = document.querySelector('.pqv').pqview
  const nulls = (name) => {
    const col = api.ds.peek(name)
    let k = 0
    for (const i of api.state.view) k += col.isNull[i]
    return k
  }
  return { income: nulls('income'), comment: nulls('comment') }
})
check('missing values: West has missing incomes and comments', westNulls.income > 0 && westNulls.comment > 0, true)

await openExport()
const naSelect = page.locator('.pqv-export-na-mode')
check('missing values: Empty by default', await naSelect.inputValue(), 'empty')
check('missing values: select is labelled', await naSelect.evaluate((e) => e.labels[0].textContent), 'Missing values as')
check('missing values: options', (await naSelect.locator('option').allInnerTexts()).join('|'), 'Empty|NA|NULL|Custom')
check('missing values: note on R and parquet', /R data and parquet keep real missing values/.test(await page.locator('.pqv-export-na-note').innerText()), true)
check('missing values: no custom box until Custom', await page.locator('.pqv-export-na-text').isVisible(), false)
// keyboard: Tab from the last format reaches the select
await page.locator('.pqv-export-item[data-format="clip"]').focus()
await page.keyboard.press('Tab')
check('missing values: select reachable by Tab', await naSelect.evaluate((e) => e === document.activeElement), true)
await page.keyboard.press('Escape')

await setMissing('NA')
const estTitle = await page.locator('.pqv-sizes .pqv-size').nth(1).getAttribute('title')
check('missing values: export estimate knows the setting', /written as "NA"/.test(estTitle), true)
let naCsv = await csvColumn('income')
check('missing values NA: CSV rows', naCsv.rows.length - 1, expected.region_exact_west)
check('missing values NA: missing incomes are NA', naCsv.cells.filter((c) => c.v === 'NA' && !c.q).length, westNulls.income)
check('missing values NA: no blank incomes', naCsv.cells.filter((c) => c.v === '').length, 0)
naCsv = await csvColumn('comment')
check('missing values NA: missing comments are NA', naCsv.cells.filter((c) => c.v === 'NA' && !c.q).length, westNulls.comment)
check('missing values NA: no blank comments', naCsv.cells.filter((c) => c.v === '').length, 0)

await setMissing('custom', 'n/a, missing')
await openExport()
check('missing values: custom box shown for Custom', await page.locator('.pqv-export-na-text').isVisible(), true)
await page.keyboard.press('Escape')
const customCsv = await csvColumn('income')
check('missing values custom: every row has every column', customCsv.rows.every((r) => r.length === customCsv.rows[0].length), true)
check('missing values custom: quoted because of the comma', customCsv.cells.filter((c) => c.v === 'n/a, missing' && c.q).length, westNulls.income)
check('missing values custom: raw text quoted', customCsv.text.includes('"n/a, missing"'), true)

if (storage) {
  await page.reload()
  await ready(page)
  await openExport()
  check('missing values: choice remembered after reload', await naSelect.inputValue(), 'custom')
  check('missing values: custom text remembered after reload', await page.locator('.pqv-export-na-text').inputValue(), 'n/a, missing')
  await page.keyboard.press('Escape')
  await query("region = 'West'")
} else {
  console.log('SKIP  missing-value setting persistence (storage unavailable for file:// pages in this browser)')
}

await setMissing('empty')
const emptyCsv = await csvColumn('income')
check('missing values Empty: missing incomes are blank', emptyCsv.cells.filter((c) => c.v === '' && !c.q).length, westNulls.income)
check('missing values Empty: no NA text', emptyCsv.text.includes('NA,'), false)

// the menu with the setting fits a phone screen
const phone = await browser.newContext({ viewport: { width: 375, height: 760 } })
const ppage = await phone.newPage()
await ppage.goto(url)
await ready(ppage)
await ppage.locator('.pqv-toolbar .pqv-btn', { hasText: 'Export' }).click()
await ppage.locator('.pqv-export-na-mode').selectOption('custom')
const fit = await ppage.evaluate(() => {
  const r = document.querySelector('.pqv-exportmenu').getBoundingClientRect()
  const box = document.querySelector('.pqv-export-na-text').getBoundingClientRect()
  return { inside: r.left >= 0 && r.right <= window.innerWidth, box: box.right <= r.right && box.width >= 40, scroll: document.documentElement.scrollWidth <= window.innerWidth }
})
if (shots) await ppage.screenshot({ path: `${shots}/${engine}-06-export-missing-375.png` })
check('missing values: menu fits at 375px', fit.inside && fit.box, true)
check('missing values: no horizontal scroll at 375px', fit.scroll, true)
await phone.close()

check('no console errors', errors.length, 0)
if (errors.length) console.log(errors.slice(0, 5).join('\n'))
const passed = results.filter(Boolean).length
console.log(`\n${engine}: ${passed}/${results.length} checks passed`)
await browser.close()
process.exit(passed === results.length ? 0 : 1)
