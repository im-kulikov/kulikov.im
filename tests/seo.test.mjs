import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PAGES, BASE, EN_PAGES, PAGES, enPath, all, attr, dom, exists, link, meta, tags, text, urlPath } from "./helpers/site.mjs";

const title = (p) => text(tags(dom(p), "title")[0]);
const desc = (p) => meta(dom(p), "description");

describe("every page", () => {
  for (const p of ALL_PAGES) {
    test(`${p}: lang, charset, viewport, no <base>, hreflang only where an English translation exists`, () => {
      const d = dom(p);
      assert.equal(attr(tags(d, "html")[0], "lang"), "ru");
      assert.ok(all(d, (n) => n.tagName === "meta" && attr(n, "charset")?.toLowerCase() === "utf-8").length === 1);
      assert.match(meta(d, "viewport"), /width=device-width/);
      assert.equal(tags(d, "base").length, 0);
      const langs = link(d, "alternate").map((n) => attr(n, "hreflang")).sort();
      assert.deepEqual(langs, EN_PAGES.includes(p) ? ["en", "ru", "x-default"] : [], p);
    });
    test(`${p}: description, og:*, twitter:* and verification tags`, () => {
      const d = dom(p);
      for (const k of ["description", "og:title", "og:description", "og:image", "og:type", "twitter:card", "twitter:title", "twitter:description", "twitter:image", "google-site-verification", "yandex-verification"])
        assert.ok(meta(d, k)?.trim(), `${p}: ${k}`);
      assert.equal(meta(d, "twitter:site"), undefined, "twitter account was removed");
      assert.equal(meta(d, "twitter:creator"), undefined);
    });
    test(`${p}: description is 50..200 chars, title is 10..100 chars`, () => {
      assert.ok(desc(p).length >= 50 && desc(p).length <= 200, `${p}: description ${desc(p).length}`);
      assert.ok(title(p).length >= 10 && title(p).length <= 100, `${p}: title ${title(p).length}`);
    });
  }
});

describe("indexable pages", () => {
  test("titles and descriptions are unique", () => {
    for (const f of [title, desc]) assert.equal(new Set(PAGES.map(f)).size, PAGES.length);
  });
  test("home has no site suffix, other pages end with ' :: Kulikov.im' exactly once", () => {
    for (const p of PAGES) {
      const t = title(p);
      if (p === "index") assert.ok(!t.includes(" :: "), t);
      else assert.ok(t.endsWith(" :: Kulikov.im") && t.split(" :: ").length === 2, `${p}: ${t}`);
    }
  });
  test("canonical equals og:url equals the page URL (home is '/', never '/index.html')", () => {
    for (const p of PAGES) {
      const c = link(dom(p), "canonical");
      assert.equal(c.length, 1, `${p}: one canonical`);
      assert.equal(attr(c[0], "href"), `${BASE}${urlPath(p)}`);
      assert.equal(meta(dom(p), "og:url"), `${BASE}${urlPath(p)}`);
    }
  });
  test("robots meta allows indexing", () => {
    for (const p of PAGES) assert.match(meta(dom(p), "robots"), /^index, follow$/, p);
  });
  test("og:image points to an existing file of this site", () => {
    for (const p of PAGES) {
      const u = meta(dom(p), "og:image");
      assert.ok(u.startsWith(`${BASE}/`), u);
      assert.ok(exists(u.slice(BASE.length + 1)), u);
      assert.equal(meta(dom(p), "twitter:image"), u);
    }
  });
});

describe("404 page", () => {
  test("is noindex, has no canonical, has its own title and is not in the sitemap", () => {
    const d = dom("404");
    assert.match(meta(d, "robots"), /noindex/);
    assert.equal(link(d, "canonical").length, 0);
    assert.ok(!PAGES.map(title).includes(title("404")));
    assert.match(title("404"), /не найдена/i);
  });
});

describe("SERP and social metadata", () => {
  test("titles are at most 70 characters (SERP truncation)", () => {
    for (const p of PAGES) assert.ok(title(p).length <= 70, `${p}: ${title(p).length}`);
  });
  test("og:locale and og:site_name are set", () => {
    for (const p of PAGES) assert.ok(meta(dom(p), "og:locale") && meta(dom(p), "og:site_name"), p);
  });
});
