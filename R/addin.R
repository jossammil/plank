# RStudio add-in: view the selected object or parquet path in pqview.
# Listed in inst/rstudio/addins.dcf.
pqview_addin <- function() {
  if (!requireNamespace("rstudioapi", quietly = TRUE) || !rstudioapi::isAvailable()) {
    stop("The pqview add-in needs RStudio and the rstudioapi package.", call. = FALSE)
  }
  ctx <- rstudioapi::getSourceEditorContext()
  text <- if (is.null(ctx)) "" else trimws(ctx$selection[[1]]$text)
  if (!nzchar(text)) {
    text <- rstudioapi::showPrompt("pqview", "Data frame, or path to a parquet file:", "")
    if (is.null(text) || !nzchar(trimws(text))) return(invisible())
    text <- trimws(text)
  }
  print(pqview(addin_data(text), title = text))
  invisible()
}

# A quoted or bare path to an existing .parquet file, else an R expression.
addin_data <- function(text, envir = globalenv()) {
  path <- gsub("^[\"']|[\"']$", "", text)
  if (grepl("\\.parquet$", path, ignore.case = TRUE) && file.exists(path)) return(path)
  eval(parse(text = text), envir = envir)
}
