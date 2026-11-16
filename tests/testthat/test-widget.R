decode_payload <- function(w) {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  writeBin(jsonlite::base64_dec(w$x$data), path)
  as.data.frame(nanoparquet::read_parquet(path))
}

test_that("pqview() builds a widget with the data embedded", {
  w <- pqview(iris, columns = c("Species", "Sepal.Length"), title = "Iris", digits = 4)
  expect_s3_class(w, c("pqview", "htmlwidget"))
  expect_length(w$x$data, 1)
  expect_false(grepl("\n", w$x$data, fixed = TRUE))
  expect_identical(w$x$columns, list("Species", "Sepal.Length"))
  expect_identical(w$x$title, "Iris")
  expect_equal(w$x$digits, 4)
  expect_identical(w$x$meta$Species$levels, as.list(levels(iris$Species)))

  back <- decode_payload(w)
  expect_equal(back$Sepal.Length, iris$Sepal.Length)
  expect_equal(as.character(back$Species), as.character(iris$Species))
})

test_that("optional fields are left out when not given", {
  w <- pqview(iris)
  expect_null(w$x$columns)
  expect_null(w$x$title)
  expect_identical(pqview(iris, columns = character(0))$x$columns, list())
})

test_that("pqview() accepts a parquet path", {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  nanoparquet::write_parquet(mtcars, path)
  w <- pqview(path)
  expect_equal(w$x$nrow, 32)
  expect_equal(decode_payload(w)$mpg, mtcars$mpg)
})

test_that("large payloads warn", {
  expect_warning(pqview(iris, max_bytes = 100), "may be slow")
})

test_that("arguments are validated", {
  expect_error(pqview(iris, theme = "neon"))
  expect_error(pqview(iris, digits = 0))
  expect_error(pqview(iris, columns = 1:2))
})

test_that("query, font, theme and offset options reach the browser", {
  w <- pqview(iris, where = "Sepal.Length > 5", font = "mono", theme = "dark", top_offset = 80)
  expect_identical(w$x$where, "Sepal.Length > 5")
  expect_identical(w$x$font, "mono")
  expect_identical(w$x$theme, "dark")
  expect_equal(w$x$top_offset, 80)

  d <- pqview(iris)
  expect_null(d$x$where)
  expect_identical(d$x$font, "sans")
  expect_equal(d$x$top_offset, 56)
  expect_null(pqview(iris, where = "  ")$x$where)

  expect_error(pqview(iris, font = "comic"))
  expect_error(pqview(iris, where = c("a", "b")))
  expect_error(pqview(iris, top_offset = -1))
})

test_that("notes are passed as one string, one line per element", {
  expect_null(pqview(iris)$x$notes)
  expect_identical(pqview(iris, notes = "Source: R")$x$notes, "Source: R")
  expect_identical(pqview(iris, notes = c("a", NA, "b"))$x$notes, "a\nb")
  expect_error(pqview(iris, notes = 1))
})
