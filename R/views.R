#' Define a view for the viewer's Views menu
#'
#' A view is a named state of the table that readers can switch to from the
#' **Views** menu: which columns are shown and in what order, which are
#' pinned, which rows are kept, how they are sorted, and optionally the
#' **Counts** panel. Pass a
#' named list of views to [plank()]'s `views` argument.
#'
#' In the viewer, **Views** > **Copy as R code** writes this call for the
#' current state, with the column filters and search turned into `where`.
#'
#' @param columns Names of the columns shown, in order. `NULL` shows the same
#'   columns as the viewer starts with (`plank(columns = )`, or the first
#'   ten).
#' @param where A WHERE condition in the viewer's query syntax, such as
#'   `"age > 30 AND region IN ('West', 'South')"`. It is checked in the
#'   browser when the view is used.
#' @param pin Columns to pin: they move to the left of the table and stay in
#'   view when scrolling sideways. They must be among those shown.
#' @param sort Columns to sort by, in order of priority. Prefix a name with
#'   `-` to sort it in descending order, as in `c("region", "-income")`. The
#'   columns must be among those shown.
#' @param counts One or two column names to count rows by in the **Counts**
#'   panel, which opens when the view is used. `NULL` leaves the panel as it
#'   is.
#'
#' @return A `plank_view` object.
#' @seealso [plank()]
#' @examples
#' if (interactive()) {
#'   plank(mtcars,
#'     views = list(
#'       "Fuel-efficient" = plank_view(
#'         columns = c("mpg", "cyl", "hp", "wt"),
#'         where = "mpg > 25",
#'         sort = "-mpg"
#'       ),
#'       "By cylinders" = plank_view(counts = c("cyl", "gear"))
#'     )
#'   )
#' }
#' @export
plank_view <- function(columns = NULL, where = NULL, sort = NULL, counts = NULL, pin = NULL) {
  check_names_arg(columns, "columns")
  check_names_arg(pin, "pin")
  check_names_arg(sort, "sort")
  check_names_arg(counts, "counts")
  if (!is.null(counts) && !length(counts) %in% 1:2) {
    stop("`counts` takes one or two column names.", call. = FALSE)
  }
  if (!is.null(where) && !(is.character(where) && length(where) == 1L && !is.na(where))) {
    stop("`where` must be a single string.", call. = FALSE)
  }
  structure(
    list(columns = columns, where = where, sort = sort, counts = counts, pin = pin),
    class = "plank_view"
  )
}

#' @export
print.plank_view <- function(x, ...) {
  cat("<plank_view>\n")
  show <- function(label, value) {
    if (!is.null(value)) cat(sprintf("  %-8s %s\n", label, paste(value, collapse = ", ")))
  }
  show("columns", x$columns)
  show("where", x$where)
  show("pin", x$pin)
  show("sort", x$sort)
  show("counts", x$counts)
  if (is.null(x$columns) && is.null(x$where) && is.null(x$sort) && is.null(x$counts) && is.null(x$pin)) {
    cat("  (the starting columns, no filters)\n")
  }
  invisible(x)
}

check_names_arg <- function(x, arg) {
  if (is.null(x)) return(invisible())
  if (!is.character(x) || anyNA(x) || any(!nzchar(x))) {
    stop("`", arg, "` must be a character vector of column names.", call. = FALSE)
  }
  invisible()
}

# Sort names to list(name, dir). A leading "-" means descending unless the
# whole string is itself a column name.
parse_sort <- function(sort, names, context = "") {
  lapply(sort, function(s) {
    if (s %in% names) return(list(name = s, dir = "asc"))
    if (startsWith(s, "-") && substring(s, 2L) %in% names) {
      return(list(name = substring(s, 2L), dir = "desc"))
    }
    stop("Unknown column in ", context, "`sort`: '", s, "'.", call. = FALSE)
  })
}

check_known <- function(x, names, arg, context = "") {
  bad <- setdiff(x, names)
  if (length(bad)) {
    stop(
      "Unknown column", if (length(bad) > 1L) "s", " in ", context, "`", arg, "`: ",
      paste0("'", bad, "'", collapse = ", "), ".",
      call. = FALSE
    )
  }
  invisible()
}

