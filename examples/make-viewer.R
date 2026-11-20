# Builds examples/viewer.plank.html: a blank viewer that opens CSV, TSV,
# Excel or parquet files, no R needed. Kept in the repository and published
# on the site as viewer.html. Run from the package root:
# Rscript examples/make-viewer.R
if (requireNamespace("pkgload", quietly = TRUE) && file.exists("DESCRIPTION")) {
  pkgload::load_all(quiet = TRUE)
} else {
  library(plank)
}

viewer <- save_plank(NULL, "examples/viewer.plank.html", title = "Plank")
cat(sprintf("%s: %.2f MB\n", viewer, file.size(viewer) / 1e6))
