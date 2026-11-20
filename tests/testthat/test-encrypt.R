test_that("PBKDF2-HMAC-SHA256 matches the published test vectors", {
  skip_if_not_installed("openssl")
  hex <- function(r) paste(as.character(r), collapse = "")
  expect_identical(hex(pbkdf2_sha256("password", charToRaw("salt"), 1L)),
    "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b")
  expect_identical(hex(pbkdf2_sha256("password", charToRaw("salt"), 4096L)),
    "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a")
})

test_that("a protected payload hides the data and everything about it", {
  skip_if_not_installed("openssl")
  df <- data.frame(id = 1:3, region = factor(c("West", "South", "West")), secret_col = c(1.5, NA, 3))
  w <- plank(df, title = "Mine", notes = "private note", where = "secret_col > 1",
              views = list(V = plank_view(columns = "region")))
  x <- encrypt_payload(w$x, encode_data(df)$bytes, "pw", iter = 1000L)
  json <- as.character(widget_json(x))
  for (leak in c("West", "South", "secret_col", "private note", "region")) {
    expect_false(grepl(leak, json, fixed = TRUE), info = leak)
  }
  expect_identical(x$title, "Mine")
  expect_null(x$meta)
  expect_null(x$nrow)

  back <- decrypt_payload(x, "pw")
  expect_identical(back$fields$notes, "private note")
  expect_identical(back$fields$where, "secret_col > 1")
  expect_identical(unlist(back$fields$meta$region$levels), c("South", "West"))
  path <- tempfile(fileext = ".parquet")
  on.exit(unlink(path))
  writeBin(back$bytes, path)
  expect_identical(nrow(nanoparquet::read_parquet(path)), 3L)

  expect_error(decrypt_payload(x, "nope"), "Wrong password")
  # a fresh salt and IV each time
  y <- encrypt_payload(w$x, encode_data(df)$bytes, "pw", iter = 1000L)
  expect_false(identical(x$data, y$data))
})

test_that("plank(password =) encrypts; TRUE asks twice", {
  skip_if_not_installed("openssl")
  skip_if_not_installed("askpass")
  w <- plank(mtcars, password = "pw")
  expect_identical(w$x$enc$iter, PQV_KDF_ITER)
  expect_null(w$x$meta)
  expect_error(plank(mtcars, password = ""), "non-empty")
  expect_error(plank(NULL, password = "pw"), "needs data")

  answers <- c("abc", "abc")
  local_mocked_bindings(askpass = function(...) {
    a <- answers[1]
    answers <<- answers[-1]
    a
  }, .package = "askpass")
  expect_identical(read_password(TRUE), "abc")
  answers <- c("abc", "abd")
  expect_error(read_password(TRUE), "differ")
})
