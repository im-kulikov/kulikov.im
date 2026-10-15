// Renders the README screenshots (docs/preview-{ru,en}.webp) from the built site: the home page on a MacBook and an iPhone
// (real screenshots at 1280x800 and a 390x844 mobile viewport, devices drawn in CSS), the dark theme on one side and the light theme
// on the other side of a diagonal seam that runs through both screens. The background is transparent: it lies on any GitHub theme.
// Run after changing how the home page looks:  node tests/build.mjs && CHROME_PATH=/path/to/chrome node tools/build-previews.mjs
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { SITE } from "../tests/helpers/paths.mjs";

const SCALE = 1.5; // the output is 940x620 CSS px at this device scale factor
const CANVAS = { w: 940, h: 620 };
const SEAM_TOP = 369; // x of the seam at y = 0; it leans right going down: x = SEAM_TOP + SEAM_SLOPE * y (light theme on its left/bottom side)
const SEAM_SLOPE = 0.857;
const PAGES = [["ru", "/"], ["en", "/en/"]];

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

const VIEWPORTS = { mac: { width: 1280, height: 800, scale: 1.5, mobile: false }, phone: { width: 390, height: 844, scale: 2, mobile: true } };
const shot = async (path, colorScheme, { width, height, scale, mobile }) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme, isMobile: mobile, hasTouch: mobile });
  await page.goto(origin + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot();
  await page.close();
  return `data:image/png;base64,${png.toString("base64")}`;
};

// Each device is drawn twice, dark and light, and the light copy is clipped by the seam. The devices are stacked one after the other
// (MacBook, then the iPhone on top) so the phone's ring and shadow are never covered by the light copy of the MacBook screen.
const STATUS = '<div class="sb"><span>9:41</span><span>●●● ▮</span></div><div class="isl"></div>';
const compose = (img) => {
  const seam = `polygon(-400px -100px,${SEAM_TOP + SEAM_SLOPE * -100}px -100px,${SEAM_TOP + SEAM_SLOPE * 900}px 900px,-400px 900px)`;
  const mac = (t, cls) => `<div class="layer ${cls}"><div class="dev mac"><div class="lid"><div class="scr"><img src="${img.mac[t]}"></div></div><div class="base"></div></div></div>`;
  const phone = (t, cls) => `<div class="layer ${cls}"><div class="dev phone"><div class="body"><div class="scr">${STATUS}<img src="${img.phone[t]}"></div></div></div></div>`;
  return `<style>
*{box-sizing:border-box}html,body{margin:0;background:transparent}body{width:${CANVAS.w}px;height:${CANVAS.h}px;position:relative;overflow:hidden;font-family:-apple-system,"SF Pro Text",system-ui,sans-serif}
.layer{position:absolute;inset:0}.light{clip-path:${seam}}
.dev{position:absolute}.scr{overflow:hidden;position:relative}.scr img{display:block;width:100%;object-fit:cover;object-position:top}
.mac{left:60px;top:20px}
.mac .lid{width:668px;height:424px;padding:12px;background:#0c0c0e;border-radius:18px 18px 4px 4px;box-shadow:0 0 0 1.5px #aeb2ba,0 0 0 2.5px rgba(0,0,0,.35);position:relative}
.mac .lid::after{content:"";position:absolute;left:50%;top:0;width:90px;height:16px;transform:translateX(-50%);background:#0c0c0e;border-radius:0 0 10px 10px}
.mac .scr{width:644px;height:400px;border-radius:6px}.mac .scr img{height:400px}
.mac .base{width:780px;height:16px;margin:0 -56px;background:linear-gradient(#d9dce2,#a9adb5);border-radius:0 0 16px 16px;position:relative;box-shadow:0 18px 28px rgba(0,0,0,.28)}
.mac .base::before{content:"";position:absolute;left:50%;top:0;width:120px;height:6px;transform:translateX(-50%);background:#8e929a;border-radius:0 0 8px 8px}
.phone{left:650px;top:110px}
.phone .body{width:206px;height:424px;padding:9px;background:#0c0c0e;border-radius:40px;box-shadow:0 0 0 1.5px #aeb2ba,0 0 0 2.5px rgba(0,0,0,.35),0 26px 40px rgba(0,0,0,.35);position:relative}
.phone .body::after{content:"";position:absolute;left:50%;top:15px;width:54px;height:15px;transform:translateX(-50%);background:#000;border-radius:10px}
.phone .scr{width:188px;height:406px;border-radius:32px}
.sb{position:absolute;left:0;right:0;top:0;height:40px;font-size:10px;font-weight:600;display:flex;justify-content:space-between;align-items:center;padding:6px 18px 0}
.isl{position:absolute;left:50%;top:9px;width:56px;height:16px;transform:translateX(-50%);background:#000;border-radius:10px}
.phone .scr img{position:absolute;top:40px;height:auto;min-height:366px}
.dark .scr{background:#0b0f14}.dark .sb{color:#f5f7fa}.light .scr{background:#fff}.light .sb{color:#0b0f14}
.light .lid{background:transparent;box-shadow:none}.light .lid::after,.light .base{display:none}.light .phone .body{box-shadow:none}
</style>${mac("dark", "dark")}${mac("light", "light")}${phone("dark", "dark")}${phone("light", "light")}`;
};

for (const [lang, path] of PAGES) {
  const img = { mac: {}, phone: {} };
  for (const t of ["dark", "light"]) {
    img.mac[t] = await shot(path, t, VIEWPORTS.mac);
    img.phone[t] = await shot(path, t, VIEWPORTS.phone);
  }
  const page = await browser.newPage({ viewport: { width: CANVAS.w, height: CANVAS.h }, deviceScaleFactor: SCALE });
  await page.setContent(compose(img));
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  const png = await page.screenshot({ omitBackground: true });
  // Chromium encodes the WebP with its alpha channel (no image library needed)
  const webp = await page.evaluate(async (b64) => {
    const el = new Image();
    el.src = "data:image/png;base64," + b64;
    await el.decode();
    const c = Object.assign(document.createElement("canvas"), { width: el.width, height: el.height });
    c.getContext("2d").drawImage(el, 0, 0);
    return c.toDataURL("image/webp", 0.85).split(",")[1];
  }, png.toString("base64"));
  await writeFile(join(out, `preview-${lang}.webp`), Buffer.from(webp, "base64"));
  await page.close();
}
await browser.close();
server.close();
