// Logo, favicon and app icons: SVG sources that follow the colour scheme, plus rendered raster fallbacks (tools/build-icons.mjs).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGES, ROOT, SITE, all, attr, classes, dom, exists, link, localPath, read, tags } from "./helpers/site.mjs";

const bytes = (p) => readFileSync(join(SITE, p.replace(/^\//, "")));
const pngSize = (b) => {
  assert.equal(b.subarray(1, 4).toString(), "PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

describe("every page declares the icons", () => {
  for (const p of [...PAGES, "404"]) {
    test(p, () => {
      const icons = link(dom(p), "icon");
      assert.ok(icons.some((l) => attr(l, "type") === "image/svg+xml"), `${p}: SVG icon`);
      assert.ok(icons.some((l) => /favicon\.ico$/.test(attr(l, "href"))), `${p}: ICO icon`);
      assert.ok(link(dom(p), "apple-touch-icon").length === 1, `${p}: apple-touch-icon`);
      for (const l of [...icons, ...link(dom(p), "apple-touch-icon")]) assert.ok(exists(localPath(attr(l, "href")).replace(/^\//, "")), attr(l, "href"));
    });
  }
});

test("the SVG icon switches colours with prefers-color-scheme", () => {
  assert.match(read("img/favicon.svg"), /@media \(prefers-color-scheme: dark\)/);
});

test("/favicon.ico is a real ICO with 16, 32 and 48 px images (browsers and bots request it unconditionally)", () => {
  const b = bytes("favicon.ico");
  assert.deepEqual([b.readUInt16LE(0), b.readUInt16LE(2)], [0, 1]);
  const n = b.readUInt16LE(4);
  assert.deepEqual([...Array(n).keys()].map((i) => b[6 + 16 * i]).sort((a, c) => a - c), [16, 32, 48]);
});

test("apple-touch-icon is a 180 px opaque PNG", () => {
  const l = link(dom("index"), "apple-touch-icon")[0];
  assert.deepEqual(pngSize(bytes(attr(l, "href"))), [180, 180]);
});

describe("web manifest icons", () => {
  const icons = (lang = "") => JSON.parse(read(`${lang}manifest.webmanifest`)).icons;
  for (const lang of ["", "en/"]) {
    test(`${lang || "ru"}: 192 and 512 any, plus a separate 512 maskable (never one file with both purposes)`, () => {
      const i = icons(lang);
      assert.deepEqual(i.map((x) => [x.sizes, x.purpose]), [["192x192", "any"], ["512x512", "any"], ["512x512", "maskable"]]);
      for (const x of i) assert.deepEqual(pngSize(bytes(x.src)), x.sizes.split("x").map(Number));
    });
  }
});

describe("logo", () => {
  for (const p of [...PAGES, "404"]) {
    test(`${p}: header and footer logos are inline SVG inside a link that carries the accessible name`, () => {
      const brands = all(dom(p), (n) => n.tagName === "a" && classes(n).includes("navbar-brand"));
      assert.equal(brands.length, 2, "header and footer");
      for (const a of brands) {
        assert.ok(attr(a, "aria-label")?.trim(), `${p}: aria-label`);
        const [svg] = tags(a, "svg");
        assert.equal(attr(svg, "aria-hidden"), "true");
        assert.equal(tags(a, "img").length + tags(a, "picture").length, 0, "no raster logo");
        assert.equal(attr(svg, "width") + "x" + attr(svg, "height"), "160x32");
      }
    });
  }
  test("the logo takes its colours from the theme variables (no hard-coded fills in the SVG source)", () => {
    assert.doesNotMatch(readFileSync(join(ROOT, "src/assets/img/logo.svg"), "utf8"), /fill="#|stroke="#|fill:\s*#/i);
  });
});
