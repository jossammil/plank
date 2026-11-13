#' Save a viewer as one self-contained HTML file
#'
#' Writes a single `.html` file with the data, scripts and styles all inline.
#' The file opens by double-click, can be emailed or put on a shared drive,
#' and needs no server or internet connection.
#'
#' Unlike [htmlwidgets::saveWidget()] with `selfcontained = TRUE`, this does
#' not run pandoc, so it stays fast when the embedded data is large.
#'
#' @param x A [pqview()] widget, or anything [pqview()] accepts as `data`.
#' @param file Path of the HTML file to write.
#' @param ... Passed to [pqview()] when `x` is not already a widget.
#' @param page_title Text for the browser tab. Defaults to the widget title,
#'   then the file name.
#' @param open Open the file in a browser afterwards?
#'
#' @return The path to the file, invisibly.
#' @examples
#' if (interactive()) {
#'   save_pqview(mtcars, tempfile(fileext = ".html"), title = "mtcars", open = TRUE)
#' }
#' @export
save_pqview <- function(x, file, ..., page_title = NULL, open = FALSE) {
  if (!inherits(x, "pqview")) {
    x <- pqview(x, ...)
  }
  stopifnot(is.character(file), length(file) == 1L, nzchar(file))
  if (is.null(page_title)) {
    page_title <- x$x$title %||% tools::file_path_sans_ext(basename(file))
  }

  rendered <- htmltools::renderTags(htmltools::as.tags(x, standalone = TRUE))
  deps <- vapply(rendered$dependencies, inline_dependency, character(1L))

  html <- c(
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    paste0("<title>", htmltools::htmlEscape(page_title), "</title>"),
    deps,
    as.character(rendered$head),
    "</head>",
    "<body style=\"margin:0\">",
    as.character(rendered$html),
    "</body>",
    "</html>"
  )

  con <- file(file, open = "wb", encoding = "native.enc")
  on.exit(close(con))
  writeLines(enc2utf8(html), con, useBytes = TRUE)

  if (isTRUE(open)) {
    utils::browseURL(normalizePath(file))
  }
  invisible(file)
}

# Inline one html dependency's scripts and stylesheets as <script>/<style>.
inline_dependency <- function(dep) {
  dir <- dep$src$file
  if (is.null(dir)) {
    stop("Dependency '", dep$name, "' has no local files to inline.", call. = FALSE)
  }
  if (!is.null(dep$package)) {
    dir <- system.file(dir, package = dep$package)
  }
  read <- function(name) {
    path <- file.path(dir, name)
    text <- readChar(path, file.size(path), useBytes = TRUE)
    Encoding(text) <- "UTF-8"
    text
  }
  files <- function(entry) {
    if (is.list(entry)) vapply(entry, function(e) e$src %||% e[[1L]], character(1L)) else entry
  }

  styles <- vapply(files(dep$stylesheet), function(name) {
    paste0("<style>\n", read(name), "\n</style>")
  }, character(1L))
  scripts <- vapply(files(dep$script), function(name) {
    # A literal closing tag inside the code would end the inline script early.
    code <- gsub("</script", "<\\/script", read(name), fixed = TRUE)
    paste0("<script>\n", code, "\n</script>")
  }, character(1L))

  paste(c(styles, scripts, dep$head), collapse = "\n")
}
