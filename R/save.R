#' Save a viewer as one self-contained HTML file
#'
#' Writes a single `.html` file with the data, scripts and styles all inline.
#' The file opens by double-click, can be emailed or put on a shared drive,
#' and needs no server or internet connection.
#'
#' Unlike [htmlwidgets::saveWidget()] with `selfcontained = TRUE`, this does
#' not run pandoc, so it stays fast when the embedded data is large.
#'
#' @section File names:
#' Files from pqview are named `name.pqv.html` by convention: the `.html`
#' ending makes the file open in a browser on any computer, and the `.pqv`
#' before it makes pqview files easy to find (search for `.pqv.html`) and
#' tell apart from other web pages. A `file` without an extension, or ending
#' in `.pqv`, gets `.pqv.html` (or `.html`) added. A file name that does not
#' end in `.html` or `.htm` gives a warning, because browsers show such a
#' file as plain text instead of opening the viewer.
#'
#' @section Zipped files:
#' With `zip = TRUE` (or a `file` ending in `.zip`), the HTML file is put in a
#' zip archive, `name.pqv.zip`, which is smaller to email or upload. The
#' embedded data is already compressed, so the zip file is about 30% smaller
#' than the HTML file for a large table, and up to 70% smaller for a small
#' one, where the viewer's own code is most of the file. Whoever receives it
#' unzips it and double-clicks the `.pqv.html` file inside. The archive is
#' written with the \pkg{zip} package when it is installed, and otherwise
#' with the `zip` command line program (see [utils::zip()]).
#'
#' @param x A [pqview()] widget, or anything [pqview()] accepts as `data`.
#' @param file Path of the file to write. See **File names** below.
#' @param ... Passed to [pqview()] when `x` is not already a widget.
#' @param page_title Text for the browser tab. Defaults to the widget title,
#'   then the file name.
#' @param open Open the file in a browser afterwards? With `zip = TRUE`, a
#'   copy of the HTML file in a temporary folder is opened.
#' @param zip Write a zip archive holding the HTML file instead of the HTML
#'   file itself? See **Zipped files** below.
#'
#' @return The path to the file written (the zip archive with `zip = TRUE`),
#'   invisibly.
#' @examples
#' if (interactive()) {
#'   # Writes mtcars.pqv.html in the temporary folder
#'   save_pqview(mtcars, file.path(tempdir(), "mtcars"), title = "mtcars", open = TRUE)
#'
#'   # Writes mtcars.pqv.zip, holding mtcars.pqv.html
#'   save_pqview(mtcars, file.path(tempdir(), "mtcars"), zip = TRUE)
#' }
#' @export
save_pqview <- function(x, file, ..., page_title = NULL, open = FALSE, zip = FALSE) {
  if (!inherits(x, "pqview")) {
    x <- pqview(x, ...)
  }
  stopifnot(is.character(file), length(file) == 1L, !is.na(file), nzchar(file))
  stopifnot(is.logical(zip), length(zip) == 1L, !is.na(zip))
  paths <- save_paths(file, zip)
  html_file <- paths$html
  if (is.null(page_title)) {
    page_title <- x$x$title %||% sub("(\\.pqv)?\\.html?$", "", basename(html_file), ignore.case = TRUE)
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

  if (!is.null(paths$zip)) {
    # Written in its own temporary folder so the archive holds just the file.
    tmp <- tempfile("pqview-zip")
    dir.create(tmp)
    html_file <- file.path(tmp, basename(html_file))
  }
  local({
    con <- file(html_file, open = "wb", encoding = "native.enc")
    on.exit(close(con))
    writeLines(enc2utf8(html), con, useBytes = TRUE)
  })

  out <- html_file
  if (!is.null(paths$zip)) {
    out <- paths$zip
    zip_one(html_file, out)
    if (!isTRUE(open)) unlink(tmp, recursive = TRUE)
  }

  if (isTRUE(open)) {
    utils::browseURL(normalizePath(html_file))
  }
  invisible(out)
}

# Where save_pqview() writes: list(html, zip), with the .pqv.html naming
# convention applied. `zip` is NULL unless a zip archive is wanted.
save_paths <- function(file, zip = FALSE) {
  if (grepl("\\.zip$", file, ignore.case = TRUE)) {
    zip_path <- file
    html <- sub("\\.zip$", "", file, ignore.case = TRUE)
  } else {
    zip_path <- NULL
    html <- file
  }
  base <- basename(html)
  if (!nzchar(tools::file_ext(base))) {
    html <- paste0(html, ".pqv.html")
  } else if (grepl("\\.pqv$", base, ignore.case = TRUE)) {
    html <- paste0(html, ".html")
  } else if (!grepl("\\.html?$", base, ignore.case = TRUE)) {
    warning(
      "'", base, "' does not end in .html, so browsers will show it as text ",
      "instead of opening the viewer. Use a name ending in .pqv.html.",
      call. = FALSE
    )
  }
  if (is.null(zip_path) && isTRUE(zip)) {
    zip_path <- paste0(sub("\\.html?$", "", html, ignore.case = TRUE), ".zip")
  }
  list(html = html, zip = zip_path)
}

# Writes a zip archive holding one file, replacing any archive already there.
zip_one <- function(path, zipfile, use_package = requireNamespace("zip", quietly = TRUE)) {
  zipfile <- file.path(normalizePath(dirname(zipfile), mustWork = TRUE), basename(zipfile))
  if (file.exists(zipfile)) unlink(zipfile)
  if (use_package) {
    zip::zip(zipfile, basename(path), root = dirname(path), compression_level = 9)
  } else {
    status <- utils::zip(zipfile, path, flags = "-j9Xq")
    if (!identical(as.integer(status), 0L) || !file.exists(zipfile)) {
      stop(
        "Could not write the zip archive: no zip program was found. ",
        "Install the zip package with install.packages(\"zip\") and try again.",
        call. = FALSE
      )
    }
  }
  invisible(zipfile)
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
