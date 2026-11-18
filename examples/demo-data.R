# The synthetic data set behind examples/demo.html and examples/sample.pqv.html:
# n rows and 30 columns covering every column type. Used by make-demo.R and
# make-sample.R.
demo_data <- function(n = 100000) {
  set.seed(42)
  blank <- function(x, p = 0.03) {
    x[sample.int(n, round(n * p))] <- NA
    x
  }
  states <- c(state.name, "District of Columbia")

  demo <- data.frame(
    record_id = sprintf("R%06d", seq_len(n)),
    state = factor(sample(states, n, TRUE)),
    region = sample(c("Northeast", "South", "Midwest", "West"), n, TRUE),
    age = blank(sample(18:95, n, TRUE)),
    income = blank(round(rlnorm(n, 10.8, 0.7), 2), 0.08),
    score = round(rnorm(n, 50, 12), 4),
    enrolled = blank(sample(c(TRUE, FALSE), n, TRUE), 0.05),
    visit_date = blank(as.Date("2022-01-01") + sample(0:1095, n, TRUE)),
    updated_at = as.POSIXct("2024-01-01", tz = "America/Chicago") + sample(0:(366 * 86400), n, TRUE),
    comment = blank(paste(
      sample(c("follow up", "no issues", "needs review", "called patient", "left voicemail"), n, TRUE),
      sample(1000:9999, n, TRUE)
    ), 0.4),
    stringsAsFactors = FALSE
  )
  for (i in 1:10) demo[[sprintf("measure_%02d", i)]] <- blank(round(rnorm(n, i * 10, i), 3), 0.01)
  for (i in 1:5) demo[[sprintf("count_%02d", i)]] <- rpois(n, i * 3)
  for (i in 1:5) demo[[sprintf("category_%02d", i)]] <- sample(LETTERS[1:(i + 2)], n, TRUE)
  attr(demo$income, "label") <- "Household income (USD)"
  demo
}
