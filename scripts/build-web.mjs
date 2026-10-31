/**
 * Production build for the MemoryLoom web app.
 *
 * The stack is deliberately buildless (plain Node + static files,
 * the repo's existing tooling), so "the build" is a verification
 * pass: every web source must parse as a module, every public asset
 * the pages reference must exist, the Vercel config must be valid,
 * and the API handler module must import cleanly. A failure here
 * fails the deploy, which is the point.
 *
 *   npm run build:web
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '  ok' : '  FAIL'} ${label}`);
  if (!ok) failures++;
};

const jsFiles = [
  'web/api.mjs', 'web/server.mjs', 'api/index.mjs',
  'web/public/console.js', 'web/public/graph.js',
  'scripts/seed-web-demo.mjs', 'checks/web.mjs',
];
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' });
    check(true, `parses: ${f}`);
  } catch (e) {
    check(false, `parses: ${f} — ${String(e.stderr || e.message).slice(0, 200)}`);
  }
}

const assets = [
  'web/public/index.html', 'web/public/console.html', 'web/public/styles.css',
  'web/public/tokens.css', 'web/public/style-tile.html',
  'web/public/fonts/newsreader.woff2', 'web/public/fonts/newsreader-italic.woff2',
  'web/public/fonts/source-sans-3.woff2',
  'web/public/fonts/ibm-plex-mono-400.woff2', 'web/public/fonts/ibm-plex-mono-500.woff2',
];
for (const f of assets) check(existsSync(join(root, f)), `exists: ${f}`);

// Pages must only reference assets that exist.
for (const page of ['web/public/index.html', 'web/public/console.html', 'web/public/style-tile.html']) {
  const html = readFileSync(join(root, page), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    const target = m[1];
    if (target === '/' || target.startsWith('/console') || target.startsWith('/api')) continue;
    check(existsSync(join(root, 'web/public', target)), `${page} references ${target}`);
  }
}

try {
  const v = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  check(v.outputDirectory === 'web/public', 'vercel.json outputDirectory is web/public');
} catch (e) {
  check(false, `vercel.json parses — ${e.message}`);
}

try {
  const mod = await import(join(root, 'web/api.mjs'));
  check(typeof mod.createHandler === 'function', 'web/api.mjs exports createHandler');
} catch (e) {
  check(false, `web/api.mjs imports — ${e.message}`);
}

console.log(failures ? `\nBUILD FAILED (${failures})` : '\nBUILD OK');
process.exit(failures ? 1 : 0);
