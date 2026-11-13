// Bundles the viewer (app + hyparquet) into one classic script for htmlwidgets.
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'PQView',
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'none',
  outfile: '../inst/htmlwidgets/lib/pqview/pqview-core.js',
  metafile: true,
})
const [file, info] = Object.entries(result.metafile.outputs)[0]
console.log(`${file}: ${(info.bytes / 1024).toFixed(1)} KB`)
