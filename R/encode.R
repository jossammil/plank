# Turning data into the parquet bytes and column hints the viewer needs.

# The browser reader decodes these codecs without extra libraries.
browser_codecs <- c("SNAPPY", "UNCOMPRESSED")

is_parquet_file <- function(path) {
  size <- file.size(path)
  if (is.na(size) || size < 12) {
    return(FALSE)
  }
  con <- file(path, "rb")
  on.exit(close(con))
  identical(readBin(con, "raw", 4L), charToRaw("PAR1"))
}

# Make every column something parquet stores as a flat value and collect the
# hints (factor levels, time zones, labels) that parquet does not carry.
prepare_frame <- function(df, rownames = NULL) {
  df <- as.data.frame(df, stringsAsFactors = FALSE)
  if (anyDuplicated(names(df))) {
    names(df) <- make.unique(names(df))
  }

  # Only named rows count; integer row names left behind by subsetting do not.
  has_names <- is.character(.row_names_info(df, type = 0L))
  if (isTRUE(rownames) || (is.null(rownames) && has_names)) {
    rn <- data.frame(rowname = rownames(df), stringsAsFactors = FALSE)
    names(rn) <- make.unique(c(names(df), "rowname"))[length(df) + 1L]
    df <- cbind(rn, df)
  }
  rownames(df) <- NULL

  meta <- list()
  for (name in names(df)) {
    x <- df[[name]]
    hint <- list(class = class(x)[1L])
    label <- attr(x, "label", exact = TRUE)
    if (is.character(label) && length(label) == 1L && !is.na(label)) {
      hint$label <- label
    }

    if (is.factor(x)) {
      hint$levels <- as.list(levels(x))
    } else if (inherits(x, "POSIXct")) {
      tz <- attr(x, "tzone", exact = TRUE)
      if (is.null(tz) || !nzchar(tz[1L])) tz <- Sys.timezone()
      if (!is.na(tz[1L])) hint$tz <- tz[1L]
    } else if (inherits(x, "POSIXlt")) {
      df[[name]] <- as.POSIXct(x)
      hint$tz <- attr(df[[name]], "tzone", exact = TRUE)[1L]
    } else if (inherits(x, "difftime")) {
      df[[name]] <- as.numeric(x)
      hint$label <- paste0(hint$label %||% "difftime", " (", units(x), ")")
    } else if (is.list(x)) {
      df[[name]] <- vapply(x, list_cell, character(1L))
    } else if (is.complex(x) || is.raw(x)) {
      df[[name]] <- as.character(x)
    } else if (!is.atomic(x) || !is.null(dim(x))) {
      df[[name]] <- vapply(seq_len(nrow(df)), function(i) list_cell(x[i, ]), character(1L))
    }
    meta[[name]] <- hint
  }
  list(data = df, meta = meta)
}

`%||%` <- function(x, y) if (is.null(x)) y else x

# One list-column cell as compact JSON text; NULL becomes a missing value.
list_cell <- function(x) {
  if (is.null(x)) {
    return(NA_character_)
  }
  out <- tryCatch(
    as.character(jsonlite::toJSON(x, auto_unbox = TRUE, digits = NA, force = TRUE)),
    error = function(e) paste(format(x), collapse = ", ")
  )
  out[1L]
}

frame_to_parquet <- function(df) {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  nanoparquet::write_parquet(df, path, compression = "snappy")
  readBin(path, "raw", file.size(path))
}

# Returns list(bytes, meta, nrow, ncol) for a data frame or a parquet path.
encode_data <- function(data, rownames = NULL) {
  if (is.character(data) && length(data) == 1L && !is.data.frame(data)) {
    path <- data
    if (!file.exists(path)) {
      stop("File not found: ", path, call. = FALSE)
    }
    if (!is_parquet_file(path)) {
      stop("Not a parquet file: ", path, call. = FALSE)
    }
    schema <- nanoparquet::read_parquet_schema(path)
    info <- nanoparquet::read_parquet_metadata(path)
    codecs <- unique(info$column_chunks$codec)
    # Top-level columns are the direct children of the schema root.
    nested <- any(!is.na(schema$num_children[-1L]) & schema$num_children[-1L] > 0L)
    if (all(codecs %in% browser_codecs) && !nested) {
      return(list(
        bytes = readBin(path, "raw", file.size(path)),
        meta = list(),
        nrow = as.numeric(info$file_meta_data$num_rows),
        ncol = sum(!is.na(schema$type))
      ))
    }
    # Other codecs and nested columns are rewritten into a form the browser
    # reader handles directly.
    data <- nanoparquet::read_parquet(path)
  }

  if (!is.data.frame(data)) {
    data <- tryCatch(
      as.data.frame(data),
      error = function(e) {
        stop("`data` must be a data frame or the path to a parquet file.", call. = FALSE)
      }
    )
  }
  prepared <- prepare_frame(data, rownames = rownames)
  list(
    bytes = frame_to_parquet(prepared$data),
    meta = prepared$meta,
    nrow = nrow(prepared$data),
    ncol = ncol(prepared$data)
  )
}

format_bytes <- function(n) {
  if (n >= 1e6) sprintf("%.1f MB", n / 1e6) else sprintf("%.0f KB", n / 1e3)
}
