// Renders the README screenshots (docs/preview-{ru,en}.webp) from the built site: the home page in a macOS-style browser window,
// dark theme on the left and light theme on the right of a diagonal seam, on a transparent background (it lies on any GitHub theme).
// Run after changing how the home page looks:  node tests/build.mjs && CHROME_PATH=/path/to/chrome node tools/build-previews.mjs
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { SITE } from "../tests/helpers/paths.mjs";

const W = 1280; // page width in CSS px; the window is W x (H + BAR)
const H = 720;
const BAR = 40;
const PAD = 48; // room for the shadow
const SCALE = 1.5;
const SEAM = [1000, 380]; // x of the seam at the top and at the bottom of the window, "/" leaning right going up
const PAGES = [["ru", "/", "kulikov.im"], ["en", "/en/", "kulikov.im/en"]];

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

const shot = async (path, colorScheme) => {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, colorScheme });
  await page.goto(origin + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot();
  await page.close();
  return `data:image/png;base64,${png.toString("base64")}`;
};

const LOCK = '<svg viewBox="0 0 12 12"><path d="M3 5V4a3 3 0 016 0v1h.5A1.5 1.5 0 0111 6.5v3A1.5 1.5 0 019.5 11h-7A1.5 1.5 0 011 9.5v-3A1.5 1.5 0 012.5 5H3zm1.5 0h3V4a1.5 1.5 0 00-3 0v1z"/></svg>';
const layer = (cls, img, url) => `<div class="layer ${cls}"><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="url">${LOCK}${url}</span></div><img src="${img}"></div>`;
const compose = (dark, light, url) => `<style>
*{box-sizing:border-box}html,body{margin:0;background:transparent}body{padding:${PAD}px;font-family:-apple-system,"SF Pro Text",system-ui,sans-serif}
.win{position:relative;width:${W}px;height:${H + BAR}px;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(128,128,128,.35),0 20px 50px rgba(0,0,0,.25),0 4px 12px rgba(0,0,0,.15)}
.layer{position:absolute;inset:0}.light{clip-path:polygon(${SEAM[0]}px 0,${W}px 0,${W}px ${H + BAR}px,${SEAM[1]}px ${H + BAR}px)}
.bar{height:${BAR}px;display:flex;align-items:center;padding:0 14px;position:relative}
.dots{display:flex;gap:8px}.dots i{width:12px;height:12px;border-radius:50%;display:block;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.2)}
.dots i:nth-child(1){background:#ff5f57}.dots i:nth-child(2){background:#febc2e}.dots i:nth-child(3){background:#28c840}
.url{position:absolute;left:92px;top:7px;width:380px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px}
.url svg{width:11px;height:11px}
.dark .bar{background:linear-gradient(#3a3a3d,#2e2e31);border-bottom:1px solid #121214}
.dark .url{background:#1c1c1e;color:#e5e5ea;box-shadow:0 0 0 .5px rgba(255,255,255,.12)}.dark svg{fill:#98989d}
.light .bar{background:linear-gradient(#ebebeb,#d9d9d9);border-bottom:1px solid #bdbdbd}
.light .url{background:#fff;color:#3c3c43;box-shadow:0 0 0 .5px rgba(0,0,0,.15)}.light svg{fill:#6e6e73}
img{display:block;width:${W}px;height:${H}px}
</style><div class="win">${layer("dark", dark, url)}${layer("light", light, url)}</div>`;

for (const [lang, path, url] of PAGES) {
  const page = await browser.newPage({ viewport: { width: W + 2 * PAD, height: H + BAR + 2 * PAD }, deviceScaleFactor: SCALE });
  await page.setContent(compose(await shot(path, "dark"), await shot(path, "light"), url));
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  const png = await page.screenshot({ omitBackground: true });
  // Chromium encodes the WebP with its alpha channel (no image library needed)
  const webp = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", 0.8).split(",")[1];
  }, png.toString("base64"));
  await writeFile(join(out, `preview-${lang}.webp`), Buffer.from(webp, "base64"));
  await page.close();
}
await browser.close();
server.close();
