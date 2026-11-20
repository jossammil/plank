// Builds the public website into site-dist/ (published to the public
// jossammil/plank repository by tools/publish-site.sh):
//   index.html   the landing page, from site/index.template.html
//   demo.html    the 100,000-row Plank demo (examples/demo.html, from make-demo.R)
//   viewer.html  the blank viewer (examples/viewer.plank.html)
// The about text and the shortcuts come from src/keys.js, so the site always
// matches the app; the numbers come from site/bench.json.
// Run from the srcjs folder: node tools/build-site.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ABOUT, SHORTCUTS, GRID_KEYS } from '../src/keys.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const at = (p) => path.join(root, p)
const out = at('site-dist')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const FEATURES = [
  ['One file, no server', 'Data, code and styles in a single .plank.html that opens by double-click, offline.'],
  ['Filters on every column', 'Ranges, lists, text and regular expressions, with NOT for "everything but".'],
  ['SQL WHERE', 'Type a condition such as age > 30 AND region IN (\'West\'); See Query shows every filter combined.'],
  ['Counts', 'Grouped counts by one or two columns, with value bars; click a group to filter to it.'],
  ['Row panel and search', 'Every field of a row at a glance, plus a search across the visible columns.'],
  ['Saved views', 'Name a state of the table and come back to it, or copy it as R code.'],
  ['Export', 'The filtered rows as CSV, Excel, R data or parquet, or copied to the clipboard.'],
  ['Open your own files', 'CSV, TSV, Excel and parquet, each in its own tab, read in the browser and never uploaded.'],
  ['Password protection', 'AES-256 encryption from R; the browser asks for the password before showing anything.'],
  ['Keyboard and command palette', 'A cell cursor, block selection with sums, single-key jumps and Ctrl/⌘ K for any action.'],
  ['Themes', 'Auto, Classic, Modern, Dark, Vintage and Starship, with your own accent, text colour, fonts and shapes.'],
  ['Made from R', 'plank(df) in RStudio or Shiny; save_plank(df, "name") writes the file.'],
]

const bench = JSON.parse(readFileSync(at('site/bench.json'), 'utf8'))
const r = bench.r
const o = bench.open || {}
const fmtMB = (x) => (x >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.?0+$/, '') + ' MB'
const fmtS = (x) => x.toFixed(2) + ' s'

const bars = [['Excel', r.xlsx.mb, 'excel'], ['Plank file', r.plank.mb, ''], ['Plank, zipped', r.zip.mb, '']]
const max = Math.max(...bars.map((b) => b[1]))
const barsHtml = bars.map(([label, mb, cls]) =>
  `      <div class="bar-row"><span>${esc(label)}</span><span class="bar-track"><span class="bar ${cls}" style="width:${(mb / max * 100).toFixed(1)}%"></span></span><span class="num">${fmtMB(mb)}</span></div>`).join('\n')

const row = (label, a, b, win = 'b') =>
  `          <tr><th scope="row">${esc(label)}</th><td class="num${win === 'a' ? ' win' : ''}">${esc(a)}</td><td class="num${win === 'b' ? ' win' : ''}">${esc(b)}</td></tr>`
const speedRows = [
  row('File size', fmtMB(r.xlsx.mb), fmtMB(r.plank.mb)),
  row('Zipped for email', 'already compressed', fmtMB(r.zip.mb)),
  row('Time to save from R', fmtS(r.xlsx.write_s), fmtS(r.plank.write_s)),
  row('With a password', 'not built in', `${fmtS(r.locked.write_s)}, ${fmtMB(r.locked.mb)}`),
  row('Opens in any browser', 'no, needs Excel', o.page_s ? `yes, table in ${fmtS(o.page_s)}` : 'yes'),
].join('\n')

const v = o.viewer_s || {}
const openRows = [['Parquet', r.parquet_mb, v.parquet], ['CSV', r.csv_mb, v.csv], ['Excel (.xlsx)', r.xlsx.mb, v.xlsx]]
  .filter((x) => x[2] != null)
  .map(([kind, mb, s]) => `          <tr><th scope="row">${esc(kind)}</th><td class="num">${fmtMB(mb)}</td><td class="num">${fmtS(s)}</td></tr>`)
  .join('\n')

const keyRows = (rows) => rows.map(([key, what]) =>
  `      <tr><td><kbd>${esc(key)}</kbd></td><td>${esc(what)}</td></tr>`).join('\n')

const demo = at('examples/demo.html')
const viewer = at('examples/viewer.plank.html')
for (const f of [demo, viewer]) {
  if (!existsSync(f)) throw new Error(`Missing ${path.relative(root, f)}: run Rscript examples/make-demo.R and examples/make-viewer.R first.`)
}
const version = JSON.parse(readFileSync(at('srcjs/package.json'), 'utf8')).version

const fill = {
  ABOUT_PLAIN: esc(`${ABOUT.lead} ${ABOUT.file}`),
  ABOUT_HTML: `${esc(ABOUT.lead)} ${esc(ABOUT.file).replace('A plank file', 'A <b>plank file</b>')} <em>${esc(ABOUT.credit)}</em>`,
  DEMO_MB: (statSync(demo).size / 1e6).toFixed(1),
  FEATURES: FEATURES.map(([t, d]) => `      <li><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join('\n'),
  ROWS: r.rows.toLocaleString('en-US'),
  COLS: String(r.cols),
  MEASURED: esc(r.measured),
  MACHINE: esc(r.machine.replace(/^Darwin arm64/, 'an Apple-silicon Mac,')),
  BROWSER: esc(o.browser || 'Chrome'),
  XLSX_MB: r.xlsx.mb, PLANK_MB: r.plank.mb, ZIP_MB: r.zip.mb,
  BARS: barsHtml,
  SPEED_ROWS: speedRows,
  OPEN_ROWS: openRows,
  SHORTCUTS: keyRows(SHORTCUTS.map((s) => [s[1], s[2]])),
  GRID_KEYS: keyRows(GRID_KEYS),
  VERSION: esc(version),
  CREDIT: esc(ABOUT.credit),
}
let html = readFileSync(at('site/index.template.html'), 'utf8')
html = html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
  if (!(k in fill)) throw new Error(`Unknown placeholder ${m}`)
  return fill[k]
})

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, 'index.html'), html)
copyFileSync(demo, path.join(out, 'demo.html'))
copyFileSync(viewer, path.join(out, 'viewer.html'))
writeFileSync(path.join(out, '.nojekyll'), '')
writeFileSync(path.join(out, 'README.md'), `# Plank

${ABOUT.lead} ${ABOUT.file} *${ABOUT.credit}*

This repository is the public website, <https://jossammil.github.io/plank/>:

- \`index.html\`: about, features, size and speed, keyboard shortcuts
- \`demo.html\`: the Plank demo, 100,000 fake records with 30 columns of every type
- \`viewer.html\`: a blank viewer for your own CSV, TSV, Excel and parquet files

It is generated; please do not edit it by hand.
`)
console.log(`site-dist: index.html, demo.html (${fill.DEMO_MB} MB), viewer.html (Plank ${version})`)
