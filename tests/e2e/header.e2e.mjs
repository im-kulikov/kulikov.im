// Header regression: the nav is one row from lg (1024, compact) and xl (1280, roomy);
// below 1024 the burger takes over. The header CTA is short ("Написать мне →" / "Message me →")
// while every other Telegram CTA keeps the full label (checked here too).
// Run: npm run test:e2e (after npm test — this file reads the built site)
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { EN_PAGES, SITE, enPath, urlPath } from "../helpers/site.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".webp": "image/webp", ".png": "image/png" };
const WIDTHS = [320, 375, 430, 640, 768, 900, 1024, 1100, 1152, 1280, 1366, 1440, 1536, 1920];
const CHECK_PAGES = ["index", "projects", ...EN_PAGES.map((p) => `en/${p === "index" ? "index" : p}`)];
let server, origin, browser;
const url = (p) => origin + (p === "index" ? "/" : p.startsWith("en/") ? (p === "en/index" ? "/en/" : `/${p}.html`) : urlPath(p));

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
  server.close();
});

describe("header", () => {
  for (const width of WIDTHS)
    test(`@${width}px (RU and EN): no overflow; one row from 1024, burger below`, async () => {
      for (const p of CHECK_PAGES) {
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        const page = await context.newPage();
        await page.goto(url(p), { waitUntil: "load" });
        const m = await page.evaluate(async () => {
          await document.fonts.ready; // font-display: swap — мерим по финальным метрикам
          const overflow = document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth;
          const brand = document.querySelector(".navbar-brand").getBoundingClientRect();
          const nav = document.querySelector("#nav-menu").getBoundingClientRect();
          const toggleVisible = getComputedStyle(document.querySelector("#nav-toggle")).display !== "none";
          const navVisible = nav.width > 0 && nav.height > 0;
          // one row: nav vertically overlaps the brand row and every item's center line matches
          const centers = [...new Set(
            [...document.querySelectorAll("#nav-menu > li")]
              .map((li) => li.getBoundingClientRect())
              .filter((r) => r.width > 0)
              .map((r) => Math.round(r.top + r.height / 2)),
          )];
          const oneRow = centers.length <= 1 && brand.bottom > nav.top && nav.bottom > brand.top;
          return { overflow, toggleVisible, navVisible, oneRow, desktop: window.matchMedia("(min-width: 1024px)").matches };
        });
        await context.close();
        assert.ok(m.overflow <= 0, `${p} @${width}: overflow +${m.overflow}px`);
        if (m.desktop) {
          assert.ok(m.navVisible, `${p} @${width}: the desktop nav must be visible from 1024px`);
          assert.ok(!m.toggleVisible, `${p} @${width}: no burger in the desktop row`);
          assert.ok(m.oneRow, `${p} @${width}: logo, menu, CTA and lang switch must share one row`);
        } else {
          assert.ok(m.toggleVisible, `${p} @${width}: burger must be visible below 1024px`);
        }
      }
    });

  test("the burger menu closes after following a link (handler checked without leaving the page)", async () => {
    const context = await browser.newContext({ viewport: { width: 768, height: 800 } });
    const page = await context.newPage();
    await page.goto(url("index"), { waitUntil: "load" });
    await page.click("#nav-toggle");
    assert.ok(await page.locator("#nav-menu").isVisible());
    // остаёмся на странице (навигация prevented) — иначе тест проходит и без хендлера
    await page.evaluate(() => document.querySelector("#nav-menu a.nav-link").addEventListener("click", (e) => e.preventDefault()));
    await page.locator("#nav-menu a.nav-link").first().click();
    assert.equal(await page.getAttribute("#nav-toggle", "aria-expanded"), "false");
    assert.ok(!(await page.locator("#nav-menu").isVisible()), "the click handler closed the menu, same page");
    await context.close();
  });

  test("the blog (Russian-only) never leaks into the English navigation", async () => {
    for (const p of EN_PAGES) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 800 } });
      const page = await context.newPage();
      await page.goto(origin + enPath(p), { waitUntil: "load" });
      const hrefs = await page.locator("header nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
      await context.close();
      assert.ok(!hrefs.some((h) => h.includes("blog")), `${p}: EN nav must not link to the blog`);
    }
  });

  test("the header CTA is short and points to Telegram; every other Telegram CTA keeps its full label", async () => {
    const cases = [
      { path: "/", short: "Написать мне", full: "Написать в Telegram" },
      { path: "/en/", short: "Message me", full: "Message me on Telegram" },
    ];
    for (const c of cases) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 800 } });
      const page = await context.newPage();
      await page.goto(origin + c.path, { waitUntil: "load" });
      const headerBtn = page.locator("#nav-menu a.btn").first();
      const label = (await headerBtn.textContent()).trim();
      const href = await headerBtn.getAttribute("href");
      assert.match(label, new RegExp(`^${c.short}\\s*→$`), "header button text");
      assert.ok(href.startsWith("https://t.me/"), href);
      // hero, page CTA block and footer keep the full label
      const body = await page.locator("body").textContent();
      const fullCount = (body.match(new RegExp(c.full, "g")) ?? []).length;
      assert.ok(fullCount >= 2, `${c.path}: expected the full CTA label in hero/CTA/footer, found ${fullCount}`);
      await context.close();
    }
  });
});
