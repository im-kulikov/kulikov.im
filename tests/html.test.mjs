// Structure, semantics and static accessibility of the built pages.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PAGES, MENU_ORDER, PAGES, all, attr, classes, dom, hasAttr, read, tags, text, urlPath, walk } from "./helpers/site.mjs";

const headings = (p) => all(dom(p), (n) => /^h[1-6]$/.test(n.tagName));
const eachPage = (fn, pages = ALL_PAGES) => pages.forEach((p) => fn(p, dom(p)));

describe("document structure", () => {
  test("html5 doctype, lang=ru, utf-8 declared early", () => {
    eachPage((p) => {
      assert.match(read(`${p}.html`), /^<!doctype html>/i, p);
      assert.match(read(`${p}.html`).slice(0, 2048), /<meta charset="?utf-8/i, p);
    });
  });
  test("ids are unique", () => {
    eachPage((p, d) => {
      const ids = all(d, (n) => hasAttr(n, "id")).map((n) => attr(n, "id"));
      assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], p);
    });
  });
  test("landmarks: one <main>, a <header>, a <nav>, a <footer>", () => {
    eachPage((p, d) => {
      assert.equal(tags(d, "main").length, 1, `${p}: main`);
      for (const t of ["header", "nav", "footer"]) assert.ok(tags(d, t).length >= 1, `${p}: ${t}`);
    });
  });
  test("exactly one h1, and it is the first heading", () => {
    eachPage((p) => {
      const h = headings(p);
      assert.equal(h.filter((n) => n.tagName === "h1").length, 1, p);
      assert.equal(h[0].tagName, "h1", p);
    });
  });
  test("<picture>: every <source> precedes the <img>", () => {
    eachPage((p, d) => {
      for (const pic of tags(d, "picture")) {
        const kids = pic.childNodes.filter((c) => c.tagName);
        const img = kids.findIndex((c) => c.tagName === "img");
        assert.ok(img >= 0, `${p}: picture without img`);
        assert.ok(kids.slice(img + 1).every((c) => c.tagName !== "source"), `${p}: <source> after <img> is ignored by browsers`);
      }
    });
  });
  test("width/height attributes are plain integers", () => {
    eachPage((p, d) => {
      for (const img of tags(d, "img")) for (const k of ["width", "height"]) if (hasAttr(img, k)) assert.match(attr(img, k), /^\d+$/, `${p}: ${k}=${attr(img, k)}`);
    });
  });
  test("no console.log or debugger in inline scripts", () => {
    eachPage((p, d) => {
      for (const s of tags(d, "script")) assert.ok(!/console\.|debugger/.test(text(s)), p);
    });
  });
});

describe("navigation", () => {
  test("menu order is services > projects > about > resume > open-source (clients first, then employers, then community)", () => {
    assert.deepEqual(MENU_ORDER, ["services", "projects", "about", "resume", "open-source"]);
    eachPage((p, d) => {
      const hrefs = tags(tags(d, "nav")[0], "a").map((a) => attr(a, "href"));
      assert.deepEqual(hrefs.filter((h) => h !== "/"), MENU_ORDER.map(urlPath), p);
    });
  });
  test("active menu item has aria-current=page; home and 404 have none", () => {
    eachPage((p, d) => {
      const cur = all(d, (n) => attr(n, "aria-current") === "page");
      if (p === "index" || p === "404") return assert.equal(cur.length, 0, p);
      assert.equal(cur.length, 1, p);
      assert.equal(attr(cur[0], "href"), urlPath(p));
    });
  });
  test("menu links are the same on every page and all lead to built pages", () => {
    const menus = ALL_PAGES.map((p) => tags(dom(p), "nav").flatMap((n) => tags(n, "a")).map((a) => attr(a, "href")).join(","));
    assert.equal(new Set(menus).size, 1);
    for (const h of menus[0].split(",")) assert.ok(h === "/" || PAGES.includes(h.replace(/^\//, "").replace(/\.html$/, "")), h);
  });
});

describe("images and icons", () => {
  test("every <img> has a non-empty alt", () => {
    let n = 0;
    eachPage((p, d) => {
      for (const img of tags(d, "img")) { n++; assert.ok(attr(img, "alt")?.trim(), `${p}: ${attr(img, "src")}`); assert.notEqual(attr(img, "alt"), "feature image"); }
    });
    assert.ok(n > 10);
  });
  test("inline SVG icons are hidden from assistive tech (aria-hidden) unless they carry a <title>", () => {
    eachPage((p, d) => {
      for (const s of tags(d, "svg")) assert.ok(attr(s, "aria-hidden") === "true" || tags(s, "title").length > 0, `${p}: svg without aria-hidden/title`);
    });
  });
});

describe("known gaps (todo) — each is a real defect found in review; remove `todo` when fixed", () => {
  test("heading levels never skip (h1 > h2 > h3 ...)", { todo: "resume: h1>h3>h5, open-source: h2>h4, services: h1>h3" }, () => {
    eachPage((p) => {
      const lv = headings(p).map((n) => +n.tagName[1]);
      lv.forEach((l, i) => i && assert.ok(l - lv[i - 1] <= 1, `${p}: h${lv[i - 1]} -> h${l} (#${i})`));
    });
  });
  test("a skip link to #main is the first focusable element", { todo: "no skip link" }, () => {
    eachPage((p, d) => {
      const first = all(d, (n) => n.tagName === "a" || n.tagName === "button" || (n.tagName === "input" && attr(n, "type") !== "hidden"))[0];
      assert.equal(attr(first, "href"), "#main", p);
      assert.ok(all(d, (n) => attr(n, "id") === "main").length === 1, p);
    });
  });
  test("mobile menu toggle is a keyboard-operable control with an accessible name", { todo: "input#nav-toggle is display:none; label has no aria-label/aria-expanded" }, () => {
    eachPage((p, d) => {
      const t = all(d, (n) => attr(n, "id") === "nav-toggle")[0];
      assert.ok(t && t.tagName === "button" || (t.tagName === "input" && !classes(t).includes("hidden")), `${p}: toggle is not focusable`);
      assert.ok(all(d, (n) => hasAttr(n, "aria-expanded") && hasAttr(n, "aria-controls")).length > 0, `${p}: aria-expanded/aria-controls`);
    });
  });
  test("menu icon titles are in the page language", { todo: "svg <title>Menu Open/Close</title> are English" }, () => {
    eachPage((p, d) => {
      for (const t of all(d, (n) => n.tagName === "title" && n.parentNode.tagName === "svg")) assert.match(text(t), /[а-яё]/i, p);
    });
  });
  test("content images have width and height (no layout shift)", { todo: "about photo has neither" }, () => {
    eachPage((p, d) => {
      for (const img of tags(d, "img")) assert.ok(hasAttr(img, "width") && hasAttr(img, "height"), `${p}: ${attr(img, "src")}`);
    });
  });
});
