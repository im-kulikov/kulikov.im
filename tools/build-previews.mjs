// Renders the README screenshots (docs/preview-{ru,en}-{light,dark}.webp) from the built site.
// Run after changing how the home page looks:  node tests/build.mjs && CHROME_PATH=/path/to/chrome node tools/build-previews.mjs
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { SITE } from "../tests/helpers/paths.mjs";

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  let path = new URL(req.url, "http://x").pathname;
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(SITE, path));
    res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((ok) => server.listen(0, ok));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
const out = process.env.OUT_DIR ?? new URL("../docs/", import.meta.url).pathname;
for (const [lang, path] of [["ru", "/"], ["en", "/en/"]]) {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: scheme });
    await page.goto(origin + path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot();
    // Chromium encodes the WebP (no image library needed)
    const webp = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
      c.getContext("2d").drawImage(img, 0, 0);
      return c.toDataURL("image/webp", 0.8).split(",")[1];
    }, png.toString("base64"));
    await writeFile(join(out, `preview-${lang}-${scheme}.webp`), Buffer.from(webp, "base64"));
    await page.close();
  }
}
await browser.close();
server.close();
