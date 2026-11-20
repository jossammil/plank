#!/usr/bin/env bash
# Builds the public website and pushes it to the public repository
# jossammil/plank, which GitHub Pages serves at https://jossammil.github.io/plank/.
# Run from the package root: tools/publish-site.sh
# Optional first: Rscript examples/bench.R && (cd srcjs && node tools/bench-open.mjs)
set -euo pipefail
cd "$(dirname "$0")/.."
SITE_REPO="${SITE_REPO:-jossammil/plank}"
WORK="${TMPDIR:-/tmp}/plank-site-publish"

Rscript examples/make-demo.R
Rscript examples/make-viewer.R
(cd srcjs && node tools/build-site.mjs)

rm -rf "$WORK"
gh repo clone "$SITE_REPO" "$WORK" -- --depth 1 2>/dev/null || {
  mkdir -p "$WORK" && git -C "$WORK" init -q -b main
  git -C "$WORK" remote add origin "https://github.com/$SITE_REPO.git"
}
# Replace everything but the git folder with the fresh build.
find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R site-dist/. "$WORK"/
version=$(node -p "require('./srcjs/package.json').version")
git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then
  echo "Site unchanged; nothing to publish."
  exit 0
fi
git -C "$WORK" commit -q -m "Site for Plank $version"
git -C "$WORK" push -q origin HEAD:main
echo "Published Plank $version to https://github.com/$SITE_REPO (https://${SITE_REPO%%/*}.github.io/${SITE_REPO##*/}/)"
