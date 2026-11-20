// Bundles the viewer (app + hyparquet) into one classic script for htmlwidgets.
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'Plank',
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'none',
  banner: {
    js: '/*! Plank viewer. Bundles hyparquet and hyparquet-writer (MIT, (c) Hyperparam) and ' +
      'fflate and fzstd (MIT, (c) Arjun Barrett); see the COPYRIGHTS file of the plank R package. */',
  },
  outfile: '../inst/htmlwidgets/lib/plank/plank-core.js',
  metafile: true,
})
const [file, info] = Object.entries(result.metafile.outputs)[0]
console.log(`${file}: ${(info.bytes / 1024).toFixed(1)} KB`)
