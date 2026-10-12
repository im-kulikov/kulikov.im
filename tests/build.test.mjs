import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ALL_PAGES, BASE, PAGES, ROOT, SITE, exists, read, urlPath } from "./helpers/site.mjs";
import { BUILD_LOG, STATS_COPY } from "./helpers/paths.mjs";
import { HUGO } from "./helpers/hugo.mjs";

test("build log has no warnings, errors or deprecations", () => {
  const bad = readFileSync(BUILD_LOG, "utf8").split("\n").filter((l) => /^(WARN|ERROR)|deprecated/i.test(l));
  assert.deepEqual(bad, []);
});

test("built pages equal the pages derived from src/content (+404); drafts are not built", () => {
  const built = readdirSync(SITE).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")).sort();
  assert.deepEqual(built, ALL_PAGES);
});

test("sitemap.xml lists exactly the indexable pages, 404 excluded", () => {
  const locs = [...read("sitemap.xml").matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]).sort();
  assert.deepEqual(locs, PAGES.map((p) => `${BASE}${urlPath(p)}`).sort());
});

test("robots.txt points to the sitemap", () => {
  assert.match(read("robots.txt"), new RegExp(`^Sitemap: ${BASE}/sitemap\\.xml$`, "m"));
  assert.ok(exists("sitemap.xml"));
});

test("webmanifest is valid JSON with existing icons and a name", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.ok(m.name && m.short_name && m.icons.length > 0);
  for (const i of m.icons) assert.ok(exists(i.src.replace(/^\//, "")), i.src);
});

test("hugo_stats.json keeps classes of the home page (input for Tailwind)", () => {
  // regression guard: the HomeHTML output format must be collected by Hugo's build stats
  const { classes } = JSON.parse(readFileSync(STATS_COPY, "utf8")).htmlElements;
  for (const c of ["home-page", "feature-img", "md:col-5"]) assert.ok(classes.includes(c), c);
});

test("Hugo binary version equals .hugo-version (the version CI installs)", () => {
  const want = readFileSync(join(ROOT, ".hugo-version"), "utf8").trim();
  const out = spawnSync(HUGO, ["version"], { encoding: "utf8" }).stdout;
  assert.match(out, new RegExp(`hugo v${want.replaceAll(".", "\\.")}[-+ ]`));
  assert.match(out, /extended/);
});

test("the site does not need Go or Hugo modules", () => {
  assert.ok(!readdirSync(ROOT).includes("go.mod"), "go.mod would make every build depend on Go and the network");
});
