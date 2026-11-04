// Single source of truth for renderer CDN URLs.
//
// Consumers:
//   - build-book.sh        — via inline-libs.js, which inlines the libraries the book
//                            uses so breakdown.html is a single self-contained file
//   - verify-render.js     — via `require('../cdn-scripts.js').RENDERER_SCRIPTS`
//   - verify-collisions.js — via `require('../cdn-scripts.js').RENDERER_SCRIPTS`
//
// When adding a new renderer skill that needs a new CDN script:
//   1. Add the URL to RENDERER_SCRIPTS below (exact version, jsdelivr /npm/ URL).
//   2. `npm install --save-exact <pkg>@<version>` in the repo root — build-book.sh
//      inlines the copy from node_modules, so it must match the URL's version.
//   3. Add a USAGE pattern (below) so books only embed the library when they use it.
//   Verifiers load the URLs directly.
//
// KaTeX is for the build only (renders inline math in the published HTML);
// it's not needed for visual verification.

const RENDERER_SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js',
  'https://cdn.jsdelivr.net/npm/vexflow@5.0.0/build/cjs/vexflow.js',
  'https://cdn.jsdelivr.net/npm/p5@1.9.4/lib/p5.min.js',
  'https://cdn.jsdelivr.net/npm/3dmol@2.4.0/build/3Dmol-min.js',
  'https://cdn.jsdelivr.net/npm/jsxgraph@1.12.2/distrib/jsxgraphcore.js',
  'https://cdn.jsdelivr.net/npm/@svgdotjs/svg.js@3.2.8/dist/svg.min.js',
];

const RENDERER_STYLES = [
  'https://cdn.jsdelivr.net/npm/jsxgraph@1.12.2/distrib/jsxgraph.css',
];

const KATEX_HEAD = [
  '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css">',
  '<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js"></script>',
  '<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/contrib/auto-render.min.js"></script>',
];

// npm package name -> pattern that signals a book's chapter HTML needs it.
// Used by inline-libs.js; libraries without a match are left out of the book.
const USAGE = {
  'roughjs': /\brough\.(canvas|svg)\b/,
  'chart.js': /\bnew Chart\(/,
  'vexflow': /\bVexFlow\b/,
  'p5': /\bnew p5\(/,
  '3dmol': /\$3Dmol\b/,
  'jsxgraph': /\bJXG\b/,
  '@svgdotjs/svg.js': /\bSVG\(/,
  'katex': /class="math/,
};

module.exports = { RENDERER_SCRIPTS, RENDERER_STYLES, KATEX_HEAD, USAGE };
