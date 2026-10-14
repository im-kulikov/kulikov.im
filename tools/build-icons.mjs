// Renders the raster icons from src/assets/img/favicon.svg (the single source of the mark) with Chromium.
// Run after changing the SVG:  CHROME_PATH=/path/to/chrome node tools/build-icons.mjs
// Output (committed): apple-touch-icon.png (180), icon-192.png, icon-512.png, icon-maskable-512.png, favicon.ico (16/32/48).
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const dir = new URL("../src/assets/img/", import.meta.url);
const svg = readFileSync(new URL("favicon.svg", dir), "utf8");
// the same drawing without the tile: reused full-bleed (apple-touch, maskable) on a flat background
const mark = svg.match(/<polygon[\s\S]*<\/svg>/)[0].replace("</svg>", "");
const light = svg.replace(/@media[\s\S]*?\n    }\n  <\/style>/, "</style>"); // PNG/ICO fallbacks can't switch theme: always the blue tile
const fullBleed = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.hex{fill:#fff;stroke:#fff}.prompt{stroke:#0369a1}.cursor{fill:#0369a1}</style><rect width="64" height="64" fill="#0369a1"/><g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${mark}</g></svg>`;

const jobs = [
  ["icon-192.png", light, 192, true],
  ["icon-512.png", light, 512, true],
  ["apple-touch-icon.png", fullBleed(0.98), 180, false],
  ["icon-maskable-512.png", fullBleed(0.8), 512, false], // mark inside the 80% safe circle
];
const sizes = [16, 32, 48];

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
const render = async (markup, size, transparent) => {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent">${markup.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `)}</body>`);
  const png = await page.screenshot({ omitBackground: transparent });
  await page.close();
  return png;
};
for (const [name, markup, size, transparent] of jobs) writeFileSync(new URL(name, dir), await render(markup, size, transparent));

// favicon.ico: PNG images inside an ICO container
const pngs = await Promise.all(sizes.map((s) => render(light, s, true)));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
pngs.forEach((png, i) => {
  const e = 6 + 16 * i;
  head[e] = sizes[i];
  head[e + 1] = sizes[i];
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(png.length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
writeFileSync(new URL("favicon.ico", dir), Buffer.concat([head, ...pngs]));
await browser.close();
