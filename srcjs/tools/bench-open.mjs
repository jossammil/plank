// Opening times for the public site: the plank file from examples/bench.R
// opened in Chrome (first table drawn), and the blank viewer opening the same
// data as parquet, CSV and xlsx. Adds them to site/bench.json.
// Run after `Rscript examples/bench.R`, from the srcjs folder:
//   node tools/bench-open.mjs
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bench = path.join(root, 'examples/bench')
const out = path.join(root, 'site/bench.json')
const runs = 3
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
const ready = (p) => p.waitForFunction(() => {
  const s = document.querySelector('.pqv-shell')
  const t = s && s.plank && s.plank.timings
  return t && t.firstTable
}, null, { timeout: 60000, polling: 10 })

// the plank file itself: from navigation to the first table drawn
const page = []
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  const t0 = Date.now()
  await p.goto(pathToFileURL(path.join(bench, 'data.plank.html')).href)
  await ready(p)
  page.push((Date.now() - t0) / 1000)
  await ctx.close()
}

// the blank viewer opening each kind of file
const viewer = pathToFileURL(path.join(root, 'examples/viewer.plank.html')).href
const open = {}
for (const [kind, file] of [['parquet', 'data.parquet'], ['csv', 'data.csv'], ['xlsx', 'data.xlsx']]) {
  const times = []
  for (let i = 0; i < runs; i++) {
    const ctx = await browser.newContext()
    const p = await ctx.newPage()
    await p.goto(viewer)
    await p.locator('.pqv-blank-open').waitFor()
    const chooser = p.waitForEvent('filechooser')
    await p.locator('.pqv-blank-open').click()
    const t0 = Date.now()
    await (await chooser).setFiles(path.join(bench, file))
    await ready(p)
    times.push((Date.now() - t0) / 1000)
    await ctx.close()
  }
  open[kind] = +median(times).toFixed(2)
}
await browser.close()

const data = JSON.parse(readFileSync(out, 'utf8'))
data.open = { measured: new Date().toISOString().slice(0, 10), browser: 'Chrome', page_s: +median(page).toFixed(2), viewer_s: open }
writeFileSync(out, JSON.stringify(data, null, 2) + '\n')
console.log(JSON.stringify(data, null, 2))
