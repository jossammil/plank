sample_frame <- function(n = 50) {
  data.frame(
    id = seq_len(n),
    value = c(NA, stats::rnorm(n - 1)),
    name = paste0("item_", seq_len(n)),
    group = factor(rep(c("b", "a"), length.out = n), levels = c("b", "a", "unused")),
    flag = rep(c(TRUE, FALSE, NA), length.out = n),
    day = as.Date("2024-01-01") + seq_len(n),
    when = as.POSIXct("2024-01-01 12:00:00", tz = "America/Chicago") + seq_len(n) * 3600,
    stringsAsFactors = FALSE
  )
}

read_bytes <- function(bytes) {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  writeBin(bytes, path)
  list(
    data = as.data.frame(nanoparquet::read_parquet(path)),
    codec = unique(nanoparquet::read_parquet_metadata(path)$column_chunks$codec)
  )
}

test_that("a data frame becomes snappy parquet bytes", {
  enc <- encode_data(sample_frame())
  expect_identical(enc$bytes[1:4], charToRaw("PAR1"))
  expect_identical(utils::tail(enc$bytes, 4), charToRaw("PAR1"))
  expect_equal(enc$nrow, 50)
  expect_equal(enc$ncol, 7)

  back <- read_bytes(enc$bytes)
  expect_identical(back$codec, "SNAPPY")
  expect_equal(back$data$id, sample_frame()$id)
  expect_equal(back$data$name, sample_frame()$name)
})

test_that("column hints carry what parquet does not", {
  df <- sample_frame()
  attr(df$value, "label") <- "Measured value"
  meta <- encode_data(df)$meta
  expect_identical(meta$group$levels, list("b", "a", "unused"))
  expect_identical(meta$when$tz, "America/Chicago")
  expect_identical(meta$value$label, "Measured value")
  expect_identical(meta$day$class, "Date")
})

test_that("list columns and row names are flattened", {
  df <- data.frame(x = 1:2, row.names = c("first", "second"))
  df$items <- list(1:3, NULL)
  enc <- encode_data(df)
  back <- read_bytes(enc$bytes)$data
  expect_identical(names(back), c("rowname", "x", "items"))
  expect_identical(back$rowname, c("first", "second"))
  expect_identical(back$items, c("[1,2,3]", NA))

  expect_identical(names(read_bytes(encode_data(df, rownames = FALSE)$bytes)$data), c("x", "items"))
  expect_identical(names(read_bytes(encode_data(mtcars[1:3, 1:2])$bytes)$data), c("rowname", "mpg", "cyl"))
  expect_identical(names(read_bytes(encode_data(iris[1:3, 1:2])$bytes)$data), c("Sepal.Length", "Sepal.Width"))
})

test_that("a snappy parquet file is embedded as is", {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  nanoparquet::write_parquet(sample_frame(), path, compression = "snappy")
  enc <- encode_data(path)
  expect_identical(enc$bytes, readBin(path, "raw", file.size(path)))
  expect_equal(enc$nrow, 50)
  expect_equal(enc$ncol, 7)
})

test_that("other codecs are rewritten for the browser reader", {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  nanoparquet::write_parquet(sample_frame(), path, compression = "gzip")
  expect_identical(unique(nanoparquet::read_parquet_metadata(path)$column_chunks$codec), "GZIP")
  back <- read_bytes(encode_data(path)$bytes)
  expect_identical(back$codec, "SNAPPY")
  expect_equal(nrow(back$data), 50)
})

test_that("bad inputs fail clearly", {
  expect_error(encode_data("no-such-file.parquet"), "File not found")
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  writeLines("this is not parquet at all", path)
  expect_error(encode_data(path), "Not a parquet file")
  expect_error(encode_data(function() NULL), "must be a data frame")
})
