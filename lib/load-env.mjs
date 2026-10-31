/**
 * Local run-path environment resolution (Iteration 5.3, Finding C).
 *
 * The printed setup story — README and landing §06 — is:
 *
 *   cp .env.example .env.local   # set DATABASE_URL there
 *   npm run db:init
 *   npm run seed:web
 *   npm run web
 *
 * with no environment prefix on the later commands. For that story
 * to be true, every local entry point must resolve DATABASE_URL
 * from `.env.local` (the same file the Settings store writes) when
 * the environment does not set it — exactly the precedence the
 * config service uses for provider keys: environment first, then
 * the local store file, then not configured. Before this module,
 * only the MCP server loaded that file, so `npm run db:init` as
 * printed exited "DATABASE_URL missing".
 *
 * Hosted deployments never call this: api/index.mjs reads the
 * environment alone, as a deployment should.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read one variable from the repo's `.env.local`, using the same
 * tolerant dotenv parsing as the settings store: corrupt lines are
 * skipped, quoted values are unquoted, unknown content is ignored.
 * Returns null when the file or the variable is absent.
 */
export function readLocalEnv(name, root = REPO_ROOT) {
  const path = join(root, '.env.local');
  if (!existsSync(path)) return null;
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (key !== name) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || !value.endsWith(quote)) continue;
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return value || null;
  }
  return null;
}

/**
 * Resolve DATABASE_URL for a local entry point: the environment
 * wins; otherwise `.env.local` is consulted (and the resolved value
 * is placed into process.env so libraries that read it directly
 * see the same answer). Returns the URL or null.
 */
export function resolveDatabaseUrl() {
  const fromEnv = String(process.env.DATABASE_URL || '').trim();
  if (fromEnv) return fromEnv;
  const fromFile = readLocalEnv('DATABASE_URL');
  if (fromFile) {
    process.env.DATABASE_URL = fromFile;
    return fromFile;
  }
  return null;
}
