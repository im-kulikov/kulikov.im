import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ALIASES, ALL_PAGES, BASE, EN_PAGES, PAGES, ROOT, SITE, all, classes, dom, enPath, exists, read, text, urlPath } from "./helpers/site.mjs";
import { BUILD_LOG, STATS_COPY } from "./helpers/paths.mjs";
import { BUILD_SHA, HUGO } from "./helpers/hugo.mjs";

test("build log has no warnings, errors or deprecations", () => {
  const bad = readFileSync(BUILD_LOG, "utf8").split("\n").filter((l) => /^(WARN|ERROR)|deprecated/i.test(l));
  assert.deepEqual(bad, []);
});

test("built pages equal the pages derived from src/content (+404, +alias stubs); drafts are not built", () => {
  const built = readdirSync(SITE).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")).sort();
  assert.deepEqual(built, [...ALL_PAGES, ...ALIASES.map((a) => a.from)].sort());
});

test("renamed pages keep their old URL: alias stubs redirect and point canonical to the new page", () => {
  assert.ok(ALIASES.length > 0);
  for (const a of ALIASES) {
    const s = read(`${a.from}.html`);
    const target = `${BASE}${urlPath(a.to)}`;
    assert.ok(PAGES.includes(a.to), a.to);
    assert.match(s, new RegExp(`<link rel="?canonical"? href="?${target}"?`), a.from);
    assert.match(s, new RegExp(`http-equiv="?refresh"? content="?0; url=${target}`), a.from);
  }
});

test("sitemap.xml is an index of the per-language sitemaps that list exactly the indexable pages (404 and alias stubs excluded)", () => {
  const locs = (f) => [...read(f).matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]).sort();
  assert.deepEqual(locs("sitemap.xml"), [`${BASE}/en/sitemap.xml`, `${BASE}/ru/sitemap.xml`]);
  assert.deepEqual(locs("ru/sitemap.xml"), PAGES.map((p) => `${BASE}${urlPath(p)}`).sort());
  assert.deepEqual(locs("en/sitemap.xml"), EN_PAGES.map((p) => `${BASE}${enPath(p)}`).sort());
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
  for (const c of ["home-page", "hero-title", "stat-value"]) assert.ok(classes.includes(c), c);
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

test("the footer git-info block names the commit the site was built from (HUGO_BUILD_SHA), the same on every page", () => {
  for (const p of [...PAGES, ...EN_PAGES.map((x) => `en/${x === "index" ? "index" : x}`)]) {
    const [hash] = all(dom(p), (n) => n.tagName === "p" && classes(n).includes("git-hash"));
    assert.equal(text(hash), BUILD_SHA, p);
  }
});
