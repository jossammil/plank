# Size and speed numbers for the public site (the R side): the same
# 100,000 x 30 data saved as Excel (openxlsx) and as a plank file, plus the
# zip and password versions. Also writes CSV, xlsx and parquet copies to
# examples/bench/ for srcjs/tools/bench-open.mjs, which measures opening them.
# Run from the package root: Rscript examples/bench.R
if (requireNamespace("pkgload", quietly = TRUE) && file.exists("DESCRIPTION")) {
  pkgload::load_all(quiet = TRUE)
} else {
  library(plank)
}
source("examples/demo-data.R")
stopifnot(requireNamespace("openxlsx", quietly = TRUE), requireNamespace("jsonlite", quietly = TRUE))

dir <- "examples/bench"
dir.create(dir, showWarnings = FALSE)
data <- demo_data(100000)
timed <- function(expr) {
  t <- system.time(force(expr))[["elapsed"]]
  round(t, 2)
}
mb <- function(path) round(file.size(path) / 1e6, 2)

xlsx <- file.path(dir, "data.xlsx")
t_xlsx <- timed(openxlsx::write.xlsx(data, xlsx))
html <- file.path(dir, "data.plank.html")
t_html <- timed(save_plank(data, html, title = "Plank demo"))
zipped <- file.path(dir, "data.plank.zip")
t_zip <- timed(save_plank(data, zipped, title = "Plank demo"))
locked <- file.path(dir, "locked.plank.html")
t_locked <- timed(save_plank(data, locked, title = "Plank demo", password = "bench only"))
csv <- file.path(dir, "data.csv")
utils::write.csv(data, csv, row.names = FALSE, na = "")
parquet <- file.path(dir, "data.parquet")
nanoparquet::write_parquet(data, parquet)

out <- "site/bench.json"
bench <- if (file.exists(out)) jsonlite::read_json(out) else list()
bench$r <- list(
  measured = format(Sys.Date()),
  machine = paste(Sys.info()[["sysname"]], Sys.info()[["machine"]], "R", getRversion()),
  rows = nrow(data), cols = ncol(data),
  xlsx = list(mb = mb(xlsx), write_s = t_xlsx),
  plank = list(mb = mb(html), write_s = t_html),
  zip = list(mb = mb(zipped), write_s = t_zip),
  locked = list(mb = mb(locked), write_s = t_locked),
  csv_mb = mb(csv), parquet_mb = mb(parquet)
)
jsonlite::write_json(bench, out, auto_unbox = TRUE, pretty = TRUE)
str(bench$r)