# Checks sort and counts against the data's columns and returns them in the
# form the browser reads. `shown` is the columns the sort applies to.
browser_sort <- function(sort, names, shown, context = "") {
  if (is.null(sort)) return(NULL)
  out <- parse_sort(sort, names, context)
  hidden <- setdiff(vapply(out, `[[`, "", "name"), shown)
  if (length(hidden)) {
    stop(
      "Columns in ", context, "`sort` must be shown: add ",
      paste0("'", hidden, "'", collapse = ", "), " to `columns`.",
      call. = FALSE
    )
  }
  out
}

# Pinned columns, checked: they must exist and be shown.
browser_pin <- function(pin, names, shown, context = "") {
  if (is.null(pin)) return(NULL)
  check_known(pin, names, "pin", context)
  hidden <- setdiff(pin, shown)
  if (length(hidden)) {
    stop(
      "Columns in ", context, "`pin` must be shown: add ",
      paste0("'", hidden, "'", collapse = ", "), " to `columns`.",
      call. = FALSE
    )
  }
  as.list(unique(pin))
}

# Number display formats as the browser reads them.
browser_formats <- function(formats, names) {
  if (is.null(formats)) return(NULL)
  if (!is.list(formats) || is.null(names(formats)) || any(!nzchar(names(formats)))) {
    stop("`formats` must be a named list, such as list(income = list(decimals = 2, big_mark = TRUE)).", call. = FALSE)
  }
  check_known(names(formats), names, "formats")
  out <- lapply(names(formats), function(name) {
    f <- formats[[name]]
    if (!is.list(f)) stop("`formats$", name, "` must be a list with `decimals` and/or `big_mark`.", call. = FALSE)
    bad <- setdiff(names(f), c("decimals", "big_mark"))
    if (length(bad)) stop("Unknown setting in `formats$", name, "`: ", paste(bad, collapse = ", "), ".", call. = FALSE)
    d <- f$decimals
    if (!is.null(d) && !(is.numeric(d) && length(d) == 1L && !is.na(d) && d >= 0 && d <= 10 && d == round(d))) {
      stop("`formats$", name, "$decimals` must be a whole number from 0 to 10.", call. = FALSE)
    }
    b <- f$big_mark
    if (!is.null(b) && !(is.logical(b) && length(b) == 1L && !is.na(b))) {
      stop("`formats$", name, "$big_mark` must be TRUE or FALSE.", call. = FALSE)
    }
    out <- list()
    if (!is.null(d)) out$decimals <- as.integer(d)
    out$big_mark <- isTRUE(b)
    out
  })
  stats::setNames(out, names(formats))
}

# Views as a list the browser reads: list(name, columns, where, sort, pinned, counts).
browser_views <- function(views, names, default_columns) {
  if (is.null(views)) return(NULL)
  if (inherits(views, "plank_view")) {
    stop("`views` must be a named list of views, such as list(\"Name\" = plank_view(...)).", call. = FALSE)
  }
  if (!is.list(views) || !length(views)) {
    stop("`views` must be a named list of plank_view() objects.", call. = FALSE)
  }
  labels <- names(views)
  if (is.null(labels) || anyNA(labels) || any(!nzchar(trimws(labels)))) {
    stop("Every element of `views` needs a name, such as list(\"Name\" = plank_view(...)).", call. = FALSE)
  }
  if (anyDuplicated(trimws(labels))) {
    stop("View names must be unique: '", labels[anyDuplicated(trimws(labels))], "' is repeated.", call. = FALSE)
  }
  unname(Map(function(label, v) {
    if (!inherits(v, "plank_view")) {
      if (!is.list(v)) stop("View '", label, "' must be made with plank_view().", call. = FALSE)
      v <- do.call(plank_view, v)
    }
    context <- sprintf("view '%s' ", label)
    if (!is.null(v$columns)) check_known(v$columns, names, "columns", context)
    if (!is.null(v$counts)) check_known(v$counts, names, "counts", context)
    shown <- if (is.null(v$columns)) default_columns else v$columns
    out <- list(name = trimws(label))
    if (!is.null(v$columns)) out$columns <- as.list(v$columns)
    if (!is.null(v$where) && nzchar(trimws(v$where))) out$where <- v$where
    if (!is.null(v$sort)) out$sort <- browser_sort(v$sort, names, shown, context)
    if (!is.null(v$pin)) out$pinned <- browser_pin(v$pin, names, shown, context)
    if (!is.null(v$counts)) out$counts <- as.list(v$counts)
    out
  }, labels, views))
}
