/**
 * Stamp a build id onto every asset URL.
 *
 * GitHub Pages sends its own cache headers and offers no way to change them,
 * and an iOS WKWebView (which is what the standalone WebXR browsers are) will
 * happily keep serving stale ES modules long after a deploy. Re-fetching
 * index.html is not enough: its imports are separate URLs, and a module graph
 * whose URLs never change is a module graph the browser never re-downloads.
 *
 * So every local module specifier, stylesheet and import-map entry gets a
 * `?v=<build>` suffix. New build, new URLs, nothing to go stale.
 *
 *   node tools/stamp.mjs <build-id> [outDir]
 */
import { cp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const build = process.argv[2] ?? 'dev';
const outDir = process.argv[3] ?? join(ROOT, 'dist');

const COPY = ['index.html', 'styles.css', '.nojekyll', 'src', 'vendor'];

/** Local relative specifiers only — never touch bare names like "three". */
const SPECIFIER = /(\bfrom\s*|\bimport\s*)(['"])(\.\.?\/[^'"?]+?\.js)\2/g;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

await mkdir(outDir, { recursive: true });
for (const item of COPY) {
  await cp(join(ROOT, item), join(outDir, item), { recursive: true }).catch(() => {});
}

let stamped = 0;

for (const file of await walk(join(outDir, 'src'))) {
  if (extname(file) !== '.js') continue;
  const src = await readFile(file, 'utf8');
  const next = src.replace(SPECIFIER, (_m, kw, q, spec) => {
    stamped++;
    return `${kw}${q}${spec}?v=${build}${q}`;
  });
  if (next !== src) await writeFile(file, next);
}

const htmlPath = join(outDir, 'index.html');
let html = await readFile(htmlPath, 'utf8');
html = html
  .replace('"./vendor/three.module.js"', `"./vendor/three.module.js?v=${build}"`)
  .replace('href="./styles.css"', `href="./styles.css?v=${build}"`)
  .replace('src="./src/main.js"', `src="./src/main.js?v=${build}"`)
  .replace('data-build=""', `data-build="${build}"`);
await writeFile(htmlPath, html);

console.log(`stamped build "${build}": ${stamped} module specifiers + index.html`);
