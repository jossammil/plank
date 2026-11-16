# Reads the files the end-to-end test exported (west.rds, west.parquet,
# west.xlsx) and prints a JSON summary for e2e.mjs to compare with R's own
# numbers. Usage: Rscript check-exports.R <dir>
dir <- commandArgs(TRUE)[1]
summarise <- function(x) {
  x <- as.data.frame(x)
  list(
    nrow = nrow(x),
    names = names(x),
    classes = paste(vapply(x, function(v) class(v)[1], ""), collapse = "|"),
    income_sum = sum(as.numeric(x$income), na.rm = TRUE),
    age_na = sum(is.na(x$age)),
    visit_first = format(as.Date(x$visit_date[1])),
    updated_first = if (inherits(x$updated_at, "POSIXct")) format(x$updated_at[1], "%Y-%m-%d %H:%M:%S") else NA,
    tz = if (inherits(x$updated_at, "POSIXct")) attr(x$updated_at, "tzone") else NA
  )
}
out <- list(
  rds = summarise(readRDS(file.path(dir, "west.rds"))),
  parquet = if (requireNamespace("nanoparquet", quietly = TRUE)) summarise(nanoparquet::read_parquet(file.path(dir, "west.parquet"))),
  xlsx = if (requireNamespace("readxl", quietly = TRUE)) summarise(readxl::read_excel(file.path(dir, "west.xlsx")))
)
cat(jsonlite::toJSON(out, auto_unbox = TRUE, digits = NA, null = "null"))
