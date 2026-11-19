#' View a data frame or parquet file in the browser
#'
#' Creates an interactive table that runs entirely in the browser. The data is
#' embedded as compressed parquet and decoded client-side, so the result
#' needs no server: pick columns from a searchable list, filter each
#' column, sort, search and export the filtered rows.
#'
#' Printing the result shows it in the RStudio viewer or a browser. It can
#' also be placed in R Markdown and Quarto documents, used in Shiny with
#' [pqviewOutput()], or written to one portable file with [save_pqview()].
#'
#' @param data A data frame (or something [as.data.frame()] understands), or
#'   the path to a `.parquet` file. `NULL` makes a blank viewer that opens
#'   CSV, TSV, Excel and parquet files chosen or dropped by the reader (see
#'   **Opening files** below); only `title`, `theme`, `font`, `minimal` and
#'   `top_offset` apply to it.
#' @param columns Names of the columns shown at first. `NULL` shows the first
#'   ten; `character(0)` starts with none selected.
#' @param title Optional title shown in the band above the toolbar. It is
#'   also used as the file name for CSV exports.
#' @param notes Optional small text shown after the title, for notes such as
#'   the data source or date. Notes too long for the line are cut short, with
#'   a **more** button that shows them in full. The elements of a character
#'   vector are joined with " · " on the line, and shown one per line when the
#'   notes are shown in full.
#' @param digits Significant digits used to display non-integer numbers.
#'   Exports always keep full precision.
#' @param where Optional initial WHERE condition for the query bar, such as
#'   `"age > 30 AND region IN ('West', 'South')"`. It is checked in the
#'   browser, which shows any syntax error.
#' @param pin Optional columns to pin at first: they move to the left of the
#'   table and stay in view when scrolling sideways. They must be among those
#'   shown. Readers pin and unpin with the pin button in each header.
#' @param sort Optional columns to sort by at first, in order of priority.
#'   Prefix a name with `-` for descending order, as in
#'   `c("region", "-income")`. The columns must be among those shown.
#' @param formats Optional display formats for number columns: a named list
#'   with, for each column, `decimals` (a fixed number of decimal places) and
#'   `big_mark` (`TRUE` for a comma between thousands), as in
#'   `list(income = list(decimals = 2, big_mark = TRUE))`. Formats change only
#'   how numbers look; filters, search and exports use the full values.
#'   Readers can change them in each column's options.
#' @param counts Optional one or two column names: the **Counts** panel opens
#'   with the filtered rows counted by these columns.
#' @param views Optional named list of [pqview_view()] objects, offered in
#'   the viewer's **Views** menu so readers can switch between prepared
#'   states of the table, as in
#'   `list("Adults" = pqview_view(where = "age >= 18", sort = "-age"))`.
#' @param theme Starting colour theme: `"auto"` follows the reader's system
#'   light or dark setting; `"classic"`, `"modern"`, `"dark"`, `"vintage"`
#'   (sepia on cream) and `"terminal"` (green on black, all monospace) force
#'   one. `"light"` is another name for `"classic"`. Readers can switch in
#'   the Appearance window, and their choice is remembered in their browser.
#' @param font Starting font for the table: `"mono"` (the default), `"sans"`
#'   or `"serif"`. Readers can switch in the Appearance window, and their
#'   choice is remembered in their browser.
#' @param password Encrypt the data with this password (a string), or
#'   `TRUE` to be asked for it, so it does not sit in your script. See
#'   **Passwords** below. `NULL` (the default) leaves the data unencrypted.
#' @param minimal Start in the minimal view, with only the table showing
#'   (its column filters included)? Readers switch it with the corner button
#'   above the row numbers or the `M` key, and their choice is remembered.
#' @param top_offset Extra space in pixels above the top band when the viewer
#'   fills a page of its own (a saved file or a browser tab), for example
#'   `50` where browser chrome such as Safari's full-screen toolbar would
#'   cover the toolbar. It is added to the small default gap; elsewhere it is
#'   not used.
#' @param rownames Include row names as a first column? `NULL` includes them
#'   only when the rows are named (as in `mtcars`).
#' @param compression How the embedded data is compressed. `"gzip"` (the
#'   default) makes files about 30% smaller than `"snappy"`, which is a
#'   little faster to write and to open. A parquet file given as `data` is
#'   embedded as it is when it uses gzip, snappy or no compression.
#' @param max_bytes Warn when the embedded parquet data is larger than this
#'   many bytes. Everything is held in browser memory, so very large files
#'   will be slow to open.
#' @param width,height Widget size. The default fills the page when viewed on
#'   its own and is 600px tall inside a document.
#' @param elementId Optional element id for the widget.
#'
#' @return An htmlwidget.
#' @section In the viewer:
#' * The band at the top shows the title and notes on one line (**more**
#'   shows long notes in full), the number of rows shown, the size of the
#'   embedded data and the estimated size of a CSV export of the current rows
#'   and columns.
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
#' * **Counts** opens a panel with the number and share of filtered rows for
#'   each value of one or two columns (dates by day, month or year; numbers by
#'   value or in ranges), optionally with the mean, median, sum, minimum or
#'   maximum of a number column. It updates as the filters change. Click a
#'   row to show only that group, or **Exclude** to hide it; both add a
#'   condition to the WHERE query, so undo or editing the query reverses
#'   them. The counts can be copied or saved as CSV.
#' * **Views** saves the current columns, filters, search, WHERE query, sort
#'   and Counts settings under a name, in the reader's browser, and switches
#'   between saved views. Views passed from R with `views` are listed too,
#'   and **Copy as R code** writes [pqview_view()] code for the current
#'   state.
#' * Click a row number to open the row panel at the right: every column of
#'   that row, shown or not, at full precision, with a box to find a column.
#'   While it is open, clicking any row shows that row; the arrow buttons (or
#'   the Up and Down keys) step through the filtered rows, and **Copy** copies
#'   the row as name and value lines.
#' * A number column's options (the sliders button) also set how its numbers
#'   are shown: a fixed number of decimals and a thousands separator.
#' * The pin button in a header (shown on hover) pins the column: pinned
#'   columns move to the left and stay in view, with the row numbers, when
#'   scrolling sideways.
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
#' * The undo and redo arrows step back and forward through changes to the
#'   columns, filters, search, query, sort and marker columns, for example to
#'   bring back a column (and its filter) that was unticked by mistake.
#' * **Export** saves the filtered rows and shown columns as CSV, Excel
#'   (.xlsx), R data (.rds, keeping factors, dates and time zones) or parquet,
#'   or copies them to the clipboard as tab-separated text.
#' * The search box has regular-expression (`.*`) and `NOT` toggles.
#' * The faint palette button at the right of the top band opens the
#'   Appearance window: a colour theme (Auto, Classic, Modern, Dark, Vintage
#'   or Terminal), an accent colour, the table font (mono, sans or serif),
#'   text size and row spacing. The choices are remembered in the reader's
#'   browser.
#' * The corner button above the row numbers (or `M`) switches the minimal
#'   view, which folds away everything but the table.
#'
#' @section Keyboard:
#' Click a cell, or focus the table and press an arrow key, to get a cell
#' cursor. Arrows, Home/End, Page Up/Down and Ctrl/Cmd+arrows move it;
#' Shift+arrows, Shift+click or dragging select a block of cells, whose count,
#' sum and mean appear beside the row count; Ctrl/Cmd+C copies the block
#' (Ctrl/Cmd+Shift+C with the column names) and Enter opens the row panel.
#' Single keys jump to the tools when the cursor is not in a text box: `/`
#' search, `W` WHERE, `C` columns, `K` Counts, `E` Export, `V` Views, `A`
#' Appearance, `M` minimal view, `O` open a file, `G` go to a row and `?`
#' lists them all. Ctrl/Cmd+K opens a command palette to run any action, go
#' to or sort by any column, or switch views and themes by typing.
#'
#' @section Passwords:
#' With `password`, the data is encrypted in R (AES-256, with a key derived
#' from the password by PBKDF2-SHA256 with 300,000 iterations, which takes a
#' few seconds) and the viewer asks for the password before showing anything.
#' Without it the file is unreadable, even to someone who opens its HTML
#' source: the column names, factor levels, notes, query and views are
#' encrypted with the data. Only the title stays readable, as the file's
#' label. Keep the password safe: **a lost password cannot be recovered**.
#' Once unlocked, readers can use the viewer as usual, exports included;
#' marks and saved views of a protected file are kept only until the page is
#' closed, so nothing about the data is left in the browser. Unlocking needs
#' a secure page: a saved file, the RStudio viewer or an https address.
#'
#' @section Opening files:
#' **O**, the open button beside the palette button, or dropping files on
#' the viewer opens CSV, TSV, Excel (.xlsx, first sheet) and parquet files as
#' new tabs beside the data from R. The files are read in the reader's
#' browser and never uploaded. Column types are guessed from CSV text
#' (numbers, TRUE/FALSE, ISO dates and date-times; `NA`, `NULL` and empty
#' cells are missing) and taken from the cell formats in Excel. Parquet files
#' compressed with snappy, gzip or zstd can be opened. `pqview(NULL)` (or
#' `save_pqview(NULL, "viewer.pqv.html")`) makes a blank viewer for this.
#'
#' @examples
#' if (interactive()) {
#'   pqview(mtcars)
#'   pqview(iris, columns = c("Species", "Sepal.Length"), title = "Iris",
#'          notes = "Fisher's iris data, 150 flowers")
#'   pqview(mtcars, where = "mpg > 25 OR cyl = 8", font = "sans")
#'   pqview(mtcars, sort = c("cyl", "-mpg"), counts = "cyl",
#'          views = list("Heavy" = pqview_view(where = "wt > 4", sort = "-wt")))
#' }
#' @export
pqview <- function(data,
                   columns = NULL,
                   title = NULL,
                   notes = NULL,
                   digits = 7,
                   where = NULL,
                   sort = NULL,
                   pin = NULL,
                   formats = NULL,
                   counts = NULL,
                   views = NULL,
                   theme = c("auto", "classic", "modern", "dark", "vintage", "terminal", "light"),
                   font = c("mono", "sans", "serif"),
                   minimal = FALSE,
                   password = NULL,
                   top_offset = 0,
                   rownames = NULL,
                   compression = c("gzip", "snappy"),
                   max_bytes = 50e6,
                   width = NULL,
                   height = NULL,
                   elementId = NULL) {
  theme <- match.arg(theme)
  font <- match.arg(font)
  compression <- match.arg(compression)
  stopifnot(
    is.null(columns) || is.character(columns),
    is.null(title) || (is.character(title) && length(title) == 1L),
    is.null(notes) || is.character(notes),
    is.null(where) || (is.character(where) && length(where) == 1L && !is.na(where)),
    is.numeric(digits), length(digits) == 1L, digits >= 1, digits <= 17,
    is.numeric(top_offset), length(top_offset) == 1L, !is.na(top_offset), top_offset >= 0,
    is.logical(minimal), length(minimal) == 1L, !is.na(minimal)
  )

  if (is.null(data)) {
    if (!is.null(password)) stop("`password` needs data to protect.", call. = FALSE)
    # A blank viewer: the reader opens files in it.
    x <- list(theme = theme, font = font, top_offset = top_offset, digits = digits, minimal = minimal)
    if (!is.null(title)) x$title <- title
    return(pqview_widget(x, width, height, elementId))
  }

  check_names_arg(sort, "sort")
  check_names_arg(pin, "pin")
  check_names_arg(counts, "counts")
  if (!is.null(counts) && !length(counts) %in% 1:2) {
    stop("`counts` takes one or two column names.", call. = FALSE)
  }

  enc <- encode_data(data, rownames = rownames, compression = compression)
  shown <- if (is.null(columns)) utils::head(enc$names, 10L) else columns
  sort <- browser_sort(sort, enc$names, shown)
  pin <- browser_pin(pin, enc$names, shown)
  formats <- browser_formats(formats, enc$names)
  if (!is.null(counts)) check_known(counts, enc$names, "counts")
  views <- browser_views(views, enc$names, shown)
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
    minimal = minimal,
    nrow = enc$nrow,
    ncol = enc$ncol
  )
  if (!is.null(columns)) x$columns <- as.list(columns)
  if (!is.null(title)) x$title <- title
  notes <- notes[!is.na(notes)]
  if (length(notes)) x$notes <- paste(notes, collapse = "\n")
  if (!is.null(where) && nzchar(trimws(where))) x$where <- where
  if (length(sort)) x$sort <- sort
  if (length(pin)) x$pin <- pin
  if (length(formats)) x$formats <- formats
  if (!is.null(counts)) x$counts <- as.list(counts)
  if (length(views)) x$views <- views
  if (!is.null(password)) x <- encrypt_payload(x, enc$bytes, read_password(password))
  pqview_widget(x, width, height, elementId)
}

