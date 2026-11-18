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

test_that("file names follow the .pqv.html convention", {
  expect_identical(save_paths("a/sales")$html, "a/sales.pqv.html")
  expect_identical(save_paths("sales.pqv")$html, "sales.pqv.html")
  expect_identical(save_paths("sales.pqv.html")$html, "sales.pqv.html")
  expect_identical(save_paths("sales.HTML")$html, "sales.HTML")
  expect_identical(save_paths("v1.2 data/sales")$html, "v1.2 data/sales.pqv.html")
  expect_null(save_paths("sales")$zip)
  expect_warning(p <- save_paths("sales.txt"), "does not end in .html")
  expect_identical(p$html, "sales.txt")

  expect_identical(save_paths("sales", zip = TRUE), list(html = "sales.pqv.html", zip = "sales.pqv.zip"))
  expect_identical(save_paths("sales.html", zip = TRUE)$zip, "sales.zip")
  expect_identical(save_paths("sales.zip"), list(html = "sales.pqv.html", zip = "sales.zip"))
  expect_identical(save_paths("sales.pqv.zip"), list(html = "sales.pqv.html", zip = "sales.pqv.zip"))
})

test_that("save_pqview() adds .pqv.html to a bare name", {
  dir <- tempfile("pqview-save")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE))
  out <- save_pqview(mtcars, file.path(dir, "cars"))
  expect_identical(out, file.path(dir, "cars.pqv.html"))
  expect_identical(list.files(dir), "cars.pqv.html")
  html <- readChar(out, file.size(out), useBytes = TRUE)
  expect_match(html, "<title>cars</title>", fixed = TRUE)
})

test_that("save_pqview(zip = TRUE) writes a zip archive holding the HTML file", {
  dir <- tempfile("pqview save é")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE))
  html <- save_pqview(iris, file.path(dir, "flowers.pqv.html"))
  out <- save_pqview(iris, file.path(dir, "flowers"), zip = TRUE)
  expect_identical(out, file.path(dir, "flowers.pqv.zip"))
  expect_setequal(list.files(dir), c("flowers.pqv.html", "flowers.pqv.zip"))
  expect_lt(file.size(out), file.size(html))

  # Saving again replaces the archive rather than adding to it
  save_pqview(iris, file.path(dir, "flowers.pqv.zip"))
  listed <- utils::unzip(out, list = TRUE)
  expect_identical(listed$Name, "flowers.pqv.html")
  unzipped <- file.path(dir, "unzipped")
  utils::unzip(out, exdir = unzipped)
  # The same page apart from the widget's random element id
  strip <- function(path) gsub("htmlwidget-[0-9a-f]+", "", readLines(path, encoding = "UTF-8"))
  expect_identical(strip(file.path(unzipped, "flowers.pqv.html")), strip(html))
})

test_that("zip archives can be written without the zip package", {
  skip_if(!nzchar(Sys.getenv("R_ZIPCMD", Sys.which("zip"))), "no zip program")
  dir <- tempfile("pqview zip é")
  dir.create(dir)
  on.exit(unlink(dir, recursive = TRUE))
  file <- file.path(dir, "a b.pqv.html")
  writeLines("hello", file)
  zipfile <- file.path(dir, "a b.pqv.zip")
  zip_one(file, zipfile, use_package = FALSE)
  zip_one(file, zipfile, use_package = FALSE)
  expect_identical(utils::unzip(zipfile, list = TRUE)$Name, "a b.pqv.html")
})
