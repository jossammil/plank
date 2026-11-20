# Password protection: the data and everything that describes it are
# encrypted in R and decrypted in the reader's browser with WebCrypto.
#
# Key: PBKDF2-HMAC-SHA256 over the password (one 32-byte block), split with
# HMAC-SHA256 into an encryption key and a MAC key.
# Cipher: AES-256-CTR, then HMAC-SHA256 over the ciphertext (encrypt-then-MAC);
# the MAC also tells a wrong password from damaged data. (The openssl
# package's AES-GCM returns no authentication tag, so WebCrypto could not
# check it, and it has no PBKDF2, so that is written here.)
# Plaintext: a 4-byte length, the JSON of the payload fields that describe
# the data (column hints, columns, notes, query, sort, views...), then the
# parquet bytes.

PQV_KDF_ITER <- 300000L
# These labels keep their pre-rename spelling (pqview), so files locked by
# earlier versions still open. Never change them.
PQV_MAC_PREFIX <- "pqview1"

# Payload fields that reveal something about the data; they travel encrypted.
PQV_SECRET_FIELDS <- c("meta", "columns", "notes", "where", "sort", "pin", "formats", "counts", "views")

need_openssl <- function() {
  if (!requireNamespace("openssl", quietly = TRUE)) {
    stop("Password protection needs the openssl package: install.packages(\"openssl\").", call. = FALSE)
  }
}

# The password from `password =`: a string, or TRUE to ask for it (twice).
read_password <- function(password) {
  if (isTRUE(password)) {
    if (!requireNamespace("askpass", quietly = TRUE)) {
      stop("`password = TRUE` needs the askpass package; or pass the password as a string.", call. = FALSE)
    }
    first <- askpass::askpass("Password for the plank file")
    if (is.null(first)) stop("No password given.", call. = FALSE)
    again <- askpass::askpass("The same password again")
    if (!identical(first, again)) stop("The two passwords differ.", call. = FALSE)
    password <- first
  }
  if (!is.character(password) || length(password) != 1L || is.na(password) || !nzchar(password)) {
    stop("`password` must be a non-empty string, or TRUE to be asked for one.", call. = FALSE)
  }
  password
}

hmac256 <- function(key, data) {
  as.raw(openssl::sha256(data, key = key))
}

# PBKDF2-HMAC-SHA256 with a 32-byte result (one block).
pbkdf2_sha256 <- function(password, salt, iter) {
  pw <- charToRaw(enc2utf8(password))
  u <- hmac256(pw, c(salt, as.raw(c(0, 0, 0, 1))))
  acc <- u
  for (i in seq_len(iter - 1L)) {
    u <- hmac256(pw, u)
    acc <- xor(acc, u)
  }
  acc
}

derive_keys <- function(password, salt, iter) {
  master <- pbkdf2_sha256(password, salt, iter)
  list(
    enc = hmac256(master, charToRaw("pqview enc")),
    mac = hmac256(master, charToRaw("pqview mac"))
  )
}

int32_be <- function(n) {
  as.raw(c(n %/% 16777216, (n %/% 65536) %% 256, (n %/% 256) %% 256, n %% 256))
}

# JSON as htmlwidgets writes it, so the browser reads the same structure.
widget_json <- function(x) {
  jsonlite::toJSON(
    x, dataframe = "columns", null = "null", na = "null", auto_unbox = TRUE,
    digits = getOption("shiny.json.digits", 16), use_signif = TRUE, force = TRUE,
    POSIXt = "ISO8601", UTC = TRUE, rownames = FALSE, keep_vec_names = TRUE,
    json_verbatim = TRUE
  )
}

# Replaces the data and the fields that describe it with one encrypted blob.
encrypt_payload <- function(x, bytes, password, iter = PQV_KDF_ITER) {
  need_openssl()
  secret <- x[intersect(PQV_SECRET_FIELDS, names(x))]
  json <- charToRaw(enc2utf8(as.character(widget_json(secret))))
  plain <- c(int32_be(length(json)), json, bytes)

  salt <- openssl::rand_bytes(16)
  # The counter's low 64 bits start at zero, so AES-CTR counts the same way in
  # OpenSSL (128-bit counter) and WebCrypto (64-bit counter).
  iv <- c(openssl::rand_bytes(8), as.raw(rep(0, 8)))
  keys <- derive_keys(password, salt, iter)
  ct <- openssl::aes_ctr_encrypt(plain, key = keys$enc, iv = iv)
  mac <- hmac256(keys$mac, c(charToRaw(PQV_MAC_PREFIX), salt, iv, ct))

  b64 <- function(r) gsub("\n", "", jsonlite::base64_enc(r), fixed = TRUE)
  out <- x[setdiff(names(x), c(PQV_SECRET_FIELDS, "data", "nrow", "ncol"))]
  out$data <- b64(ct)
  out$enc <- list(v = 1L, kdf = "PBKDF2-SHA256", iter = iter, salt = b64(salt), iv = b64(iv), mac = b64(mac))
  out
}

# The inverse, for tests: the parquet bytes and the hidden fields.
decrypt_payload <- function(x, password) {
  need_openssl()
  e <- x$enc
  salt <- jsonlite::base64_dec(e$salt)
  iv <- jsonlite::base64_dec(e$iv)
  ct <- jsonlite::base64_dec(x$data)
  keys <- derive_keys(password, salt, e$iter)
  mac <- hmac256(keys$mac, c(charToRaw(PQV_MAC_PREFIX), salt, iv, ct))
  if (!identical(mac, jsonlite::base64_dec(e$mac))) stop("Wrong password, or the data was changed.", call. = FALSE)
  plain <- openssl::aes_ctr_decrypt(ct, key = keys$enc, iv = iv)
  n <- sum(as.integer(plain[1:4]) * c(16777216, 65536, 256, 1))
  list(
    fields = jsonlite::fromJSON(rawToChar(plain[4 + seq_len(n)]), simplifyVector = FALSE),
    bytes = plain[-seq_len(4 + n)]
  )
}
