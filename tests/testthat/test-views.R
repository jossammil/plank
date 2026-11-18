test_that("sort and counts reach the browser in the form it reads", {
  w <- pqview(mtcars, sort = c("cyl", "-mpg"), counts = c("cyl", "gear"))
  expect_identical(w$x$sort, list(list(name = "cyl", dir = "asc"), list(name = "mpg", dir = "desc")))
  expect_identical(w$x$counts, list("cyl", "gear"))
  # a single sort column is still a list of one
  expect_identical(pqview(mtcars, sort = "-hp")$x$sort, list(list(name = "hp", dir = "desc")))
  d <- pqview(mtcars)
  expect_null(d$x$sort)
  expect_null(d$x$counts)
  expect_null(d$x$views)
})

test_that("sort and counts are checked against the data", {
  expect_error(pqview(mtcars, sort = "nope"), "Unknown column in `sort`: 'nope'")
  expect_error(pqview(mtcars, sort = "-nope"), "Unknown column in `sort`: '-nope'")
  expect_error(pqview(mtcars, counts = c("cyl", "zzz")), "Unknown column in `counts`: 'zzz'")
  expect_error(pqview(mtcars, counts = c("cyl", "gear", "am")), "one or two")
  expect_error(pqview(mtcars, sort = 1), "character vector")
  # sorting needs the column to be shown (mtcars shows rowname and the first nine)
  expect_error(pqview(mtcars, sort = "carb"), "must be shown: add 'carb'")
  expect_silent(pqview(mtcars, columns = c("carb", "mpg"), sort = "carb"))
  # a column whose name starts with "-" sorts ascending under its own name
  df <- data.frame(`-x` = 3:1, x = 1:3, check.names = FALSE)
  expect_identical(pqview(df, sort = "-x")$x$sort, list(list(name = "-x", dir = "asc")))
  expect_identical(pqview(df, sort = "--x")$x$sort, list(list(name = "-x", dir = "desc")))
})

test_that("pqview_view() checks its arguments and prints", {
  v <- pqview_view(columns = c("mpg", "cyl"), where = "mpg > 25", sort = "-mpg", counts = "cyl")
  expect_s3_class(v, "pqview_view")
  expect_output(print(v), "where    mpg > 25")
  expect_output(print(pqview_view()), "starting columns")
  expect_error(pqview_view(columns = 1), "character vector")
  expect_error(pqview_view(where = c("a", "b")), "single string")
  expect_error(pqview_view(counts = c("a", "b", "c")), "one or two")
  expect_error(pqview_view(sort = NA_character_), "character vector")
})

test_that("views are sent as a list with checked columns", {
  w <- pqview(mtcars, views = list(
    "Fuel-efficient" = pqview_view(columns = c("mpg", "cyl", "hp"), where = "mpg > 25", sort = "-mpg"),
    "By cylinders" = pqview_view(counts = c("cyl", "gear")),
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
  expect_error(pqview(mtcars, views = pqview_view()), "named list")
  expect_error(pqview(mtcars, views = list(pqview_view())), "needs a name")
  expect_error(pqview(mtcars, views = list(a = pqview_view(), a = pqview_view())), "unique")
  expect_error(pqview(mtcars, views = list(a = "x")), "pqview_view")
  expect_error(pqview(mtcars, views = list(a = pqview_view(columns = "nope"))),
               "Unknown column in view 'a' `columns`: 'nope'")
  expect_error(pqview(mtcars, views = list(a = pqview_view(columns = "mpg", sort = "cyl"))),
               "view 'a' `sort` must be shown")
  expect_error(pqview(mtcars, views = list(a = pqview_view(counts = "zz"))), "view 'a' `counts`")
  # with no columns of its own, a view starts from the viewer's columns
  expect_silent(pqview(mtcars, columns = c("carb", "mpg"), views = list(a = pqview_view(sort = "carb"))))
})

test_that("column names come from parquet files too", {
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  nanoparquet::write_parquet(mtcars[1:3], path)
  w <- pqview(path, sort = "-disp", counts = "cyl")
  expect_identical(w$x$sort, list(list(name = "disp", dir = "desc")))
  expect_error(pqview(path, counts = "hp"), "Unknown column")
})

test_that("pinned columns reach the browser and are checked", {
  w <- pqview(mtcars, pin = c("mpg", "cyl"))
  expect_identical(w$x$pin, list("mpg", "cyl"))
  expect_null(pqview(mtcars)$x$pin)
  expect_error(pqview(mtcars, pin = "nope"), "Unknown column in `pin`")
  expect_error(pqview(mtcars, pin = "carb"), "`pin` must be shown")
  v <- pqview(mtcars, views = list(a = pqview_view(columns = c("hp", "wt"), pin = "wt")))$x$views
  expect_identical(v[[1]]$pinned, list("wt"))
  expect_error(pqview(mtcars, views = list(a = pqview_view(columns = "hp", pin = "wt"))), "view 'a' `pin` must be shown")
  expect_output(print(pqview_view(pin = "x")), "pin      x")
})
