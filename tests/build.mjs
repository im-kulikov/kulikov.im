// Builds the site once for the whole test run (npm runs it as `pretest`).
// Output: build/test-site (+ build log and a copy of the generated hugo_stats.json).
// Test files only read the result, so several test files do not multiply the build time.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSite, HUGO } from "./helpers/hugo.mjs";
import { BUILD_LOG, ROOT, SITE, STATS_COPY } from "./helpers/paths.mjs";

rmSync(SITE, { recursive: true, force: true });
mkdirSync(join(ROOT, "build"), { recursive: true });
const r = buildSite(SITE);
writeFileSync(BUILD_LOG, r.log);
writeFileSync(STATS_COPY, r.stats);
if (r.error || r.status !== 0) {
  console.error(r.error ?? r.log);
  console.error(`hugo build failed (exit ${r.status}); is "${HUGO}" installed? (set HUGO_BIN)`);
  process.exit(1);
}
