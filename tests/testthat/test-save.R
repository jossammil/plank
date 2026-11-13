test_that("save_pqview() writes one self-contained file", {
  dir <- tempfile("pqview-save")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE))
  file <- file.path(dir, "cars.html")

  out <- save_pqview(mtcars, file, title = "Cars & trucks")
  expect_identical(out, file)
  expect_identical(list.files(dir), "cars.html")

  html <- readChar(file, file.size(file), useBytes = TRUE)
  expect_match(html, "<title>Cars &amp; trucks</title>", fixed = TRUE)
  expect_match(html, "PQView", fixed = TRUE)
  expect_match(html, "HTMLWidgets", fixed = TRUE)
  expect_match(html, ".pqv-toolbar", fixed = TRUE)
  expect_match(html, "application/json", fixed = TRUE)
  expect_match(html, "htmlwidget_container", fixed = TRUE)

  # nothing is loaded from another file or the network
  expect_false(grepl("<script[^>]*\\ssrc\\s*=", html, perl = TRUE))
  expect_false(grepl("<link[^>]*\\shref\\s*=", html, perl = TRUE))
})

test_that("save_pqview() accepts an existing widget and names the tab", {
  file <- tempfile(fileext = ".html")
  on.exit(unlink(file))
  save_pqview(pqview(iris), file)
  html <- readChar(file, file.size(file), useBytes = TRUE)
  expect_match(html, paste0("<title>", tools::file_path_sans_ext(basename(file)), "</title>"), fixed = TRUE)
})

test_that("non-ASCII names and values and paths with spaces survive the round trip", {
  df <- data.frame(x = 1:3)
  df[["café à la crème"]] <- c("naïve", "日本語", NA)
  df[["état"]] <- factor(c("été", "hiver", "été"))

  dir <- file.path(tempdir(), "folder with spaces é")
  dir.create(dir, showWarnings = FALSE)
  on.exit(unlink(dir, recursive = TRUE))
  file <- file.path(dir, "my data.html")

  w <- pqview(df, title = "Café data")
  save_pqview(w, file)
  expect_true(file.exists(file))

  html <- readLines(file, encoding = "UTF-8", warn = FALSE)
  expect_true(any(grepl("<title>Café data</title>", html, fixed = TRUE)))
  expect_true(validUTF8(paste(html, collapse = "\n")))
  expect_false(any(grepl("\r", html, fixed = TRUE)))

  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path), add = TRUE)
  writeBin(jsonlite::base64_dec(w$x$data), path)
  back <- as.data.frame(nanoparquet::read_parquet(path))
  expect_identical(names(back), names(df))
  expect_identical(back[[2]], df[[2]])
  expect_identical(w$x$meta[["état"]]$levels, list("hiver", "été"))
})
