# pqview

[![R-CMD-check](https://github.com/jossammil/pqview/actions/workflows/R-CMD-check.yaml/badge.svg)](https://github.com/jossammil/pqview/actions/workflows/R-CMD-check.yaml)
[![js](https://github.com/jossammil/pqview/actions/workflows/js.yaml/badge.svg)](https://github.com/jossammil/pqview/actions/workflows/js.yaml)

A fast, serverless viewer for data frames and parquet files. `pqview` embeds
your data as compressed parquet inside **one HTML file** and reads it in the
browser, so the result opens by double-click, can be emailed or dropped on a
shared drive, and needs no R session, server or internet connection.

![pqview showing a filtered 100,000-row table](man/figures/pqview.png)

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

# One portable file, with a title and a line of notes in the top band
save_pqview(my_data, "my_data.html", title = "My data",
            notes = "Extract of 2024-06-30; one row per visit", open = TRUE)

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

It is an htmlwidget, so it also works in R Markdown and Quarto chunks
(use `embed-resources: true` for a single-file document) and in Shiny with
`pqviewOutput()` / `renderPqview()`.

## What the page does

- **Title band.** The title and any `notes` sit at the top, with the size
  of the embedded data and the estimated size of a CSV export of the rows
  and columns currently shown.
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
  "Find column". While a search is typed, **Add**, **Remove** and **Only**
  act on just the columns it found.
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
    group (for a logical column the mean is the share TRUE).
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
- **Switches** for the WHERE bar, See Query, a monospace font (on by
  default) and the theme (auto, light, dark). Each reader's choices are
  remembered in their browser.
- When the viewer fills a page of its own, it leaves `top_offset` pixels
  (default 56) above the toolbar, so browser chrome such as Safari's
  full-screen toolbar does not cover it.

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
source("examples/make-demo.R")        # writes examples/demo.html (100k x 30)
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
