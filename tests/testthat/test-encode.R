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

test_that("a data frame becomes gzip parquet bytes, or snappy on request", {
  enc <- encode_data(sample_frame())
  expect_identical(enc$bytes[1:4], charToRaw("PAR1"))
  expect_identical(utils::tail(enc$bytes, 4), charToRaw("PAR1"))
  expect_equal(enc$nrow, 50)
  expect_equal(enc$ncol, 7)

  back <- read_bytes(enc$bytes)
  expect_identical(back$codec, "GZIP")
  expect_equal(back$data$id, sample_frame()$id)
  expect_equal(back$data$name, sample_frame()$name)

  back <- read_bytes(encode_data(sample_frame(), compression = "snappy")$bytes)
  expect_identical(back$codec, "SNAPPY")
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

test_that("snappy and gzip parquet files are embedded as they are", {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  for (codec in c("snappy", "gzip")) {
    nanoparquet::write_parquet(sample_frame(), path, compression = codec)
    enc <- encode_data(path, compression = "snappy")
    expect_identical(enc$bytes, readBin(path, "raw", file.size(path)))
    expect_equal(enc$nrow, 50)
    expect_equal(enc$ncol, 7)
  }
})

test_that("other codecs are rewritten for the browser reader", {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  nanoparquet::write_parquet(sample_frame(), path, compression = "zstd")
  expect_identical(unique(nanoparquet::read_parquet_metadata(path)$column_chunks$codec), "ZSTD")
  back <- read_bytes(encode_data(path)$bytes)
  expect_identical(back$codec, "GZIP")
  expect_equal(nrow(back$data), 50)
  back <- read_bytes(encode_data(path, compression = "snappy")$bytes)
  expect_identical(back$codec, "SNAPPY")
})

test_that("bad inputs fail clearly", {
  expect_error(encode_data("no-such-file.parquet"), "File not found")
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  writeLines("this is not parquet at all", path)
  expect_error(encode_data(path), "Not a parquet file")
  expect_error(encode_data(function() NULL), "must be a data frame")
})

test_that("blank and repeated column names are fixed, with a message", {
  df <- setNames(data.frame(1:2, 3:4, 5:6, 7:8), c("", "b", "b", NA))
  expect_message(p <- prepare_frame(df), "renamed 3 columns")
  expect_identical(names(p$data), c("column_1", "b", "b.1", "column_4"))
  expect_identical(names(p$meta), names(p$data))
  expect_silent(prepare_frame(data.frame(a = 1, b = 2)))
  expect_message(w <- plank(setNames(data.frame(1:3), "")), "column_1")
  expect_s3_class(w, "plank")
})

test_that("labelled values are shown as their labels", {
  lab <- structure(c(1, 2, NA, 1), labels = c(Male = 1, Female = 2), label = "Sex",
                   class = c("haven_labelled", "vctrs_vctr", "double"))
  part <- structure(c(30, 99, 41), labels = c(Missing = 99), class = c("haven_labelled", "vctrs_vctr", "double"))
  df <- data.frame(id = 1:4)
  df$sex <- lab
  p <- prepare_frame(df)
  expect_s3_class(p$data$sex, "factor")
  expect_identical(as.character(p$data$sex), c("Male", "Female", NA, "Male"))
  expect_identical(p$meta$sex$levels, list("Male", "Female"))
  expect_identical(p$meta$sex$label, "Sex (value labels: 1 = Male, 2 = Female)")

  df2 <- data.frame(id = 1:3)
  df2$age <- part
  p2 <- prepare_frame(df2)
  expect_identical(p2$data$age, c(30, 99, 41))
  expect_identical(p2$meta$age$label, "(value labels: 99 = Missing)")
})