pqview_widget <- function(x, width, height, elementId) {
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
#' The viewer reports what the reader is looking at as Shiny inputs, named
#' after the output id:
#' * `input$<id>_rows`: the row numbers (of the data given to [pqview()]) of
#'   the filtered rows, in the order shown.
#' * `input$<id>_state`: a list with `columns` (shown, in order), `sort`
#'   (`-` marks descending), `pinned`, `where` (every filter, the search and
#'   the WHERE query as one condition, as See Query shows it), `rows_shown`
#'   and `rows_total`.
#' * `input$<id>_row`: the row number open in the row panel, or `NULL`.
#'
#' They update a quarter of a second after the reader stops changing things.
#'
#' @param outputId Output variable to read from.
#' @param width,height Must be a valid CSS unit (like `"100%"` or `"600px"`).
#' @param expr An expression that returns a [pqview()] widget.
#' @param env The environment in which to evaluate `expr`.
#' @param quoted Is `expr` a quoted expression?
#'
#' @return `pqviewOutput()` returns a Shiny output element; `renderPqview()`
#'   returns a render function.
#' @examples
#' if (interactive() && requireNamespace("shiny", quietly = TRUE)) {
#'   shiny::shinyApp(
#'     shiny::fluidPage(pqviewOutput("cars"), shiny::verbatimTextOutput("picked")),
#'     function(input, output) {
#'       output$cars <- renderPqview(pqview(mtcars))
#'       output$picked <- shiny::renderPrint({
#'         rows <- unlist(input$cars_rows)
#'         c(rows = length(rows), mean_mpg = mean(mtcars$mpg[rows]))
#'       })
#'     }
#'   )
#' }
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
