decode_payload <- function(w) {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  writeBin(jsonlite::base64_dec(w$x$data), path)
  as.data.frame(nanoparquet::read_parquet(path))
}

test_that("plank() builds a widget with the data embedded", {
  w <- plank(iris, columns = c("Species", "Sepal.Length"), title = "Iris", digits = 4)
  expect_s3_class(w, c("plank", "htmlwidget"))
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
  w <- plank(iris)
  expect_null(w$x$columns)
  expect_null(w$x$title)
  expect_identical(plank(iris, columns = character(0))$x$columns, list())
})

test_that("plank() accepts a parquet path", {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  nanoparquet::write_parquet(mtcars, path)
  w <- plank(path)
  expect_equal(w$x$nrow, 32)
  expect_equal(decode_payload(w)$mpg, mtcars$mpg)
})

test_that("large payloads warn", {
  expect_warning(plank(iris, max_bytes = 100), "may be slow")
})

test_that("arguments are validated", {
  expect_error(plank(iris, theme = "neon"))
  expect_error(plank(iris, digits = 0))
  expect_error(plank(iris, columns = 1:2))
})

test_that("query, font, theme and offset options reach the browser", {
  w <- plank(iris, where = "Sepal.Length > 5", font = "mono", theme = "dark", top_offset = 80)
  expect_identical(w$x$where, "Sepal.Length > 5")
  expect_identical(w$x$font, "mono")
  expect_identical(w$x$theme, "dark")
  expect_equal(w$x$top_offset, 80)

  d <- plank(iris)
  expect_null(d$x$where)
  expect_identical(d$x$font, "mono")
  expect_identical(d$x$theme, "auto")
  expect_equal(d$x$top_offset, 0)
  expect_null(plank(iris, where = "  ")$x$where)

  expect_error(plank(iris, font = "comic"))
  expect_error(plank(iris, compression = "zstd"))
  expect_error(plank(iris, where = c("a", "b")))
  expect_error(plank(iris, top_offset = -1))
})

test_that("every theme and font is accepted", {
  for (theme in c("auto", "classic", "modern", "dark", "vintage", "starship")) {
    expect_identical(plank(iris, theme = theme)$x$theme, theme)
  }
  # old names
  expect_identical(plank(iris, theme = "terminal")$x$theme, "starship")
  expect_identical(plank(iris, theme = "light")$x$theme, "classic")
  for (font in c("mono", "sans", "serif")) {
    expect_identical(plank(iris, font = font)$x$font, font)
  }
  expect_error(plank(iris, theme = "sepia"))
  expect_identical(plank(iris)$x$controls, "top")
  expect_identical(plank(iris, controls = "bottom")$x$controls, "bottom")
  expect_identical(plank(NULL, controls = "bottom")$x$controls, "bottom")
  expect_error(plank(iris, controls = "left"))
  expect_error(plank(iris, font = "cursive"))
})

test_that("notes are passed as one string, one line per element", {
  expect_null(plank(iris)$x$notes)
  expect_identical(plank(iris, notes = "Source: R")$x$notes, "Source: R")
  expect_identical(plank(iris, notes = c("a", NA, "b"))$x$notes, "a\nb")
  expect_error(plank(iris, notes = 1))
})

test_that("plank(NULL) makes a blank viewer that opens files", {
  w <- plank(NULL, title = "Open data", theme = "dark", minimal = TRUE)
  expect_s3_class(w, "plank")
  expect_null(w$x$data)
  expect_identical(w$x$title, "Open data")
  expect_identical(w$x$theme, "dark")
  expect_true(w$x$minimal)

  file <- tempfile(fileext = ".html")
  on.exit(unlink(file))
  out <- save_plank(NULL, file)
  html <- readChar(out, file.size(out), useBytes = TRUE)
  expect_match(html, "Plank", fixed = TRUE)
  expect_false(grepl('"data":', html, fixed = TRUE))
})

test_that("minimal is passed to the browser and checked", {
  expect_false(plank(mtcars)$x$minimal)
  expect_true(plank(mtcars, minimal = TRUE)$x$minimal)
  expect_error(plank(mtcars, minimal = NA))
})
