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
import { ALL_PAGES, PAGES, SITE, urlPath } from "../helpers/site.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".xml": "application/xml", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };
let server, origin, browser;
const url = (p) => origin + (p === "404" ? "/404.html" : urlPath(p));

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
      for (const p of ALL_PAGES) {
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
    await page.locator('label[for="nav-toggle"]').click();
    assert.ok(await page.locator("#nav-menu").isVisible());
    await context.close();
  });

  test("every indexable page is reachable from the menu on desktop", async () => {
    const { page, context } = await open("index");
    const hrefs = await page.locator("header nav a").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
    for (const p of PAGES.filter((x) => x !== "index")) assert.ok(hrefs.includes(urlPath(p)), p);
    await context.close();
  });
});

describe("known gaps (todo) — real defects found in review; remove `todo` when fixed", () => {
  test("the mobile menu is operable with the keyboard (Tab to the toggle, Enter opens, Escape closes)", { todo: "input#nav-toggle is display:none, so Tab never reaches it" }, async () => {
    const { page, context } = await open("about", { width: 390 });
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.id === "nav-toggle" || document.activeElement?.closest("label[for=nav-toggle]"))) break;
    }
    await page.keyboard.press("Enter");
    assert.ok(await page.locator("#nav-menu").isVisible(), "Enter should open the menu");
    await page.keyboard.press("Escape");
    assert.ok(!(await page.locator("#nav-menu").isVisible()), "Escape should close it");
    await context.close();
  });

  test("the menu toggle is at least 24x24 CSS px (WCAG 2.2 target size)", { todo: "label is 19x19" }, async () => {
    const { page, context } = await open("about", { width: 390 });
    const b = await page.locator('label[for="nav-toggle"]').boundingBox();
    await context.close();
    assert.ok(b.width >= 24 && b.height >= 24, `${b.width}x${b.height}`);
  });

  test("a phone downloads exactly one hero image variant", { todo: "five banner variants are requested: all max-width preload queries match" }, async () => {
    const { page, context, requests } = await open("index", { width: 390 });
    await page.waitForLoadState("networkidle");
    await context.close();
    assert.equal(requests.filter((r) => /\/img\/banner-01/.test(r)).length, 1);
  });

  test("the sticky header is not sticky when printing", { todo: "no @media print rules" }, async () => {
    const { page, context } = await open("index");
    await page.emulateMedia({ media: "print" });
    const pos = await page.evaluate(() => getComputedStyle(document.querySelector("header")).position);
    await context.close();
    assert.ok(!["sticky", "fixed"].includes(pos), pos);
  });

  test("text contrast is at least 4.5:1 in light and dark mode", { todo: "resume: p.text-sm.text-gray-500 is 4.48:1" }, async () => {
    for (const colorScheme of ["light", "dark"]) {
      const { page, context } = await open("resume", { width: 390, colorScheme });
      const bad = await page.evaluate(() => {
        const px = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const rgba = (c) => { px.clearRect(0, 0, 1, 1); px.fillStyle = c; px.fillRect(0, 0, 1, 1); return [...px.getImageData(0, 0, 1, 1).data]; };
        const lum = ([r, g, b]) => [r, g, b].map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
        const bgOf = (el) => { for (; el; el = el.parentElement) { const c = rgba(getComputedStyle(el).backgroundColor); if (c[3] > 0) return c; } return [255, 255, 255, 255]; };
        const out = [];
        for (const el of document.querySelectorAll("main p, main li, main h1, main h2, main h3, main h4, main h5, main span")) {
          if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
          const f = rgba(getComputedStyle(el).color), b = bgOf(el);
          const [l1, l2] = [lum(f), lum(b)].sort((a, c) => c - a);
          const ratio = (l1 + 0.05) / (l2 + 0.05);
          if (ratio < 4.5) out.push(`${el.tagName}.${el.className} ${ratio.toFixed(2)}`);
        }
        return [...new Set(out)];
      });
      await context.close();
      assert.deepEqual(bad, [], colorScheme);
    }
  });
});
