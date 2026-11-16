// End-to-end test of examples/demo.html in a real browser.
//
//   Rscript examples/make-demo.R            # from the package root
//   cd srcjs && npm run e2e                 # Chromium (or installed Chrome)
//   BROWSER=webkit npm run e2e              # WebKit, Safari's engine
//
// Row counts are compared with examples/demo-expected.json, which R writes
// alongside the demo by applying the same filters to the data frame.

import { chromium, webkit } from 'playwright'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
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
  return page.locator('.pqv-row').first().locator('.pqv-cell').allInnerTexts()
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
check('rows in DOM are virtualised (< 80)', (await page.locator('.pqv-row').count()) < 80, true)

// ---- standalone top offset ------------------------------------------------
const toolbarTop = await page.locator('.pqv-toolbar').evaluate((e) => e.getBoundingClientRect().top)
check('toolbar sits below the top offset (>= 56px)', toolbarTop >= 56, true)
check('page marked standalone', await pqv.evaluate((e) => e.classList.contains('pqv-standalone')), true)
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

// ---- CSV export ---------------------------------------------------------
await query("region = 'West'")
const estText = await page.locator('.pqv-sizes .pqv-size').nth(1).locator('.pqv-size-v').innerText()
const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.pqv-btn', { hasText: 'Export CSV' }).click()])
const csvBytes = readFileSync(await download.path())
const csv = csvBytes.toString('utf8').trimEnd().split('\r\n')
check('CSV rows = filtered rows', csv.length - 1, expected.region_exact_west)
const est = (() => { const m = /([\d.]+) (KB|MB)/.exec(estText); return +m[1] * (m[2] === 'MB' ? 1048576 : 1024) })()
console.log(`   export estimate ${estText}, actual ${(csvBytes.length / 1048576).toFixed(2)} MB`)
check('export size estimate within 5%', Math.abs(est - csvBytes.length) / csvBytes.length < 0.05, true)
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
const [mdl] = await Promise.all([page.waitForEvent('download'), page.locator('.pqv-btn', { hasText: 'Export CSV' }).click()])
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
await page.locator('.pqv-query-row .pqv-toggle', { hasText: 'Full query' }).click()
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
await page.locator('.pqv-query-row .pqv-toggle', { hasText: 'Full query' }).click()
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
await page.locator('.pqv-pwide').click()
check('Wider/Narrower button toggles width', await page.locator('.pqv-picker').evaluate((e) => e.offsetWidth), 270)

// ---- theme and mono switches persist across reloads ------------------------
const themeBtn = page.locator('.pqv-switches .pqv-icon')
await themeBtn.click() // auto -> light
await themeBtn.click() // light -> dark
check('theme switched to dark', await pqv.getAttribute('data-theme'), 'dark')
const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
check('page background follows the theme', bodyBg !== 'rgb(255, 255, 255)' && bodyBg !== 'rgba(0, 0, 0, 0)', true)
await page.locator('.pqv-switches .pqv-toggle', { hasText: 'Mono' }).click()
await settle()
const cellFont = await page.locator('.pqv-cell').first().evaluate((e) => getComputedStyle(e).fontFamily)
check('mono font applied', /mono|Menlo|Consolas/i.test(cellFont), true)
if (shots) await page.screenshot({ path: `${shots}/${engine}-04-dark-mono.png` })
await page.reload()
await ready(page)
const storage = await page.evaluate(() => { try { localStorage.setItem('pqview.t', '1'); return true } catch { return false } })
if (storage) {
  check('theme remembered after reload', await pqv.getAttribute('data-theme'), 'dark')
  check('mono remembered after reload', await pqv.evaluate((e) => e.classList.contains('pqv-mono')), true)
} else {
  console.log('SKIP  preference persistence (storage unavailable for file:// pages in this browser)')
}
await themeBtn.click() // dark -> auto
await page.locator('.pqv-switches .pqv-toggle', { hasText: 'Mono' }).click()

// query bar can be hidden
await page.locator('.pqv-switches .pqv-toggle', { hasText: 'Query' }).click()
check('query bar hidden', await page.locator('.pqv-querybar').isVisible(), false)
await page.locator('.pqv-switches .pqv-toggle', { hasText: 'Query' }).click()

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
  const lastRow = g.rowsEl.lastChild.firstChild.textContent
  g.scroller.scrollTop = 0
  return { median: +times[100].toFixed(2), p95: +times[190].toFixed(2), lastRow }
})
console.log('render per scroll frame (ms):', JSON.stringify(scroll))
check('scrolling reaches the last row', scroll.lastRow, '100000')

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
