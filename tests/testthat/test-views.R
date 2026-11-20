test_that("sort and counts reach the browser in the form it reads", {
  w <- plank(mtcars, sort = c("cyl", "-mpg"), counts = c("cyl", "gear"))
  expect_identical(w$x$sort, list(list(name = "cyl", dir = "asc"), list(name = "mpg", dir = "desc")))
  expect_identical(w$x$counts, list("cyl", "gear"))
  # a single sort column is still a list of one
  expect_identical(plank(mtcars, sort = "-hp")$x$sort, list(list(name = "hp", dir = "desc")))
  d <- plank(mtcars)
  expect_null(d$x$sort)
  expect_null(d$x$counts)
  expect_null(d$x$views)
})

test_that("sort and counts are checked against the data", {
  expect_error(plank(mtcars, sort = "nope"), "Unknown column in `sort`: 'nope'")
  expect_error(plank(mtcars, sort = "-nope"), "Unknown column in `sort`: '-nope'")
  expect_error(plank(mtcars, counts = c("cyl", "zzz")), "Unknown column in `counts`: 'zzz'")
  expect_error(plank(mtcars, counts = c("cyl", "gear", "am")), "one or two")
  expect_error(plank(mtcars, sort = 1), "character vector")
  # sorting needs the column to be shown (mtcars shows rowname and the first nine)
  expect_error(plank(mtcars, sort = "carb"), "must be shown: add 'carb'")
  expect_silent(plank(mtcars, columns = c("carb", "mpg"), sort = "carb"))
  # a column whose name starts with "-" sorts ascending under its own name
  df <- data.frame(`-x` = 3:1, x = 1:3, check.names = FALSE)
  expect_identical(plank(df, sort = "-x")$x$sort, list(list(name = "-x", dir = "asc")))
  expect_identical(plank(df, sort = "--x")$x$sort, list(list(name = "-x", dir = "desc")))
})

test_that("plank_view() checks its arguments and prints", {
  v <- plank_view(columns = c("mpg", "cyl"), where = "mpg > 25", sort = "-mpg", counts = "cyl")
  expect_s3_class(v, "plank_view")
  expect_output(print(v), "where    mpg > 25")
  expect_output(print(plank_view()), "starting columns")
  expect_error(plank_view(columns = 1), "character vector")
  expect_error(plank_view(where = c("a", "b")), "single string")
  expect_error(plank_view(counts = c("a", "b", "c")), "one or two")
  expect_error(plank_view(sort = NA_character_), "character vector")
})

test_that("views are sent as a list with checked columns", {
  w <- plank(mtcars, views = list(
    "Fuel-efficient" = plank_view(columns = c("mpg", "cyl", "hp"), where = "mpg > 25", sort = "-mpg"),
    "By cylinders" = plank_view(counts = c("cyl", "gear")),
    " Plain list " = list(where = "am = 1")
  ))
  v <- w$x$views
  expect_length(v, 3)
  expect_identical(v[[1]], list(
    name = "Fuel-efficient", columns = list("mpg", "cyl", "hp"), where = "mpg > 25",
    sort = list(list(name = "mpg", dir = "desc"))
  ))
  expect_identical(v[[2]], list(name = "By cylinders", counts = list("cyl", "gear")))
  expect_identical(v[[3]], list(name = "Plain list", where = "am = 1"))
  json <- htmlwidgets:::toJSON(w$x)
  expect_match(json, '"views":[{"name":"Fuel-efficient","columns":["mpg","cyl","hp"]', fixed = TRUE)
})

test_that("bad views fail with a clear message", {
  expect_error(plank(mtcars, views = plank_view()), "named list")
  expect_error(plank(mtcars, views = list(plank_view())), "needs a name")
  expect_error(plank(mtcars, views = list(a = plank_view(), a = plank_view())), "unique")
  expect_error(plank(mtcars, views = list(a = "x")), "plank_view")
  expect_error(plank(mtcars, views = list(a = plank_view(columns = "nope"))),
               "Unknown column in view 'a' `columns`: 'nope'")
  expect_error(plank(mtcars, views = list(a = plank_view(columns = "mpg", sort = "cyl"))),
               "view 'a' `sort` must be shown")
  expect_error(plank(mtcars, views = list(a = plank_view(counts = "zz"))), "view 'a' `counts`")
  # with no columns of its own, a view starts from the viewer's columns
  expect_silent(plank(mtcars, columns = c("carb", "mpg"), views = list(a = plank_view(sort = "carb"))))
})

test_that("column names come from parquet files too", {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  nanoparquet::write_parquet(mtcars[1:3], path)
  w <- plank(path, sort = "-disp", counts = "cyl")
  expect_identical(w$x$sort, list(list(name = "disp", dir = "desc")))
  expect_error(plank(path, counts = "hp"), "Unknown column")
})

test_that("pinned columns reach the browser and are checked", {
  w <- plank(mtcars, pin = c("mpg", "cyl"))
  expect_identical(w$x$pin, list("mpg", "cyl"))
  expect_null(plank(mtcars)$x$pin)
  expect_error(plank(mtcars, pin = "nope"), "Unknown column in `pin`")
  expect_error(plank(mtcars, pin = "carb"), "`pin` must be shown")
  v <- plank(mtcars, views = list(a = plank_view(columns = c("hp", "wt"), pin = "wt")))$x$views
  expect_identical(v[[1]]$pinned, list("wt"))
  expect_error(plank(mtcars, views = list(a = plank_view(columns = "hp", pin = "wt"))), "view 'a' `pin` must be shown")
  expect_output(print(plank_view(pin = "x")), "pin      x")
})

test_that("number formats reach the browser and are checked", {
  w <- plank(mtcars, formats = list(disp = list(decimals = 1, big_mark = TRUE), hp = list(big_mark = TRUE)))
  expect_identical(w$x$formats, list(disp = list(decimals = 1L, big_mark = TRUE), hp = list(big_mark = TRUE)))
  expect_null(plank(mtcars)$x$formats)
  expect_error(plank(mtcars, formats = list(list(decimals = 1))), "named list")
  expect_error(plank(mtcars, formats = list(zz = list(decimals = 1))), "Unknown column in `formats`")
  expect_error(plank(mtcars, formats = list(hp = list(decimals = 1.5))), "whole number")
  expect_error(plank(mtcars, formats = list(hp = list(big_mark = ","))), "TRUE or FALSE")
  expect_error(plank(mtcars, formats = list(hp = list(digits = 2))), "Unknown setting")
})

test_that("the add-in reads a selected object or parquet path", {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  nanoparquet::write_parquet(mtcars, path)
  expect_identical(addin_data(path), path)
  expect_identical(addin_data(paste0('"', path, '"')), path)
  e <- new.env()
  e$df <- iris
  expect_identical(addin_data("df", e), iris)
  expect_identical(addin_data("head(df, 3)", e), head(iris, 3))
  expect_true(file.exists(system.file("rstudio", "addins.dcf", package = "plank")))
})
