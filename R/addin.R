# RStudio add-in: view the selected object or parquet path in plank.
# Listed in inst/rstudio/addins.dcf.
plank_addin <- function() {
  if (!requireNamespace("rstudioapi", quietly = TRUE) || !rstudioapi::isAvailable()) {
    stop("The plank add-in needs RStudio and the rstudioapi package.", call. = FALSE)
  }
  ctx <- rstudioapi::getSourceEditorContext()
  text <- if (is.null(ctx)) "" else trimws(ctx$selection[[1]]$text)
  if (!nzchar(text)) {
    text <- rstudioapi::showPrompt("plank", "Data frame, or path to a parquet file:", "")
    if (is.null(text) || !nzchar(trimws(text))) return(invisible())
    text <- trimws(text)
  }
  print(plank(addin_data(text), title = text))
  invisible()
}

# A quoted or bare path to an existing .parquet file, else an R expression.
addin_data <- function(text, envir = globalenv()) {
  path <- gsub("^[\"']|[\"']$", "", text)
  if (grepl("\\.parquet$", path, ignore.case = TRUE) && file.exists(path)) return(path)
  eval(parse(text = text), envir = envir)
}
