#' View a data frame or parquet file in the browser
#'
#' Creates an interactive table that runs entirely in the browser. The data is
#' embedded as snappy-compressed parquet and decoded client-side, so the
#' result needs no server: pick columns from a searchable list, filter each
#' column, sort, search and export the filtered rows.
#'
#' Printing the result shows it in the RStudio viewer or a browser. It can
#' also be placed in R Markdown and Quarto documents, used in Shiny with
#' [pqviewOutput()], or written to one portable file with [save_pqview()].
#'
#' @param data A data frame (or something [as.data.frame()] understands), or
#'   the path to a `.parquet` file.
#' @param columns Names of the columns shown at first. `NULL` shows the first
#'   ten; `character(0)` starts with none selected.
#' @param title Optional title shown in the band above the toolbar. It is
#'   also used as the file name for CSV exports.
#' @param notes Optional small text shown under the title, for notes such as
#'   the data source or date. A character vector is shown one element per
#'   line.
#' @param digits Significant digits used to display non-integer numbers.
#'   Exports always keep full precision.
#' @param where Optional initial WHERE condition for the query bar, such as
#'   `"age > 30 AND region IN ('West', 'South')"`. It is checked in the
#'   browser, which shows any syntax error.
#' @param theme Starting theme: `"auto"` follows the reader's system setting;
#'   `"light"` and `"dark"` force one. Readers can switch with the toolbar
#'   button, and their choice is remembered in their browser.
#' @param font Starting font for the table: `"mono"` (the default) or
#'   `"sans"`. Readers can switch with the toolbar's Mono button, and their
#'   choice is remembered in their browser.
#' @param top_offset Minimum height in pixels of the band above the toolbar
#'   (title, notes and data sizes) when the viewer fills a page of its own (a
#'   saved file or a browser tab), so browser chrome such as Safari's
#'   full-screen toolbar does not cover the toolbar. Elsewhere the band is
#'   only as tall as its contents. Use `0` for no minimum.
#' @param rownames Include row names as a first column? `NULL` includes them
#'   only when the rows are named (as in `mtcars`).
#' @param max_bytes Warn when the embedded parquet data is larger than this
#'   many bytes. Everything is held in browser memory, so very large files
#'   will be slow to open.
#' @param width,height Widget size. The default fills the page when viewed on
#'   its own and is 600px tall inside a document.
#' @param elementId Optional element id for the widget.
#'
#' @return An htmlwidget.
#' @section In the viewer:
#' * The band at the top shows the title, notes, the size of the embedded data
#'   and the estimated size of a CSV export of the current rows and columns.
#' * **Columns** opens a searchable list of every column with its type,
#'   distinct count, share missing, range and a small distribution chart
#'   (hover a bar for its counts). The chart darkens the part of each column
#'   that the current filters keep. The checkbox adds or removes a column;
#'   clicking the rest of an item shows its details (summary statistics and
#'   counts per value or range); dragging an item places it in the table
#'   (Alt+Up/Down also reorders). Drag the panel's right edge to resize it.
#' * A funnel appears next to a filtered column's name; click it to switch
#'   that filter off and on without losing it.
#' * Each header has a filter (range, checklist, text or TRUE/FALSE) and an
#'   options button for the match mode (contains, regular expression, exact),
#'   case sensitivity, "everything but" (invert, missing values included),
#'   missing values (show, hide, only) and how the filter combines with the
#'   others: AND filters must all match; a row must match at least one OR
#'   filter.
#' * **Mark** adds a marker column and sets a value on every filtered row;
#'   clicking a marker cell sets one row. Marker columns can be filtered,
#'   sorted and queried, are saved in the reader's browser, and are included
#'   in exports together with a `row` column (the original row number) for
#'   joining back to the data in R.
#' * **WHERE** takes a SQL condition over any column, for example
#'   `comment REGEXP 'review|call' AND income IS NOT NULL`. Click `?` for the
#'   syntax. The toolbar's **WHERE** switch shows or hides this bar, and
#'   **See Query** shows the column filters, search and WHERE condition
#'   combined as one condition, to copy or edit.
#' * **Export** saves the filtered rows and shown columns as CSV, Excel
#'   (.xlsx), R data (.rds, keeping factors, dates and time zones) or parquet,
#'   or copies them to the clipboard as tab-separated text.
#' * The search box has regular-expression (`.*`) and `NOT` toggles.
#' * Toolbar switches change the theme and turn on a monospace font.
#'
#' @examples
#' if (interactive()) {
#'   pqview(mtcars)
#'   pqview(iris, columns = c("Species", "Sepal.Length"), title = "Iris",
#'          notes = "Fisher's iris data, 150 flowers")
#'   pqview(mtcars, where = "mpg > 25 OR cyl = 8", font = "sans")
#' }
#' @export
pqview <- function(data,
                   columns = NULL,
                   title = NULL,
                   notes = NULL,
                   digits = 7,
                   where = NULL,
                   theme = c("auto", "light", "dark"),
                   font = c("mono", "sans"),
                   top_offset = 56,
                   rownames = NULL,
                   max_bytes = 50e6,
                   width = NULL,
                   height = NULL,
                   elementId = NULL) {
  theme <- match.arg(theme)
  font <- match.arg(font)
  stopifnot(
    is.null(columns) || is.character(columns),
    is.null(title) || (is.character(title) && length(title) == 1L),
    is.null(notes) || is.character(notes),
    is.null(where) || (is.character(where) && length(where) == 1L && !is.na(where)),
    is.numeric(digits), length(digits) == 1L, digits >= 1, digits <= 17,
    is.numeric(top_offset), length(top_offset) == 1L, !is.na(top_offset), top_offset >= 0
  )

  enc <- encode_data(data, rownames = rownames)
  if (length(enc$bytes) > max_bytes) {
    warning(
      "The embedded data is ", format_bytes(length(enc$bytes)),
      ", which may be slow to open in a browser. ",
      "Consider selecting fewer columns or rows first.",
      call. = FALSE
    )
  }

  x <- list(
    data = gsub("\n", "", jsonlite::base64_enc(enc$bytes), fixed = TRUE),
    meta = enc$meta,
    digits = digits,
    theme = theme,
    font = font,
    top_offset = top_offset,
    nrow = enc$nrow,
    ncol = enc$ncol
  )
  if (!is.null(columns)) x$columns <- as.list(columns)
  if (!is.null(title)) x$title <- title
  notes <- notes[!is.na(notes)]
  if (length(notes)) x$notes <- paste(notes, collapse = "\n")
  if (!is.null(where) && nzchar(trimws(where))) x$where <- where

  htmlwidgets::createWidget(
    name = "pqview",
    x = x,
    width = width,
    height = height,
    package = "pqview",
    elementId = elementId,
    sizingPolicy = htmlwidgets::sizingPolicy(
      defaultWidth = "100%",
      defaultHeight = 600,
      padding = 0,
      browser.fill = TRUE,
      viewer.fill = TRUE,
      knitr.figure = FALSE,
      knitr.defaultWidth = "100%",
      knitr.defaultHeight = 600
    )
  )
}

#' Shiny bindings for pqview
#'
#' Output and render functions for using [pqview()] in Shiny applications.
#'
#' @param outputId Output variable to read from.
#' @param width,height Must be a valid CSS unit (like `"100%"` or `"600px"`).
#' @param expr An expression that returns a [pqview()] widget.
#' @param env The environment in which to evaluate `expr`.
#' @param quoted Is `expr` a quoted expression?
#'
#' @return `pqviewOutput()` returns a Shiny output element; `renderPqview()`
#'   returns a render function.
#' @name pqview-shiny
#' @export
pqviewOutput <- function(outputId, width = "100%", height = "600px") {
  htmlwidgets::shinyWidgetOutput(outputId, "pqview", width, height, package = "pqview")
}

#' @rdname pqview-shiny
#' @export
renderPqview <- function(expr, env = parent.frame(), quoted = FALSE) {
  if (!quoted) expr <- substitute(expr)
  htmlwidgets::shinyRenderWidget(expr, pqviewOutput, env, quoted = TRUE)
}
