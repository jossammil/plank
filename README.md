# pqview

[![R-CMD-check](https://github.com/jossammil/pqview/actions/workflows/R-CMD-check.yaml/badge.svg)](https://github.com/jossammil/pqview/actions/workflows/R-CMD-check.yaml)
[![js](https://github.com/jossammil/pqview/actions/workflows/js.yaml/badge.svg)](https://github.com/jossammil/pqview/actions/workflows/js.yaml)

A fast, serverless viewer for data frames and parquet files. `pqview` embeds
your data as compressed parquet inside **one HTML file** and reads it in the
browser, so the result opens by double-click, can be emailed or dropped on a
shared drive, and needs no R session, server or internet connection.

![pqview showing a filtered 100,000-row table](man/figures/pqview.png)

**[Try it in your browser](https://jossammil.github.io/pqview/)**: a saved
viewer of 10,000 synthetic rows, about 1 MB. The same file is
[`examples/sample.pqv.html`](examples/sample.pqv.html); download it (use
**Download raw file** on that page) and double-click it to open it offline.
**[Open your own file](https://jossammil.github.io/pqview/viewer.html)**:
a blank viewer for CSV, TSV, Excel and parquet files, read in your browser
and never uploaded.

## Install

On any machine with R 4.2 or later (macOS, Windows or Linux):

```r
install.packages("remotes")
remotes::install_github("jossammil/pqview")
```

pqview is pure R plus prebuilt JavaScript, so no Rtools, Xcode or Node is
needed to install it.

## Use

```r
library(pqview)

# In the RStudio viewer or a browser
pqview(mtcars)

# From a parquet file, choosing which columns show first
pqview("big_table.parquet", columns = c("id", "state", "amount"))

# One portable file, my_data.pqv.html, with a title and a line of notes in the top band
save_pqview(my_data, "my_data", title = "My data",
            notes = "Extract of 2024-06-30; one row per visit", open = TRUE)

# The same file in a zip archive, my_data.pqv.zip, to email or upload
save_pqview(my_data, "my_data", title = "My data", zip = TRUE)

# A password-protected file (TRUE asks for the password, so it is not in the script)
save_pqview(my_data, "my_data", title = "My data", password = TRUE)

# A blank viewer that opens the reader's own CSV, TSV, Excel and parquet files
save_pqview(NULL, "viewer.pqv.html")

# Start in the minimal view: just the table
pqview(mtcars, minimal = TRUE)

# Start with a query, a proportional font (monospace is the default) and a dark theme
pqview(mtcars, where = "mpg > 25 OR cyl = 8", font = "sans", theme = "dark")

# Start sorted and pinned, with the Counts panel open, and offer prepared views
pqview(mtcars, sort = c("cyl", "-mpg"), pin = "rowname", counts = "cyl",
       views = list(
         "Fuel-efficient" = pqview_view(columns = c("mpg", "cyl", "hp", "wt"),
                                        where = "mpg > 25", sort = "-mpg"),
         "By cylinders and gears" = pqview_view(counts = c("cyl", "gear"))
       ))
```

Saved files are named `name.pqv.html`: the `.html` ending opens them in a
browser on any computer, and the `.pqv` before it lets you find them all by
searching for `.pqv.html`. A name without an extension gets `.pqv.html`
added. A zip archive is about 30% smaller for a large table (the data inside is
already compressed) and up to 70% smaller for a small one, where the
viewer's own code is most of the file. The person you send it to unzips it
and double-clicks the `.pqv.html` file inside.

It is an htmlwidget, so it also works in R Markdown and Quarto chunks
(use `embed-resources: true` for a single-file document) and in Shiny with
`pqviewOutput()` / `renderPqview()`. In Shiny, the reader's filtered rows
come back as `input$<id>_rows` (row numbers, in the order shown), the
columns, sort and combined filter as `input$<id>_state`, and the row open in
the row panel as `input$<id>_row`.

In RStudio, the **View in pqview** add-in (Addins menu) opens the selected
data frame, or the selected path to a parquet file.

```r
# Show numbers with fixed decimals and thousands separators
pqview(my_data, formats = list(income = list(decimals = 2, big_mark = TRUE)))
```

## What the page does

- **Title band.** The title and any `notes` share one line at the top
  (long notes are cut short, with a **more** button to show them in full).
  On the right are the number of rows shown, the size of the embedded data
  and the estimated size of a CSV export of the rows and columns shown.
- **Column picker.** Every column is listed with its type and, once read,
  its distinct count, share of missing values, range and a small
  distribution chart (a histogram for numbers and dates, the top values for
  text and factors). While filters are on, each chart darkens the rows they
  keep, so you can see what a filter on one column does to the others.
  Hover a bar for its value and counts. Only the checkbox adds or removes a
  column; click the rest of an item for its details (min, quartiles, mean
  and max for numbers and dates, and counts for every value or range, kept
  and total). Columns in the table are listed first, in table order: a
  newly ticked column joins the right edge, and dragging any item places it
  in the table (Alt+Up/Down also reorders). Drag the panel's right edge to
  give the list more room (double-click the edge to widen or narrow it).
  **All** and **None** tick or untick every column, whatever is typed in
  "Find column"; **None** on the "In table" heading and **All** on "Other
  columns" act on just that group. While a search is typed, the bar
  "*n* found · All · None · Only" acts on just the columns it found (and the
  heading links on the found columns in their group).
- **Per-column filters** under each header: min/max for numbers, from/to for
  dates (`2024`, `2024-03` or `2024-03-15` all work), a checklist for factors
  and low-cardinality text, a text box for other text, and TRUE/FALSE for
  logicals.
- **Filter switch.** A funnel appears next to the name of a filtered column.
  Click it to switch that filter off (its settings stay) and again to switch
  it back on.
- **Filter options** (the sliders button in each header):
  - *Match*: contains, regular expression, or exact value, optionally case
    sensitive.
  - *Show*: matching rows, or **everything but** the matches. Inverting gives
    the true complement, so rows where that column is missing are included
    (normal + inverted always add up to every row).
  - *Missing values*: show, hide, or show only missing.
  - *Combine*: **AND** (the default) means a row must pass this filter;
    **OR** means a row must pass this filter or another OR filter. For
    example, `age` ≥ 61 (OR) and `income` ≥ 100000 (OR) with `region` = West
    (AND) keeps West rows that are older or richer.
  - Options in effect appear as badges next to the column name (`OR`, `NOT`,
    `.*`, `Aa`, `no NA`).
- **Value finder with regex.** A checklist's "Find value" box has a `.*`
  toggle; "Only these" checks just the values that match.
- **WHERE query bar.** A SQL condition over any column, shown or not, applied
  on top of the column filters. `NOT` inverts it; `?` lists examples. The
  toolbar's **WHERE** switch shows or hides the bar, and **See Query** shows
  every column filter, the search and the WHERE condition combined as one
  condition, which you can copy, or turn into the WHERE text to edit (it
  selects exactly the same rows).
- **Global search** across the visible columns, with `.*` (regular
  expression) and `NOT` toggles.
- **Sorting.** Click a header to sort; shift-click to add more sort keys.
  Missing values always sort last.
- **Pinned columns.** The pin button in a header (shown on hover) moves the
  column to the left and keeps it in view, with the row numbers, while the
  rest of the table scrolls sideways. Click it again to unpin. Pins are part
  of undo and of saved views; `pin =` sets them from R.
- **Row panel.** Click a row number to see every column of that row, shown
  or not, at full precision, in a panel at the right (it covers the table on
  narrow screens).
  - While it is open, clicking any row shows that row instead.
  - The arrow buttons, or the Up and Down keys, step through the filtered
    rows in their current order.
  - "Find column" narrows the list; **Copy** copies the row as name and value
    lines.
  - Drag the panel's left edge to resize it; Esc or × closes it.
- **Counts.** The **Counts** button opens a panel above the table with the
  number and share of filtered rows for each value of one column, or each
  combination of two. It updates as the filters change.
  - Dates count by day, month or year; date-times by day, hour, month, year
    or second, in the column's time zone; numbers by value or in about ten
    round ranges, chosen to suit the column.
  - Add a number column to show its mean, median, sum, minimum or maximum per
    group (for a logical column the mean is the share TRUE). Its values share
    one number of decimals so they line up, and **bars** switches the bars
    between the row counts and these values (negative values extend left).
  - Drag the edge of a column heading to resize it; double-click to reset.
  - Click a header to sort; missing values are their own group, listed last.
  - Click a row to show only that group, or **Exclude** to hide it. Both add
    a condition to the WHERE query (`region = 'West'`), so the table shows
    exactly the rows counted, and undo takes it back.
  - **Copy** and **CSV** give every group, not only those shown.
- **Views.** **Views** saves the current columns and their order, filters,
  search, WHERE query, sort and Counts settings under a name, and switches
  back to any saved view. The button names the view in use, if any.
  - Views are kept in the reader's browser, for this data.
  - Views passed from R with `views = list("Name" = pqview_view(...))` are
    listed under "In this report" for every reader.
  - **Copy as R code** writes the `pqview_view()` call for the current state,
    with the column filters and search written as `where`, ready to paste
    into the `views` argument.
  - Switching views is an undoable step. Views don't include marker columns.
- **Marker columns.** **Mark** creates a new column (say `review`) and sets
  a value (`1` unless you type another) on every filtered row; clicking a
  cell in a marker column sets, changes or clears a single row. Marker
  columns filter, sort and work in WHERE queries like any other column.
  Marks are saved in the reader's browser and included in exports.
- **Export** the filtered rows and visible columns, written in the browser:

  | Format | Notes |
  |---|---|
  | CSV | Full numeric precision |
  | Excel (.xlsx) | Bold, frozen header with filter buttons; real numbers, dates and logicals |
  | R data (.rds) | `readRDS()` gives back integers, factors, Dates and date-times in their time zone |
  | Parquet | Snappy-compressed and typed; date-times are stored as UTC instants |
  | Clipboard | Tab-separated with a header row, ready to paste into a spreadsheet |

  **Missing values as** (Empty, NA, NULL or your own text) sets what CSV,
  Excel and the clipboard write for missing values; R data and parquet keep
  real missing values.

  When a marker column is included, the export starts with a `row` column
  (the original row number) so the marks can be joined back in R:

  ```r
  marks <- readRDS("my_data.rds")
  my_data$review <- NA
  my_data$review[marks$row] <- marks$review
  ```
- **Undo and redo.** The two arrow buttons (or Ctrl/⌘+Z and Shift+Ctrl/⌘+Z
  outside a text box) step back and forward through changes to the columns
  and their order, filters, search, WHERE query, sort and marker columns.
  Unticking a column drops its filter, and deleting a marker column drops
  its marks; undo brings both back. Up to 100 steps are kept until the page
  is closed.
- **Number formats.** A number column's options (the sliders button) set a
  fixed number of decimals and a thousands separator (`1,234.50`). Formats
  change only how numbers look: filters, search, the row panel and exports
  keep full values. They are part of undo and saved views; `formats =` sets
  them from R.
- **Appearance.** The faint palette button at the right of the top band
  opens a small window with themes (Auto, which follows the system's light or
  dark setting, Classic, Modern, Dark, Vintage and Terminal, green on black
  in monospace) and individual settings: accent colour, text colour (dark
  shades on light themes, light shades on dark ones; amber on Terminal makes
  an amber screen), table font (mono, sans or serif), text size and row
  spacing. Each reader's choices are
  remembered in their browser; `theme =` and `font =` set the starting look
  from R.
- **Minimal view.** The button in the table's top-left corner (or `M`)
  folds away the top band, toolbar, WHERE bar, Counts and the column list,
  leaving the table and its column filters: a full spreadsheet view. The
  same button brings it all back; `minimal = TRUE` starts in it.
- **Opening files.** The open button beside the palette button, the `O`
  key, or dropping files on the viewer opens CSV, TSV, Excel (.xlsx, first
  sheet) and parquet files as tabs beside the data from R; the tabs run
  along the foot of the viewer, like a workbook's sheet tabs. Files are read in
  the browser and never uploaded. CSV column types are guessed (numbers,
  TRUE/FALSE, ISO dates and date-times; `NA`, `NULL` and empty cells are
  missing; codes with leading zeros stay text); Excel types come from the
  cell formats; parquet may be compressed with snappy, gzip or zstd.
  `save_pqview(NULL, ...)` writes a blank viewer for this.
- **Passwords.** `password =` encrypts the data in R (AES-256; the key comes
  from the password through PBKDF2-SHA256 with 300,000 iterations, a few
  seconds), and the viewer asks for the password before showing anything.
  Without it the file is unreadable, even in its HTML source: column names,
  factor levels, notes, the query and views are encrypted with the data;
  only the title stays readable. **A lost password cannot be recovered.**
  Once unlocked, the viewer works as usual, exports included; marks and saved
  views of a protected file last only until the page is closed.
- When the viewer fills a page of its own, `top_offset` adds that many
  pixels above it (default 0), for example to clear a fixed toolbar in a
  browser's full-screen mode.

### Keyboard

Click a cell, or focus the table and press an arrow key, for a cell cursor.

| Keys | |
|---|---|
| Arrows, Tab, Page Up/Down | Move the cell cursor |
| Ctrl/⌘ + arrows, Home, End | Jump to the edges |
| Shift + arrows, Shift+click, drag | Select a block of cells; its count, sum and mean show beside the row count |
| Ctrl/⌘ C, Ctrl/⌘ Shift C | Copy the block (with the column names) |
| Ctrl/⌘ A | Select every shown cell |
| Enter | Row panel for the cursor's row |
| Ctrl/⌘ K | Command palette: type to run any action, go to, sort or filter any column, switch views or themes, or go to a row number |
| `/` `W` `C` `K` `E` `V` `A` | Search, WHERE, columns, Counts, Export, Views, Appearance |
| `M` `O` `G` `?` | Minimal view, open a file, go to a row, list every shortcut |
| Ctrl/⌘ Z, Shift Ctrl/⌘ Z | Undo, redo |

Single-letter keys work whenever the cursor is not in a text box.

### WHERE syntax

| | |
|---|---|
| Compare | `age > 30`, `region = 'West'`, `age != 40`, `income / 1000 >= 50` |
| Combine | `AND`, `OR`, `NOT`, parentheses |
| Lists and ranges | `region IN ('West', 'South')`, `age NOT BETWEEN 30 AND 40` |
| Text patterns | `comment LIKE '%review%'` (`%` any text, `_` one character, ignores case) |
| Regular expressions | `comment REGEXP '^(called\|left)'` (case-sensitive), `IREGEXP` or `~*` to ignore case |
| Missing values | `income IS NULL`, `comment IS NOT NULL` |
| Truth tests | `(age > 30) IS NOT TRUE` (false or unknown), `enrolled IS FALSE` |
| Dates | `visit_date BETWEEN '2023-01' AND '2023-06'`, `updated_at = '2024-03-10'` (a date covers the whole period, in the column's time zone) |
| Functions | `LOWER`, `UPPER`, `LENGTH`, `ABS`, `YEAR`, `MONTH`, `DAY` |
| Logical columns | `enrolled AND NOT flagged` |
| Odd column names | `"column with spaces" = 1` or `` `Sepal.Length` > 5 `` |

Comparisons with a missing value are unknown, as in SQL, so `age > 30` never
matches a missing age. The query bar's `NOT` keeps everything the condition
does not match, including those rows.

## How it stays fast

The page lists columns from the parquet footer without decoding any data,
decodes only the columns you select (the rest are read in idle time), keeps
them in typed arrays, and draws only the rows on screen. Text columns are
sorted with radix-sorted keys taken from the browser's own collation, so a
first sort of a million strings takes well under a second. Measured in Chrome
on a laptop with the 30-column demo table:

| Step | 100,000 rows (8 MB file) | 1,000,000 rows (77 MB file) |
|---|---|---|
| Column list ready | ~25 ms | ~45 ms |
| First table drawn | ~0.2 s | ~1.4 s |
| Numeric, date or category filter | 1-5 ms | ~10 ms |
| Text "contains", regex or global search | 10-15 ms | 55-70 ms |
| WHERE query | 2-10 ms | ~10 ms |
| Sort a numeric column | ~20 ms | ~250 ms |
| Sort a text column (first time) | ~65 ms | ~0.45 s |
| Browser memory | ~80 MB | ~390 MB |
| Redraw while scrolling | < 1 ms | < 1 ms |
| Counts by a category (adding a mean) | 1-2 ms (~4 ms) | 3-4 ms (~25 ms) |
| Counts by a text column (first time / after) | 50-70 ms / 8-15 ms | 0.2-0.5 s / 30-40 ms |

## Limits

- Everything is held in browser memory, which is what makes it instant. It
  works well up to about a million rows of 30 columns (see the table above);
  `pqview()` warns when the embedded data passes 50 MB.
- The data is gzip-compressed parquet by default, about 30% smaller than
  snappy; `compression = "snappy"` writes and opens a little faster. The HTML
  file is about 1.33x the parquet size plus roughly 250 KB.
- List columns are shown as JSON text.
- Labelled values (from haven, labelled or sjlabelled) are shown as their
  labels when every value has one; the codes are listed in the column's
  tooltip. Blank or repeated column names are renamed (`column_1`, `a.1`)
  with a message saying so. Parquet files that use codecs other
  than gzip or snappy, or that have nested columns, are rewritten on the R
  side first.
- Date-times are shown in the column's time zone, to the millisecond.
- The query bar filters rows; it has no `SELECT`, `GROUP BY` or aggregates
  (the Counts panel covers simple grouped counts and statistics).
- Marks and saved views live in the browser that made them (keyed to the
  data); clearing site data removes them. Export the data to keep marks, and
  use **Copy as R code** to put a view into the report itself.
- Excel sheets hold at most 1,048,575 rows; Excel has no NaN or infinity, so
  those values export as blank cells.

## Development

How the package works inside, which program does what, how to rebuild and
update each part, the libraries it uses and how to debug it:
[DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md).

The browser code lives in `srcjs/` and is bundled with
[hyparquet](https://github.com/hyparam/hyparquet),
[hyparquet-writer](https://github.com/hyparam/hyparquet-writer) and
[fflate](https://github.com/101arrowz/fflate) (gzip), all MIT-licensed (see
`inst/COPYRIGHTS`), into
`inst/htmlwidgets/lib/pqview/pqview-core.js`. The bundle is committed, so
Node is only needed to change the JavaScript.

```bash
cd srcjs
npm install
npm test         # unit tests for the store, filters, query parser, CSV and loader
npm run build    # rebuild the bundle
```

```r
devtools::test()                      # R tests
source("examples/make-demo.R")        # writes examples/demo.html (100k x 30) and demo-locked.html
source("examples/make-sample.R")      # writes examples/sample.pqv.html (10k x 30) and viewer.pqv.html (blank), kept in git
```

End-to-end tests drive the demo page in a real browser and compare every
row count with the same filters applied in R:

```bash
cd srcjs
npm run e2e                             # Chromium (uses installed Chrome if present)
npx playwright install webkit && BROWSER=webkit npm run e2e   # Safari's engine
```

GitHub Actions runs `R CMD check` on macOS, Windows and Linux, installs the
package with `remotes::install_github()` on macOS and Windows, and runs the
JavaScript and browser tests.
