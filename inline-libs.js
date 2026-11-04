#!/usr/bin/env node
// Prints the <style>/<script> tags to inline into breakdown.html.
//
// Usage: node inline-libs.js < chapters.html
//
// Reads the book's chapter HTML on stdin and embeds only the renderer libraries
// it uses (cdn-scripts.js USAGE), straight from node_modules. The result has no
// network dependencies, so the single HTML file works offline and can be sent
// to a phone or anyone else as-is.

const fs = require('fs');
const path = require('path');
const { KATEX_HEAD, RENDERER_SCRIPTS, RENDERER_STYLES, USAGE } = require('./cdn-scripts.js');

const NPM_URL = /\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/;

function parse(url) {
  const m = NPM_URL.exec(url);
  if (!m) throw new Error(`cdn-scripts.js: not a jsdelivr /npm/ URL: ${url}`);
  return { pkg: m[1], version: m[2], file: m[3], url };
}

function read({ pkg, version, file }) {
  const pkgDir = path.join(__dirname, 'node_modules', pkg);
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  } catch {
    throw new Error(`${pkg} is not installed — run \`npm install\` in the repo root.`);
  }
  if (installed !== version) {
    throw new Error(
      `${pkg}: cdn-scripts.js pins ${version} but ${installed} is installed — ` +
      `run \`npm install --save-exact ${pkg}@${version}\`.`
    );
  }
  // jsdelivr serves *.min.js on the fly; some packages only ship the plain file.
  let target = path.join(pkgDir, file);
  if (!fs.existsSync(target)) target = target.replace(/\.min\.js$/, '.js');
  return fs.readFileSync(target, 'utf8');
}

// KaTeX CSS references font files by relative URL; embed them so the CSS is standalone.
function inlineCss({ pkg, file }, css) {
  const cssDir = path.dirname(path.join(__dirname, 'node_modules', pkg, file));
  return css.replace(/url\((fonts\/[^)]+\.woff2)\)/g, (_, rel) => {
    const data = fs.readFileSync(path.join(cssDir, rel)).toString('base64');
    return `url(data:font/woff2;base64,${data})`;
  });
}

const urlsOf = (tags) => tags.flatMap((t) => t.match(/https:\/\/[^"]+/g));

function main() {
  const html = fs.readFileSync(0, 'utf8');
  const used = (lib) => USAGE[lib.pkg] && USAGE[lib.pkg].test(html);
  const styles = [...urlsOf(KATEX_HEAD).filter((u) => u.endsWith('.css')), ...RENDERER_STYLES].map(parse);
  const scripts = [...urlsOf(KATEX_HEAD).filter((u) => u.endsWith('.js')), ...RENDERER_SCRIPTS].map(parse);

  const out = [];
  for (const lib of styles.filter(used)) {
    out.push(`<style>\n${inlineCss(lib, read(lib))}\n</style>`);
  }
  for (const lib of scripts.filter(used)) {
    // A literal </script inside the library would end the tag early.
    out.push(`<script>\n${read(lib).replace(/<\/script/gi, '<\\/script')}\n</script>`);
  }
  process.stdout.write(out.join('\n'));
}

try {
  main();
} catch (err) {
  console.error(`inline-libs: ${err.message}`);
  process.exit(1);
}
