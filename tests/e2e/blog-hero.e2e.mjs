// Blog hero regression (see PR feat/image-pipeline-hero): the /blog/ hero art is a
// compact accent at every viewport — side-by-side with the text from 640px, a small
// centered block below it on narrow screens, never a huge standalone section.
// Run: npm run test:e2e (after npm test — this file reads the built site).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { SITE } from "../helpers/site.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".webp": "image/webp",
  ".png": "image/png",
};
const WIDTHS = [320, 375, 390, 430, 640, 768, 900, 1024, 1280, 1440, 1920];
const MAX_ART = {
  320: 200,
  375: 200,
  390: 200,
  430: 200,
  640: 220,
  768: 220,
  900: 220,
  1024: 280,
  1280: 280,
  1440: 280,
  1920: 280,
};
const MAX_GAP = 64; // hero → первый элемент списка, px
let server, origin, browser;

before(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let f = join(SITE, path.endsWith("/") ? `${path}index.html` : path);
    if (!existsSync(f) || statSync(f).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(f)] ?? "application/octet-stream",
    });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(
    process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  server?.close();
});

for (const width of WIDTHS) {
  test(`blog hero @${width}px: compact art, no overflow, list follows closely`, async () => {
    const page = await browser.newPage({
      viewport: { width, height: Math.max(900, Math.round(width * 0.7)) },
    });
    await page.goto(`${origin}/blog/`, { waitUntil: "networkidle" });
    const m = await page.evaluate(() => {
      const art = document.querySelector(".blog-hero-art img");
      const hero = document.querySelector(".blog-hero");
      const list = document.querySelector(".post-list");
      const r = art.getBoundingClientRect();
      const h = hero.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      return {
        imgW: Math.round(r.width),
        imgH: Math.round(r.height),
        gap: Math.round(l.top - h.bottom),
        overflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        visible: r.width > 0 && r.height > 0,
      };
    });
    await page.close();
    assert.equal(m.overflow, false, `horizontal overflow @${width}`);
    assert.equal(
      m.visible,
      true,
      `hero art must stay visible @${width} (не прятать изображение)`,
    );
    assert.ok(
      m.imgW <= MAX_ART[width],
      `art width ${m.imgW} > ${MAX_ART[width]} @${width}`,
    );
    assert.ok(
      m.imgH <= MAX_ART[width],
      `art height ${m.imgH} > ${MAX_ART[width]} @${width}`,
    );
    assert.ok(
      m.gap <= MAX_GAP,
      `hero→list gap ${m.gap} > ${MAX_GAP} @${width}`,
    );
  });
}
