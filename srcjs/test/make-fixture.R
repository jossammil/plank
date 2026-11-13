# Regenerates test/fixtures/sample.parquet. Run from srcjs/: Rscript test/make-fixture.R
n <- 100
df <- data.frame(
  id = seq_len(n),
  value = c(NA, seq(0.5, by = 0.5, length.out = n - 1)),
  name = c(paste0("item_", seq_len(n - 1)), NA),
  group = factor(rep(c("b", "a", "c", NA), length.out = n), levels = c("b", "a", "c")),
  flag = rep(c(TRUE, FALSE, NA), length.out = n),
  day = as.Date("2024-01-01") + seq_len(n) - 1,
  when = as.POSIXct("2024-03-09 12:00:00", tz = "UTC") + (seq_len(n) - 1) * 3600,
  stringsAsFactors = FALSE
)
nanoparquet::write_parquet(
  df, "test/fixtures/sample.parquet",
  compression = "snappy",
  options = nanoparquet::parquet_options(num_rows_per_row_group = 40)
)
