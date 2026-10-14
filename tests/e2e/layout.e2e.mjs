// Browser checks on the built site (Chromium via playwright-core). Run: npm run test:e2e
// Browser: CHROME_PATH=/path/to/chrome, otherwise the system "chrome" channel (preinstalled on GitHub runners).
// Layout properties only (no screenshots): pixel diffs depend on fonts and browser version and would flake.
// Everything that is not localhost is aborted, so Google Fonts never make a run non-deterministic.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { ALIASES, ALL_PAGES, EN_PAGES, PAGES, SITE, enPath, urlPath } from "../helpers/site.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".xml": "application/xml", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };
let server, origin, browser;
const url = (p) => origin + (p.startsWith("/") ? p : p === "404" ? "/404.html" : urlPath(p));
const EVERY = [...ALL_PAGES, ...EN_PAGES.map(enPath)]; // Russian pages and their English translations

async function open(p, { width = 1280, height = 900, ...ctx } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...ctx });
  const page = await context.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (r) => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  await page.goto(url(p), { waitUntil: "load" });
  return { page, context, requests, errors };
}

before(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let f = join(SITE, path.endsWith("/") ? `${path}index.html` : path);
    if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
});
after(async () => {
  await browser?.close();
  server?.close();
});

describe("layout", () => {
  for (const width of [320, 390, 768, 1024, 1280])
    test(`no horizontal overflow at ${width}px on every page`, async () => {
      for (const p of EVERY) {
        const { page, context, errors } = await open(p, { width });
        const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        await context.close();
        assert.ok(o.sw <= o.iw, `${p} @${width}: scrollWidth ${o.sw} > ${o.iw}`);
        assert.deepEqual(errors, [], `${p}: page errors`);
      }
    });

  test("dark mode: prefers-color-scheme switches the page background", async () => {
    const bg = async (scheme) => {
      const { page, context } = await open("index", { colorScheme: scheme });
      const c = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await context.close();
      return c.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
    };
    assert.ok((await bg("light")) > 200, "light background should be light");
    assert.ok((await bg("dark")) < 80, "dark background should be dark");
  });

  test("404 page renders with a way back home", async () => {
    const { page, context } = await open("404");
    assert.equal(await page.locator("h1").count(), 1);
    assert.ok((await page.locator('main a[href="/"]').count()) >= 1);
    await context.close();
  });

  test("the mobile menu opens with a click on the toggle", async () => {
    const { page, context } = await open("about", { width: 390 });
    assert.ok(!(await page.locator("#nav-menu").isVisible()));
    await page.locator("#nav-toggle").click();
    assert.ok(await page.locator("#nav-menu").isVisible());
    assert.equal(await page.locator("#nav-toggle").getAttribute("aria-expanded"), "true");
    await context.close();
  });

  test("old URLs of renamed pages make the browser go to the new page", async () => {
    assert.ok(ALIASES.length > 0);
    for (const a of ALIASES) {
      const context = await browser.newContext();
      const page = await context.newPage();
      // production URLs are not served here: abort them, but the browser's request proves where the redirect leads
      await page.route("**/*", (r) => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
      const target = `https://kulikov.im${urlPath(a.to)}`;
      await Promise.all([page.waitForRequest(target, { timeout: 5000 }), page.goto(`${origin}/${a.from}.html`).catch(() => {})]);
      await context.close();
    }
  });

  test("the five menu items are numbered by a CSS counter and the contact button is not", async () => {
    const { page, context } = await open("index");
    // getComputedStyle does not resolve counter(), so check the declaration and render the number
    const marks = await page.locator("#nav-menu > li").evaluateAll((lis) =>
      lis.map((li) => getComputedStyle(li.firstElementChild, "::before").content));
    const shot = await page.locator("#nav-menu > li").first().screenshot();
    await context.close();
    assert.deepEqual(marks.slice(0, 5).map((m) => m.startsWith("counter(nav")), [true, true, true, true, true]);
    assert.ok(!marks[5].startsWith("counter("), `contact button must not be numbered: ${marks[5]}`);
    assert.ok(shot.length > 500);
  });

  test("every indexable page is reachable from the menu on desktop", async () => {
    const { page, context } = await open("index");
    const hrefs = await page.locator("header nav a").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
    for (const p of PAGES.filter((x) => x !== "index")) assert.ok(hrefs.includes(urlPath(p)), p);
    await context.close();
  });
});

describe("accessibility", () => {
  test("the mobile menu is operable with the keyboard (Tab to the toggle, Enter opens, Escape closes)", async () => {
    const { page, context } = await open("about", { width: 390 });
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.id === "nav-toggle")) break;
    }
    assert.equal(await page.evaluate(() => document.activeElement?.id), "nav-toggle", "Tab should reach the toggle");
    await page.keyboard.press("Enter");
    assert.ok(await page.locator("#nav-menu").isVisible(), "Enter should open the menu");
    await page.keyboard.press("Escape");
    assert.ok(!(await page.locator("#nav-menu").isVisible()), "Escape should close it");
    await context.close();
  });

  test("the menu toggle is at least 24x24 CSS px (WCAG 2.2 target size)", async () => {
    const { page, context } = await open("about", { width: 390 });
    const b = await page.locator("#nav-toggle").boundingBox();
    await context.close();
    assert.ok(b.width >= 24 && b.height >= 24, `${b.width}x${b.height}`);
  });

  test("the skip link becomes visible on focus and moves focus to the content", async () => {
    const { page, context } = await open("index");
    await page.keyboard.press("Tab");
    const box = await page.locator(".skip-link").boundingBox();
    assert.ok(box && box.width > 20 && box.y >= 0, "skip link is visible when focused");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "main");
    await context.close();
  });

  test("the sticky header is not sticky when printing", async () => {
    const { page, context } = await open("index");
    await page.emulateMedia({ media: "print" });
    const display = await page.evaluate(() => getComputedStyle(document.querySelector("header")).display);
    await context.close();
    assert.equal(display, "none");
  });

  // Real contrast: text colour is composited over every translucent background layer behind it.
  test("text contrast is at least 4.5:1 on every page in light and dark mode", async () => {
    for (const p of EVERY) for (const colorScheme of ["light", "dark"]) {
      const { page, context } = await open(p, { width: 390, colorScheme });
      const bad = await page.evaluate(() => {
        const px = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const rgba = (c) => { px.clearRect(0, 0, 1, 1); px.fillStyle = c; px.fillRect(0, 0, 1, 1); const d = px.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
        const lum = ([r, g, b]) => [r, g, b].map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
        const bgOf = (el) => {
          const layers = [];
          for (; el; el = el.parentElement) { const c = rgba(getComputedStyle(el).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] === 1) break; }
          return layers.reduceRight((base, c) => over(c, base), [255, 255, 255]);
        };
        const out = [];
        for (const el of document.querySelectorAll("body *")) {
          if (!el.checkVisibility?.() || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
          if (el.closest("details:not([open]) > :not(summary)")) continue;
          const bg = bgOf(el), fg = over(rgba(getComputedStyle(el).color), bg);
          const [l1, l2] = [lum(fg), lum(bg)].sort((a, c) => c - a);
          const ratio = (l1 + 0.05) / (l2 + 0.05);
          if (ratio < 4.5) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${ratio.toFixed(2)}`);
        }
        return [...new Set(out)];
      });
      await context.close();
      assert.deepEqual(bad, [], `${p} (${colorScheme})`);
    }
  });
});

describe("images", () => {
  test("a phone downloads exactly one hero image variant", async () => {
    const { page, context, requests } = await open("index", { width: 390 });
    await page.waitForLoadState("networkidle");
    await context.close();
    assert.equal(requests.filter((r) => /\/img\/home-hero/.test(r)).length, 1);
  });
});

describe("language switch", () => {
  const sw = (page) => page.locator(".lang-switch").first();

  test("links go to the translation, current language is marked, touch targets are at least 44px", async () => {
    const { page, context } = await open("about", { width: 390 });
    await page.click("#nav-toggle");
    const links = await sw(page).locator("a").evaluateAll((as) => as.map((a) => ({ lang: a.lang, href: a.getAttribute("href"), current: a.getAttribute("aria-current"), h: a.getBoundingClientRect().height, w: a.getBoundingClientRect().width })));
    await context.close();
    assert.deepEqual(links.map((l) => [l.lang, l.href, l.current]), [["ru", "/about.html", "true"], ["en", "/en/about.html", null]]);
    for (const l of links) assert.ok(l.h >= 44 && l.w >= 44, `${l.lang}: ${l.w}x${l.h}`);
  });

  test("the choice is remembered: only the home page redirects, once per session; deep links never do", async () => {
    const { page, context } = await open("index");
    await sw(page).locator("a[lang=en]").click();
    await page.waitForURL("**/en/");
    assert.equal(await page.evaluate(() => localStorage.getItem("lang")), "en");
    // a new visit to the Russian home page goes to the English one...
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(url("index"));
    await page.waitForURL("**/en/");
    // ...but only once per session
    await page.goto(url("index"));
    assert.equal(new URL(page.url()).pathname, "/");
    // deep links to the other language are not redirected
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(url("about"));
    assert.equal(new URL(page.url()).pathname, "/about.html");
    await context.close();
  });

  test("without a saved choice nothing is redirected", async () => {
    const { page, context } = await open("index");
    assert.equal(new URL(page.url()).pathname, "/");
    await context.close();
  });
});

describe("project cards", () => {
  for (const [width, cols] of [[390, 1], [800, 2], [1280, 3], [1600, 3]])
    test(`@${width}px the last row is filled: the lone last card spans the free columns (${cols} column${cols > 1 ? "s" : ""})`, async () => {
      for (const p of ["projects", "/en/projects.html"]) {
        const { page, context } = await open(p, { width });
        const r = await page.evaluate(() => {
          const ul = [...document.querySelectorAll("ul")].find((u) => u.className.includes("grid-cols"));
          const kids = [...ul.children];
          return { cols: getComputedStyle(ul).gridTemplateColumns.split(" ").length, n: kids.length, span: +(getComputedStyle(kids.at(-1)).gridColumnEnd.match(/span (\d+)/)?.[1] ?? 1) };
        });
        await context.close();
        assert.equal(r.cols, cols, p);
        assert.equal(r.span, cols - ((r.n - 1) % cols), `${p}: ${r.n} cards in ${cols} columns, last spans ${r.span}`);
      }
    });
});
