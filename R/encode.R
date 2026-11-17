# Turning data into the parquet bytes and column hints the viewer needs.

# Parquet compression codecs the browser reader decodes.
browser_codecs <- c("GZIP", "SNAPPY", "UNCOMPRESSED")

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
  names(df) <- fix_names(names(df))

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

    value_labels <- attr(x, "labels", exact = TRUE)
    if (!is.factor(x) && is.atomic(x) && is.null(dim(x)) && is.atomic(value_labels) &&
      length(value_labels) && !is.null(names(value_labels))) {
      # Labelled values (haven, labelled, sjlabelled): show the labels.
      lab <- labelled_column(x, value_labels)
      df[[name]] <- lab$values
      if (!is.null(lab$levels)) hint$levels <- as.list(lab$levels)
      hint$label <- paste0(
        if (is.null(hint$label)) "" else paste0(hint$label, " "),
        "(value labels: ", lab$key, ")"
      )
    } else if (is.factor(x)) {
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

# Column names the viewer can use: blank or missing names get a placeholder
# and repeats are numbered, with a message saying what changed.
fix_names <- function(nms) {
  if (is.null(nms)) {
    return(nms)
  }
  old <- nms
  blank <- is.na(nms) | !nzchar(trimws(nms))
  nms[blank] <- paste0("column_", which(blank))
  nms <- make.unique(nms)
  changed <- which(is.na(old) | old != nms)
  if (length(changed)) {
    shown <- utils::head(changed, 8L)
    message(
      "pqview renamed ", length(changed), " column", if (length(changed) > 1L) "s", " so every name is ",
      "unique and not blank: ",
      paste0(ifelse(is.na(old[shown]) | !nzchar(old[shown]), "(blank)", paste0("'", old[shown], "'")),
        " -> '", nms[shown], "'", collapse = ", "),
      if (length(changed) > 8L) ", ..."
    )
  }
  nms
}

# A labelled vector (haven::labelled and similar). When every value has a
# label it becomes a factor of the labels, in code order; otherwise the
# values stay as they are. Either way the codes are listed in the column
# label, so nothing is lost.
labelled_column <- function(x, labels) {
  v <- as.vector(unclass(x))
  attributes(v) <- NULL
  labels <- labels[order(as.vector(unclass(labels)))]
  codes <- as.vector(unclass(labels))
  key <- paste0(codes, " = ", names(labels))
  key <- paste(c(utils::head(key, 10L), if (length(key) > 10L) "..."), collapse = ", ")
  present <- !is.na(v)
  if (all(v[present] %in% codes)) {
    levels <- unique(names(labels))
    list(values = factor(names(labels)[match(v, codes)], levels = levels), levels = levels, key = key)
  } else {
    list(values = v, levels = NULL, key = key)
  }
}

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

frame_to_parquet <- function(df, compression = "gzip") {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  # gzip level 3 is nearly as small as the default level 6 and twice as fast.
  level <- if (compression == "gzip") 3L else NA_integer_
  nanoparquet::write_parquet(
    df, path,
    compression = compression,
    options = nanoparquet::parquet_options(compression_level = level)
  )
  readBin(path, "raw", file.size(path))
}

# Returns list(bytes, meta, nrow, ncol) for a data frame or a parquet path.
# Parquet files the browser can read are embedded as they are; everything
# else is written with `compression`.
encode_data <- function(data, rownames = NULL, compression = "gzip") {
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
    bytes = frame_to_parquet(prepared$data, compression),
    meta = prepared$meta,
    nrow = nrow(prepared$data),
    ncol = ncol(prepared$data)
  )
}

format_bytes <- function(n) {
  if (n >= 1e6) sprintf("%.1f MB", n / 1e6) else sprintf("%.0f KB", n / 1e3)
}
