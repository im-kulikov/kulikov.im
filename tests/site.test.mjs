// Builds the site once (production, like CI) and validates the generated output.
// Usage: npm test   (HUGO_BIN=/path/to/hugo to use a specific binary)
import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BASE = "https://kulikov.im";
const HUGO = process.env.HUGO_BIN || "hugo";
const PAGES = { index: "/", about: "/about.html", services: "/services.html", resume: "/resume.html", hobbies: "/hobbies.html" };
const STATS = join(ROOT, "hugo_stats.json");

let out, work, build, stats, statsBefore;
const html = {};
const read = (p) => readFileSync(join(out, p), "utf8");
const all = (s, re) => [...s.matchAll(re)].map((m) => m[1] ?? m[0]);
const meta = (s, key) => s.match(new RegExp(`<meta (?:name|property)="?${key}"? content="?([^">]*)`))?.[1];

before(() => {
  work = mkdtempSync(join(tmpdir(), "site-test-"));
  out = join(work, "public");
  statsBefore = readFileSync(STATS, "utf8"); // the build rewrites hugo_stats.json, restore it afterwards
  const r = spawnSync(HUGO, ["--gc", "--minify", "--baseURL", `${BASE}/`, "--destination", out, "--cacheDir", join(work, "cache")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, HUGO_ENVIRONMENT: "production", TZ: "Europe/Moscow" },
  });
  build = { status: r.status, log: `${r.stdout}\n${r.stderr}` };
  stats = JSON.parse(readFileSync(STATS, "utf8"));
  for (const name of [...Object.keys(PAGES), "404"]) if (existsSync(join(out, `${name}.html`))) html[name] = read(`${name}.html`);
});

after(() => {
  writeFileSync(STATS, statsBefore);
  rmSync(work, { recursive: true, force: true });
});

describe("build", () => {
  test("succeeds without errors or deprecation warnings", () => {
    assert.equal(build.status, 0, build.log);
    const bad = build.log.split("\n").filter((l) => /^ERROR|deprecated/i.test(l));
    assert.deepEqual(bad, []);
  });

  test("produces the expected pages and no draft pages", () => {
    for (const f of ["index", "about", "services", "resume", "hobbies", "404"]) assert.ok(existsSync(join(out, `${f}.html`)), `${f}.html missing`);
    for (const f of ["sitemap.xml", "robots.txt", "manifest.webmanifest"]) assert.ok(existsSync(join(out, f)), `${f} missing`);
    assert.ok(!existsSync(join(out, "contacts.html")), "draft page contacts.html must not be built");
  });

  test("hugo_stats.json keeps classes of the home page (Tailwind input)", () => {
    // regression guard: the home output format must be collected by build stats
    for (const c of ["home-page", "feature-img", "md:col-5"]) assert.ok(stats.htmlElements.classes.includes(c), `missing class ${c}`);
  });
});

describe("head / SEO", () => {
  test("language is ru", () => {
    for (const [n, s] of Object.entries(html)) assert.match(s, /<html lang="?ru"?[ >]/, n);
  });

  test("title: home has no site suffix, other pages have a short one, no duplicates", () => {
    for (const [n, s] of Object.entries(html)) {
      const t = s.match(/<title>([^<]*)<\/title>/)[1];
      assert.ok(t.length > 0, n);
      if (n === "index") assert.ok(!t.includes(" :: "), `${n}: ${t}`);
      else assert.ok(t.endsWith(" :: Kulikov.im") && t.split(" :: ").length === 2, `${n}: ${t}`);
    }
  });

  test("no <base href>, no twitter account tags", () => {
    for (const [n, s] of Object.entries(html)) {
      assert.ok(!/<base[ >]/.test(s), `${n}: <base>`);
      assert.ok(!/twitter:(site|creator)/.test(s), `${n}: twitter account tag`);
    }
  });

  test("description, og and verification tags are present", () => {
    for (const [n, s] of Object.entries(html)) {
      for (const k of ["description", "og:description", "twitter:description", "og:title", "og:image"]) assert.ok(meta(s, k)?.length > 0, `${n}: ${k}`);
      assert.ok(meta(s, "google-site-verification"), `${n}: google verification`);
      assert.ok(meta(s, "yandex-verification"), `${n}: yandex verification`);
    }
  });

  test("exactly one h1 per page", () => {
    for (const [n, s] of Object.entries(html)) assert.equal(all(s, /<h1[ >]/g).length, 1, n);
  });

  test("og:url is the canonical page URL (home is /, not /index.html)", () => {
    for (const [n, path] of Object.entries(PAGES)) assert.equal(meta(html[n], "og:url"), `${BASE}${path}`, n);
  });

  test("sitemap lists exactly the public pages", () => {
    const locs = all(read("sitemap.xml"), /<loc>([^<]*)<\/loc>/g).sort();
    assert.deepEqual(locs, Object.values(PAGES).map((p) => `${BASE}${p}`).sort());
  });

  test("no page links to /index.html", () => {
    for (const [n, s] of Object.entries(html)) assert.ok(!/(href|content)="?[^" >]*index\.html/.test(s), n);
  });
});

describe("content / assets", () => {
  test("every internal link and asset exists", () => {
    const missing = [];
    for (const [n, s] of Object.entries(html)) {
      for (const u of all(s, /(?:href|src)="?(\/[^"\s>]*)/g)) {
        if (u.startsWith("//")) continue;
        const p = u.split(/[#?]/)[0];
        if (!existsSync(join(out, p)) && !existsSync(join(out, p, "index.html"))) missing.push(`${n}: ${u}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test("images have alt text; non-preloaded images are lazy", () => {
    for (const [n, s] of Object.entries(html)) {
      const preloaded = new Set(all(s, /rel="?preload"? as="?image"? href="?([^" >]+)/g).map((u) => u.replace(/\.webp.*/, "")));
      for (const tag of all(s, /<img[^>]*>/g)) {
        const alt = tag.match(/ alt="([^"]*)"/)?.[1] ?? tag.match(/ alt=([^ >]+)/)?.[1];
        assert.ok(alt && alt !== "feature image", `${n}: bad alt in ${tag}`);
        if (!/class="?[^">]*\bimg\b/.test(tag)) continue; // only images rendered by components/image.html
        const hi = /fetchpriority="?high/.test(tag);
        const lazy = /loading="?lazy/.test(tag);
        assert.ok(hi !== lazy, `${n}: expected exactly one of fetchpriority=high / loading=lazy in ${tag}`);
      }
      // below-the-fold feature images must not be preloaded
      assert.ok(![...preloaded].some((u) => u.includes("features-")), `${n}: features image preloaded`);
    }
  });

  test("CSS contains classes used only on the home page", () => {
    const css = readdirSync(join(out, "css")).map((f) => read(join("css", f))).join("");
    for (const sel of [".md\\:col-5", ".bg-gradient"]) assert.ok(css.includes(sel), `missing ${sel}`);
  });

  test("manifest is valid JSON with icons that exist", () => {
    const m = JSON.parse(read("manifest.webmanifest"));
    assert.ok(m.icons.length > 0);
    for (const i of m.icons) assert.ok(existsSync(join(out, i.src)), i.src);
  });
});
