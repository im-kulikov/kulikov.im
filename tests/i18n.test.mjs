// English pages: translated, linked to the Russian ones, and nothing Russian leaks into them.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BASE, EN_PAGES, PAGES, all, attr, dom, enPath, exists, link, meta, read, tags, text, urlPath, walk } from "./helpers/site.mjs";

const en = (p) => dom(p === "index" ? "en/index" : `en/${p}`);
const visibleText = (d) => [...walk(d)].filter((n) => n.nodeName === "#text" && !["script", "style"].includes(n.parentNode?.tagName)).map((n) => n.value).join(" ");

test("every page has an English twin", () => {
  assert.deepEqual(EN_PAGES, PAGES);
  for (const p of PAGES) assert.equal(exists(`en/${p === "index" ? "index" : p}.html`), EN_PAGES.includes(p), p);
});

describe("every English page", () => {
  for (const p of EN_PAGES) {
    test(`${p}: lang, canonical, og:locale, no Cyrillic text, no raw data leaks`, () => {
      const d = en(p);
      assert.equal(attr(tags(d, "html")[0], "lang"), "en");
      assert.equal(attr(link(d, "canonical")[0], "href"), `${BASE}${enPath(p)}`);
      assert.equal(meta(d, "og:locale"), "en_US");
      assert.equal(meta(d, "og:locale:alternate"), "ru_RU");
      assert.equal(meta(d, "og:site_name"), "Evgeniy Kulikov — personal site");
      assert.ok(meta(d, "description")?.length >= 50, p);
      const t = visibleText(d);
      assert.doesNotMatch(t, /[А-Яа-яЁё]/, `${p}: Russian text on the English page`);
      assert.doesNotMatch(t + meta(d, "description"), /map\[|<nil>|\{ru:|\ben:/, p);
    });
    test(`${p}: hreflang is reciprocal and the language switch links to both versions`, () => {
      const d = en(p);
      const alt = Object.fromEntries(link(d, "alternate").map((n) => [attr(n, "hreflang"), attr(n, "href")]));
      assert.deepEqual(alt, { ru: `${BASE}${urlPath(p)}`, en: `${BASE}${enPath(p)}`, "x-default": `${BASE}${urlPath(p)}` });
      const hrefs = all(d, (n) => n.tagName === "a" && attr(n, "data-lang")).map((n) => [attr(n, "data-lang"), attr(n, "href")]);
      assert.deepEqual([...new Set(hrefs.map((h) => h.join("=")))].sort(), [`en=${enPath(p)}`, `ru=${urlPath(p)}`]);
    });
  }
  test("titles and descriptions are unique within the language", () => {
    for (const f of [(p) => text(tags(en(p), "title")[0]), (p) => meta(en(p), "description")]) assert.equal(new Set(EN_PAGES.map(f)).size, EN_PAGES.length);
  });
});

describe("English home page", () => {
  test("hero links only to pages that exist in English", () => {
    const hrefs = all(en("index"), (n) => n.tagName === "a").map((n) => attr(n, "href"));
    assert.ok(!hrefs.includes("/projects.html"));
    assert.ok(hrefs.includes("/en/projects.html"));
  });
  test("main menu lists the English pages in the same order", () => {
    const d = en("index");
    const nav = all(d, (n) => n.tagName === "ul" && attr(n, "id") === "nav-menu")[0];
    const items = all(nav, (n) => n.tagName === "a" && attr(n, "class")?.includes("nav-link")).map((n) => [text(n).trim(), attr(n, "href")]);
    assert.deepEqual(items, [["Services", "/en/services.html"], ["Projects", "/en/projects.html"], ["About me", "/en/about.html"], ["Resume", "/en/resume.html"], ["Open Source", "/en/open-source.html"]]);
  });
});

test("the reading list (Russian-only) is hidden on the English open-source page and kept on the Russian one", () => {
  assert.doesNotMatch(visibleText(en("open-source")), /Designing Data-Intensive|Литература|Reading list|Brave New World/);
  assert.match(visibleText(dom("open-source")), /Designing Data-Intensive/);
});

test("manifest and 404 exist for English too", () => {
  assert.equal(JSON.parse(read("en/manifest.webmanifest")).lang, "en");
  assert.ok(exists("en/404.html"));
});

test("language links: the accessible name starts with the visible text (WCAG 2.5.3, Lighthouse label-content-name-mismatch)", () => {
  for (const p of [...EN_PAGES.map((x) => `en/${x === "index" ? "index" : x}`), ...EN_PAGES]) {
    const links = all(dom(p), (n) => n.tagName === "a" && attr(n, "data-lang"));
    assert.ok(links.length >= 4, `${p}: header and footer, two languages`);
    for (const a of links) assert.ok(attr(a, "aria-label").startsWith(text(a).trim()), `${p}: "${attr(a, "aria-label")}" vs "${text(a).trim()}"`);
  }
});
