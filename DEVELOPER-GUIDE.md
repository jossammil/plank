# Plank developer guide

How the package works inside, which program does what, how to change and
rebuild each part, and how to debug it. Read it top to bottom once; after
that, the section headings work as a reference.

Contents

1. [The big picture](#1-the-big-picture)
2. [Repository map](#2-repository-map)
3. [The R side](#3-the-r-side)
4. [The bridge: htmlwidgets](#4-the-bridge-htmlwidgets)
5. [The browser side](#5-the-browser-side)
6. [Libraries and why each is there](#6-libraries-and-why-each-is-there)
7. [Tools you need, and the build cycle](#7-tools-you-need-and-the-build-cycle)
8. [How to update things](#8-how-to-update-things)
9. [Tests](#9-tests)
10. [Continuous integration and publishing](#10-continuous-integration-and-publishing)
11. [Debugging](#11-debugging)
12. [Glossary](#12-glossary)

---

## 1. The big picture

Plank is two programs in one package:

- **R code** turns a data frame into compressed **parquet** bytes and hands
  them to **htmlwidgets** as a JSON payload.
- **JavaScript code** (bundled into one file) runs in the reader's browser,
  decodes the parquet, and draws the viewer: column list, filters, query
  bar, table, Counts, exports and so on.

There is no server. A saved file is one HTML page that carries the data
(base64 text inside a `<script type="application/json">` tag), the viewer's
JavaScript and its CSS.

```
 R session                                   Browser (no server)
 ─────────                                   ───────────────────
 plank(df)                                  page loads
   │ encode_data()  df ──► parquet bytes       │ htmlwidgets finds the JSON payload
   │   (nanoparquet, gzip level 3)             │ calls Plank.mount(el, x)
   │ optional: encrypt_payload() (openssl)     │   shell: tabs, file opening
   │ x = { data: base64, meta, title, ... }    │   mountInstance: one viewer
   ▼                                           │     decodeBase64 → openDataset (hyparquet)
 htmlwidgets::createWidget("plank", x)        │     columns decoded on demand → column store
   │                                           │     filters/query/sort → view (row indices)
   ├─ print: RStudio viewer / browser tab      │     Grid draws only the visible cells
   ├─ R Markdown / Quarto chunk                ▼
   ├─ Shiny output (renderPlank)            exports are written in the browser too
   └─ save_plank(): one self-contained .html (CSV, Excel, .rds, parquet, clipboard)
```

The design rule behind everything: **do the work once in R (encoding), and
everything interactive in the browser**, so the result is a plain file
anyone can open.

---

## 2. Repository map

```
plank-app/
├── DESCRIPTION, NAMESPACE, LICENSE      R package metadata (NAMESPACE is generated)
├── R/                                   the R package code
│   ├── plank.R      plank() (builds the payload), Shiny bindings, all main docs
│   ├── encode.R      data frame → parquet bytes + per-column hints (meta)
│   ├── encrypt.R     password protection: PBKDF2, AES-256-CTR, HMAC
│   ├── save.R        save_plank(): one self-contained HTML file (or .zip)
│   ├── views.R       plank_view() and checks for sort/pin/formats/views
│   └── addin.R       RStudio add-in ("View in Plank")
├── man/                                 help pages (generated from R/ by roxygen2)
├── tests/testthat/                      R tests
├── inst/
│   ├── htmlwidgets/plank.js            the htmlwidgets binding (a few lines)
│   ├── htmlwidgets/plank.yaml          declares the JS + CSS dependency and its version
│   ├── htmlwidgets/lib/plank/
│   │   ├── plank-core.js               the BUILT JavaScript bundle (generated, committed)
│   │   └── plank.css                   the stylesheet (hand-written, NOT bundled)
│   ├── rstudio/addins.dcf               registers the add-in
│   └── COPYRIGHTS                       licences of the bundled JS libraries
├── srcjs/                               JavaScript sources (excluded from the R package)
│   ├── package.json, package-lock.json  npm dependencies and scripts
│   ├── build.mjs                        esbuild: src/ → inst/.../plank-core.js
│   ├── src/*.js                         the viewer's modules (section 5)
│   ├── test/*.test.js                   unit tests (node:test) + fixtures/
│   └── test-e2e/e2e.mjs                 end-to-end tests in a real browser (Playwright)
├── examples/
│   ├── demo-data.R                      the synthetic data set (any size)
│   ├── make-demo.R                      writes demo.html (100k rows), demo-locked.html,
│   │                                    and demo-expected.json (counts R computed)
│   ├── make-viewer.R                    writes viewer.plank.html (blank), kept in git
│   ├── bench.R                          size and speed numbers for the site (R side)
│   └── *.html                           generated pages (only viewer.plank.html is committed)
├── site/                                the public website: index template and bench.json
├── tools/publish-site.sh                builds the site and pushes it to the public repo
├── .github/workflows/                   CI: R-CMD-check.yaml, js.yaml
├── README.md                            user documentation
└── DEVELOPER-GUIDE.md                   this file
```

Generated files you should never edit by hand: `NAMESPACE`, `man/*.Rd`,
`inst/htmlwidgets/lib/plank/plank-core.js`, `examples/*.html`,
`examples/demo-expected.json`.

---

## 3. The R side

### What `plank(data, ...)` does

`R/plank.R`, in order:

1. **Checks the arguments** (`match.arg`, `stopifnot`, `check_names_arg`).
2. `data = NULL` → returns a **blank viewer** payload (no data; the reader
   opens files in it) and stops here.
3. **`encode_data()`** (`R/encode.R`) turns the data into parquet bytes:
   - a `.parquet` path is embedded as-is when its compression is one the
     browser reads (gzip, snappy, none) and it has no nested columns;
     otherwise it is read and rewritten;
   - a data frame goes through `prepare_frame()` (fixes names, factors,
     labelled vectors, difftimes, list columns; collects per-column hints:
     factor `levels`, time zone `tz`, `label`, R `class`) and then
     `frame_to_parquet()` → `nanoparquet::write_parquet()`, gzip level 3.
4. **Validates** `sort`, `pin`, `formats`, `counts`, `views` against the
   column names (`R/views.R`: `browser_sort()`, `browser_pin()`, ...), so
   mistakes fail in R with a clear message instead of in the browser.
5. **Builds the payload `x`** (a list htmlwidgets turns into JSON):

   | field | meaning |
   |---|---|
   | `data` | base64 of the parquet bytes (or of the ciphertext) |
   | `meta` | per-column hints: `{ name: { class, levels, tz, label } }` |
   | `digits`, `theme`, `font`, `controls`, `minimal`, `top_offset` | display options |
   | `title`, `notes`, `columns`, `where`, `sort`, `pin`, `formats`, `counts`, `views` | starting state |
   | `enc` | only for password files: `{ v, kdf, iter, salt, iv, mac }` |

6. **`password =`** → `encrypt_payload()` (`R/encrypt.R`) moves `data` and
   every field that describes the data (`meta`, `columns`, `notes`, `where`,
   `sort`, `pin`, `formats`, `counts`, `views`) into one encrypted blob:
   - plaintext = 4-byte length + JSON of those fields + parquet bytes
   - key = PBKDF2-HMAC-SHA256(password, random 16-byte salt, 300,000
     iterations), written in R as a loop over `openssl::sha256(key=)`,
     because the openssl package has no PBKDF2; then HMAC splits it into an
     encryption key and a MAC key
   - cipher = AES-256-CTR (`openssl::aes_ctr_encrypt`); the IV's low 8
     bytes are zero so R (128-bit counter) and WebCrypto (64-bit counter)
     count identically
   - MAC = HMAC-SHA256 over `"pqview1" + salt + iv + ciphertext`
     (encrypt-then-MAC; a wrong password fails the MAC check)
   - why not AES-GCM: `openssl::aes_gcm_encrypt` returns no authentication
     tag, so the browser could not verify it.
7. **`plank_widget()`** calls `htmlwidgets::createWidget("plank", x, ...)`
   with a sizing policy (full width, 600 px high by default).

### `save_plank(x, file, ...)`

`R/save.R`: builds the widget (`plank(x, ...)` unless `x` already is one),
renders it with `htmltools::renderTags()`, and **inlines** the JS and CSS
(`inline_dependency()`) into one HTML file. It does not run pandoc (fast
for big data). It also applies the `name.plank.html` naming rule
(`save_paths()`) and can zip the result (`zip_one()`: the zip package if
installed, else `utils::zip`).

### Shiny

`plankOutput()` / `renderPlank()` are the usual htmlwidgets pair. The
browser sends back `input$<id>_rows`, `<id>_state` and `<id>_row` (see
`sendShiny` in `index.js`).

### RStudio add-in

`R/addin.R` + `inst/rstudio/addins.dcf`: takes the selected text in the
editor, evaluates it (or treats it as a `.parquet` path) and opens
`plank()` on it.

---

## 4. The bridge: htmlwidgets

htmlwidgets connects the two halves:

- `inst/htmlwidgets/plank.yaml` declares one dependency, `plank-core`,
  made of `lib/plank/plank-core.js` and `lib/plank/plank.css`. Its
  `version` should match DESCRIPTION.
- `inst/htmlwidgets/plank.js` is the binding:
  `renderValue(x)` → `Plank.mount(el, x)`. `Plank` is the global the
  bundle defines (esbuild `globalName`).
- htmlwidgets writes `x` into the page as JSON and calls `renderValue` when
  the page loads (or when Shiny sends new data).

---

## 5. The browser side

### How a page starts

1. `mount(el, x)` (end of `index.js`) turns the widget element into a
   **shell** (`.pqv-shell`). The shell owns the **tabs**: the data from R
   is tab 1; files the reader opens become more tabs. With no data it shows
   the **blank page**. It also handles the Open button, drag and drop, and
   messages ("toasts").
2. Each tab is a **viewer**, built by `mountInstance(root, x, ctx)` on its
   own `.pqv` element. For a password file it first shows the lock screen
   (`askPassword` → `crypto.js` `unlockPayload`).
3. `init()` opens the data: `decodeBase64` → `openDataset` (`load.js`). Only
   the parquet **footer** is read at first, so opening is instant; each
   column is decoded the first time it is needed and cached.
4. It builds the UI parts (header, toolbar, query bar, Counts, column list,
   grid, row panel), restores saved marks and views, applies the starting
   state from R, and draws the first table. Remaining columns decode in the
   background (`idle()` steps) so their stats and charts fill in.

### The core loop

Every change (a filter, the search, the WHERE query, a sort) calls
`recompute()` in `index.js`:

```
computeView({ filters, search, queryMask, sort })   filters.js (pure)
   └─► state.view : Uint32Array of row indices, in display order
grid.setView(view)                                  grid.js draws it
then, debounced: status line, column charts, export size estimate,
Counts panel, row panel, Shiny inputs, undo history
```

**Key idea: the data never moves.** Filtering and sorting only produce a
new array of row numbers (`view`). Rendering, exporting and counting all
read the columns through that array.

### The column store (`store.js`)

Each decoded column is a compact typed object:

- numbers, dates, date-times, logicals → `num: Float64Array` (dates as
  epoch milliseconds, NaN where missing)
- text with few distinct values, and factors → `codes: Int32Array` +
  `levels` + `counts` (category columns)
- other text → an array of strings
- every column → `isNull: Uint8Array`, `nullCount`, `type`, `name`

`buildColumn(name, values, info)` creates one. Imported CSV/Excel data uses
the same function (`datasetFromColumns` in `load.js`).

### Module map (`srcjs/src/`)

| Module | Job |
|---|---|
| **Data** | |
| `load.js` | Opens parquet (hyparquet), decodes columns on demand; zstd/gzip codecs; `datasetFromColumns` for in-memory data |
| `store.js` | The column store (above); cell text; sort keys; stats |
| `import.js` | Opening files in the browser: CSV/TSV parser and type guessing, `.xlsx` reader, parquet checks |
| `crypto.js` | Unlocking password files with WebCrypto |
| **Rows: filter, query, sort** | |
| `filters.js` | Column filters, global search, sorting → `computeView` (pure functions) |
| `query.js` | The WHERE language: tokenizer, parser, evaluator |
| `sql.js` | Writes all filters as one WHERE condition ("See Query") |
| `textsort.js` | Fast natural-order ranks for sorting text |
| `format.js` | Number/date formatting and parsing; time zones |
| **UI parts** | |
| `index.js` | Wires everything together; the shell (tabs, open, blank page); toolbar, header, query bar, undo, views panel, export menu, shortcuts, palette glue |
| `grid.js` | The virtual-scrolling table, header filters, popovers, pinned columns, cell cursor and selection |
| `picker.js` | The column list (search, tick, drag to reorder, group All/None) |
| `spark.js` | The small distribution charts in the column list |
| `counts.js` + `summary.js` | The Counts panel (UI) and its pure group counting |
| `detail.js` | The row panel |
| `markers.js` | Marker columns (Mark) and how they are saved |
| `views.js` | Saved views: build, compare, store, R code |
| `appearance.js` | Themes, accent and text colours, font, size, spacing, controls top/bottom; the Appearance window |
| `keys.js` | Shortcut table, help sheet, "is the user typing?" |
| `palette.js` | The Ctrl/Cmd+K command palette and its fuzzy matching |
| `dom.js` | `h()` element helper, `debounce`, `idle` |
| **Output** | |
| `csv.js` | CSV writer, missing-value text |
| `export.js` | Excel (.xlsx), R (.rds), parquet and clipboard (TSV) writers |

### The grid (`grid.js`) in brief

- **Virtual scrolling**: only about 40 rows × the visible columns exist in
  the DOM. `render()` runs once per animation frame and rewrites the text of
  a small pool of cells.
- **Scaled scrolling**: browsers cap element height, so past 12 million
  pixels (`MAX_SCROLL_H`) the scrollbar maps proportionally onto the rows.
  `geom()`, `topFromScroll()` and `scrollFromTop()` convert between the two;
  always use them, never `scrollTop / rowHeight`.
- **Two layers**: `rowsEl` scrolls sideways, `pinEl` holds the row numbers
  and pinned columns and stays at the left. Each row is drawn in both.
- **Cell cursor and selection** are view positions + column names (they
  survive filtering); drawn as boxes over the layers (`drawSelection`).
- **Popovers** (`openPop`/`closePop`): one at a time, closed by Escape or
  an outside click.

### State, undo and what is saved in the browser

- `state` (in `mountInstance`): shown columns, filter specs, sort, pins,
  formats, search, query, `view`. Undo stores snapshots of it
  (`takeSnapshot` / `stepHistory`).
- `localStorage` keys, all prefixed `plank.`:
  - display preferences, shared by every viewer: `theme`, `accent`, `ink`,
    `font`, `size`, `density`, `controls`, `minimal`, `query`, `fullQuery`,
    `pickerWidth`, `countsHeight`, `detailWidth`, `naText`, `naCustom`,
    `searchRegex`
  - per data set (keyed by a **fingerprint** of the data, `markers.js`):
    `plank.marks.<fp>` and `plank.views.<fp>`. Password files keep these
    in memory only.

### CSS (`plank.css`)

- Colours are **tokens** (`--pqv-bg`, `--pqv-fg`, `--pqv-accent`, ...)
  defined once per theme (`.pqv[data-theme="dark"]` etc.). Use tokens,
  never fixed colours, so every theme works.
- `appearance.js` only sets attributes on the root (`data-theme`,
  `data-accent`, `data-ink`, `data-font`, ...) and the CSS does the rest.
  Later rules win over earlier ones of the same strength, so accent and
  text colour rules sit after the theme blocks.
- Themes: Auto, Classic, Modern, Dark, Vintage, Starship. Old saved names
  are mapped in `normalizeTheme` (`light` to Classic, `terminal` to
  Starship); R does the same for `theme =`.
- Controls at the bottom (`data-controls="bottom"`) reorder the root's
  children with CSS `order` only; the DOM order never changes. Popovers
  flip above their button in `Grid.openPop` when there is more room there.
- The narrow layout uses **container queries** (`@container pqv
  (max-width: 560px)`), so it follows the widget's width, not the window's.
- The file is in sections with `/* ---- name ---- */` headers; newer
  features are appended near the end.

---

## 6. Libraries and why each is there

### R packages (DESCRIPTION)

| Package | Kind | Used for |
|---|---|---|
| htmlwidgets | Imports | The widget framework: payload → page, RStudio/R Markdown/Shiny integration |
| htmltools | Imports | Rendering tags and dependencies (`save_plank`) |
| jsonlite | Imports | base64 encoding, JSON for the encrypted fields |
| nanoparquet | Imports | Writing (and reading) parquet with no system libraries |
| tools, utils | Imports | File names, `utils::zip` fallback, `head` |
| openssl | Suggests | Password encryption (`R/encrypt.R`) |
| askpass | Suggests | `password = TRUE` prompts |
| zip | Suggests | `save_plank(zip = TRUE)` without a system zip program |
| rstudioapi | Suggests | The add-in |
| shiny | Suggests | The Shiny bindings |
| testthat | Suggests | R tests |

Suggests packages are optional: code that needs one checks
`requireNamespace()` first and gives a clear message.

### JavaScript, bundled into the page (srcjs/package.json `dependencies`)

| Library | Version | Used for |
|---|---|---|
| hyparquet | ^1.33.0 | Reading parquet in the browser (footer, columns, snappy) |
| hyparquet-writer | 0.18.0 | The parquet export |
| fflate | 0.8.3 | gzip pages in parquet; unzipping .xlsx files the reader opens |
| fzstd | 0.1.1 | zstd pages in parquet (polars, DuckDB files) |

All MIT. **Licence rule:** every bundled library must be listed in
`inst/COPYRIGHTS`, named in the banner in `srcjs/build.mjs`, and credited
in DESCRIPTION's `Authors@R` (`ctb`, `cph`).

### JavaScript, for development only (`devDependencies`)

| Tool | Used for |
|---|---|
| esbuild | Bundling and minifying `src/` into `plank-core.js` |
| playwright | Driving Chrome and WebKit in the end-to-end tests |

### Browser features relied on

WebCrypto (`crypto.subtle`, password files; needs a secure page: a local
file, the RStudio viewer, localhost or https), `CompressionStream` (the
exports: `export.js` has its own small zip writer for .xlsx and gzips .rds
with the browser's built-in compression, storing uncompressed where it is
missing), container queries,
`color-mix()`, `ResizeObserver`, `requestIdleCallback` (with a fallback),
`TextDecoder`, `Blob`/`URL.createObjectURL` (downloads).

---

## 7. Tools you need, and the build cycle

Install once:

- R ≥ 4.2 with `devtools`, `pkgload`, `testthat`, `roxygen2`, plus the
  Suggests packages
- Node.js ≥ 22 (the CI uses 22)
- Google Chrome (the e2e tests use it; WebKit is downloaded by Playwright)

Then, in `srcjs/`: `npm ci` (installs exactly what `package-lock.json`
lists).

### The build cycle (memorise this)

The demo page **embeds** the bundle and the CSS, so after any JS or CSS
change you must rebuild in this order:

```bash
cd srcjs && npm run build          # src/*.js → inst/htmlwidgets/lib/plank/plank-core.js
cd .. && Rscript examples/make-demo.R   # rebuild examples/demo.html with the new bundle + CSS
cd srcjs && npm run e2e            # test it in Chrome
```

CSS-only change: skip `npm run build`, but still rerun `make-demo.R`.
The most common confusing failure is testing an old demo page.

### All the commands

| Where | Command | What it does |
|---|---|---|
| srcjs/ | `npm ci` | Install JS dependencies from the lockfile |
| srcjs/ | `npm run build` | Build the bundle |
| srcjs/ | `npm test` | Unit tests (about 1 s) |
| srcjs/ | `npm run e2e` | End-to-end tests in Chrome (a few minutes) |
| srcjs/ | `BROWSER=webkit npm run e2e` | The same in WebKit (Safari's engine) |
| srcjs/ | `SHOTS=/some/dir npm run e2e` | Also save screenshots there |
| srcjs/ | `npx playwright install webkit` | Download WebKit for Playwright |
| root | `Rscript examples/make-demo.R` | demo.html, demo-locked.html, demo-expected.json |
| root | `Rscript examples/make-viewer.R` | viewer.plank.html (committed) |
| root | `tools/publish-site.sh` | builds the site into `site-dist/` and pushes it to the public `jossammil/plank` repo |
| root (R) | `devtools::document()` | Regenerate `man/` and `NAMESPACE` from roxygen comments |
| root (R) | `devtools::test()` | R tests |
| root (R) | `devtools::load_all()` | Load the package from source without installing |
| anywhere | `R CMD build plank && R CMD check --as-cran --no-manual plank_*.tar.gz` | The full package check |

---

## 8. How to update things

### Change the viewer (JavaScript)

1. Edit `srcjs/src/*.js`. Keep pure logic (no DOM) in its own functions so
   it can be unit-tested.
2. Add or adjust a unit test in `srcjs/test/`, and an e2e check in
   `srcjs/test-e2e/e2e.mjs` for anything a user sees.
3. Run the build cycle (section 7). Commit the rebuilt `plank-core.js`
   (CI fails if it does not match the sources).

### Change the look (CSS)

Edit `inst/htmlwidgets/lib/plank/plank.css` (it is not bundled), rerun
`make-demo.R`, look at the page, run e2e. Use the colour tokens.

### Change the R side

1. Edit `R/*.R`, including the roxygen comments (`#'`) above functions.
2. `devtools::document()` to regenerate the help pages.
3. Add tests in `tests/testthat/`; run `devtools::test()`.
4. If the payload `x` changes, update the JS that reads it and the table in
   section 3.

### Add a JavaScript library

1. `cd srcjs && npm install --save-exact name@version`
2. Import it in the module that needs it; check the bundle size printed by
   `npm run build`.
3. Licence rule (section 6): `inst/COPYRIGHTS`, the banner in `build.mjs`,
   DESCRIPTION `Authors@R`.

### Update the JavaScript libraries

`npm outdated` lists newer versions. Update one at a time
(`npm install --save-exact hyparquet@x.y.z`), run unit and e2e tests, and
update the versions written in `inst/COPYRIGHTS`.

### Bump the version

The version appears in four places; keep them equal:

- `DESCRIPTION` (`Version:`)
- `inst/htmlwidgets/plank.yaml` (`version:`)
- `srcjs/package.json` (`"version"`)
- `srcjs/package-lock.json` (twice, near the top)

### Refresh the public site

The site is a separate public repository, `jossammil/plank`, served by
GitHub Pages at <https://jossammil.github.io/plank/>. This repository
(`plank-app`) is private, so it cannot serve Pages itself on the free plan.

1. Optionally re-measure the size and speed numbers:
   `Rscript examples/bench.R` then `node srcjs/tools/bench-open.mjs`
   (both update `site/bench.json`).
2. `tools/publish-site.sh` rebuilds the demo and the blank viewer, runs
   `srcjs/tools/build-site.mjs` (the landing page, with the about text and
   shortcuts taken from `srcjs/src/keys.js`), and pushes `site-dist/` to the
   public repo. Pages republishes within a minute.

### Before a release (checklist)

- unit, R and e2e tests (Chrome and WebKit) pass
- `R CMD check --as-cran` has no errors or warnings
- bundle rebuilt and committed; demo and sample rebuilt
- version bumped in all four places; README updated

---

## 9. Tests

| Layer | Where | Runs with | Covers |
|---|---|---|---|
| JS unit | `srcjs/test/*.test.js` | `npm test` (node:test) | Pure logic: store, filters, query, CSV, exports, import, crypto, views, appearance, counts |
| R | `tests/testthat/` | `devtools::test()` | Payload building, encoding, saving, views, encryption round trips |
| End-to-end | `srcjs/test-e2e/e2e.mjs` | `npm run e2e` | The real page in Chrome / WebKit: filters, queries, exports, keyboard, tabs, password files... |

How the e2e test knows the right answers: `make-demo.R` applies the same
filters in R and writes the counts to `examples/demo-expected.json`; the
test filters in the browser and compares. Exported files are read back in R
by `test-e2e/check-exports.R`.

Each e2e check prints `FAIL  name: actual  (expected ...)`; the run ends
with `chromium: N/M checks passed`.

Fixtures: `srcjs/test/fixtures/` holds small parquet files
(`make-fixture.R` regenerates two of them), a zstd file, and an encrypted
payload made by R (to test that R's encryption decrypts in JavaScript).

---

## 10. Continuous integration and publishing

`.github/workflows/`, run on every push to `main` and on pull requests:

| Workflow | Jobs |
|---|---|
| `R-CMD-check.yaml` | `R CMD check --as-cran` on Windows and Ubuntu (two R versions); a job on Ubuntu that installs from GitHub with `remotes::install_github()` and saves a viewer. macOS is left out because private repositories pay 10× Actions minutes for it |
| `js.yaml` | Unit tests; a check that the committed bundle matches the sources; e2e in Chromium and WebKit on Ubuntu (builds the demo first) |

The public site is not built by CI; see **Refresh the public site**.

Results: the Actions tab on GitHub, or `gh run list` / `gh run view <id>
--log-failed` in a terminal.

---

## 11. Debugging

### In the browser

Open `examples/demo.html` in Chrome, then the developer tools (Cmd+Option+I).
In the Console:

```js
const api = document.querySelector('.pqv').plank   // the first viewer
api.state            // shown columns (cols), filter specs, sort, view, query
api.ds               // the dataset: api.ds.fields, await api.ds.column('age')
api.grid             // the table: api.grid.range(), api.grid.geom()
api.timings          // opened, firstTable, allDecoded, lastCompute, lastQuery (ms)
api.counts, api.detail, api.picker, api.views, api.appearance
document.querySelector('.pqv-shell').pqshell        // tabs: .tabs, .activate(k), .openFiles()
```

Useful moves:

- **Readable code**: the bundle is minified. For a session of debugging, set
  `minify: false` and add `sourcemap: 'inline'` in `srcjs/build.mjs`,
  rebuild, rerun `make-demo.R`; stack traces then point at `src/*.js`.
  Set them back before committing.
- **Reset the reader's settings**: in the Console,
  `Object.keys(localStorage).filter(k => k.startsWith('plank.')).forEach(k => localStorage.removeItem(k))`.
- **Performance**: `api.timings.lastCompute` after a filter; the
  Performance tab for scrolling.

### In R

- `devtools::load_all()` then `w <- plank(df); str(w$x)` shows the payload.
- `encode_data(df)$meta` shows the column hints.
- For a password file: `decrypt_payload(w$x, "pw")` (internal) returns the
  hidden fields and parquet bytes.

### Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| A JS change seems to do nothing | demo.html still has the old bundle | `npm run build`, then `Rscript examples/make-demo.R` |
| CI "bundle matches the sources" fails | `plank-core.js` not rebuilt or not committed | `npm run build`, commit it |
| The viewer looks different from the tests (theme, font, minimal view) | Saved preferences in `localStorage` | Clear the `plank.*` keys (above) |
| An e2e check fails only in WebKit | Timing or layout differences (Safari has no scroll anchoring, clicks do not focus buttons) | Rerun once; if it repeats, reproduce in a small Playwright script with WebKit and log positions |
| "Could not open file.parquet: ... compression" | brotli or lz4 parquet | Rewrite it with snappy, gzip or zstd |
| Password page says it cannot decrypt here | No WebCrypto on a plain-http page (for example Shiny over http) | Use https, localhost or a saved file |
| A column shows only NA with an error in its tooltip | That column failed to decode | `await api.ds.column('name')` and read `.error` |
| `R CMD check` NOTE "New submission" | Normal before a first CRAN release | Nothing to do |
| `npm test` finds no tests | Node older than 22 | Update Node |

---

## 12. Glossary

- **parquet**: a compressed, column-by-column file format for tables.
- **htmlwidget**: an R object that renders as interactive JavaScript in
  RStudio, R Markdown, Quarto, Shiny or a saved page.
- **bundle**: all JS modules and libraries combined into one file
  (`plank-core.js`) by esbuild.
- **payload (`x`)**: the list R sends to the browser as JSON.
- **view**: the array of row indices currently shown, in order.
- **column store**: the typed arrays a decoded column lives in.
- **footer**: the parquet file's index (row counts, column types,
  statistics), read before any data.
- **virtual scrolling**: drawing only the visible rows.
- **fingerprint**: a short hash identifying a data set, used to keep its
  marks and views apart from other data sets'.
- **container query**: CSS that reacts to an element's width rather than
  the window's.
- **PBKDF2 / AES-CTR / HMAC**: password → key stretching, the cipher, and
  the integrity check used for password files.
