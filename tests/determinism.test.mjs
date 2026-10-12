// Two builds of the same sources must be byte-identical (reproducible output, no stale-cache surprises).
// Costs a second build, so it runs in CI (CI=true) or with TEST_SLOW=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "./helpers/hugo.mjs";
import { SITE } from "./helpers/paths.mjs";

const tree = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(d, e.name), base) : [[join(d, e.name).slice(base.length), createHash("sha256").update(readFileSync(join(d, e.name))).digest("hex")]]));
const slow = process.env.CI || process.env.TEST_SLOW;

test("a second build produces identical output", { skip: slow ? false : "set TEST_SLOW=1 (runs in CI)" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "site-det-"));
  try {
    const r = buildSite(dir);
    assert.equal(r.status, 0, r.log);
    assert.deepEqual(tree(dir), tree(SITE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
