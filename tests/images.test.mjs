import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname } from "node:path";
import { PAGES, SITE, all, attr, classes, dom, link, localPath, meta, tags } from "./helpers/site.mjs";

const imgs = readdirSync(`${SITE}/img`);
const size = (f) => statSync(`${SITE}/img/${f}`).size;
const jpegSize = (f) => {
  const b = readFileSync(`${SITE}/img/${f}`);
  for (let i = 2; i < b.length; i += 2 + b.readUInt16BE(i + 2)) {
    while (b[i] !== 0xff) i++;
    if (b[i + 1] >= 0xc0 && b[i + 1] <= 0xc3) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
  }
};

test("only web-friendly formats are shipped", () => {
  assert.ok(imgs.length > 20);
  for (const f of imgs) assert.ok([".webp", ".png", ".jpg"].includes(extname(f)), f);
});

test("budgets: processed WebP <= 150 KB each and <= 3 MB in total", () => {
  const webp = imgs.filter((f) => f.endsWith(".webp"));
  for (const f of webp) assert.ok(size(f) <= 150 * 1024, `${f}: ${size(f)}`);
  assert.ok(webp.reduce((s, f) => s + size(f), 0) <= 3 * 1024 * 1024);
});

test("images rendered by components/image.html: exactly one of loading=lazy / fetchpriority=high", () => {
  let n = 0;
  for (const p of PAGES)
    for (const img of tags(dom(p), "img")) {
      if (!classes(img).includes("img")) continue; // header/footer logo is not part of the component
      n++;
      assert.notEqual(attr(img, "loading") === "lazy", attr(img, "fetchpriority") === "high", `${p}: ${attr(img, "src")}`);
    }
  assert.ok(n > 5);
});

test("only the hero image is preloaded (below-the-fold feature images are not)", () => {
  for (const p of PAGES)
    for (const l of link(dom(p), "preload").filter((n) => attr(n, "as") === "image")) assert.doesNotMatch(attr(l, "href"), /features-/, p);
});

test("og:image is 1200x630 and at most 300 KB", () => {
  const f = localPath(meta(dom("index"), "og:image")).replace("/img/", "");
  const { w, h } = jpegSize(f);
  assert.deepEqual([w, h], [1200, 630]);
  assert.ok(size(f) <= 300 * 1024, `${f}: ${size(f)}B`);
});

test("preload media ranges do not overlap: any screen width matches at most one", () => {
  const matches = (media, w) => [...media.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, k, v]) => (k === "min" ? w >= +v : w <= +v));
  for (const p of PAGES) {
    const pre = link(dom(p), "preload").filter((n) => attr(n, "as") === "image");
    for (const w of [320, 390, 450, 451, 575, 576, 767, 768, 991, 992, 1280, 1281, 1920]) assert.ok(pre.filter((l) => matches(attr(l, "media") ?? "", w)).length <= 1, `${p} @${w}`);
  }
});

describe("known gaps (todo)", () => {
  test("<picture> media sources are ordered so small screens get small files", () => {
    for (const p of PAGES)
      for (const pic of tags(dom(p), "picture")) {
        const widths = tags(pic, "source").map((s) => +(attr(s, "media") ?? "").match(/max-width:\s*(\d+)/)?.[1]).filter(Boolean);
        assert.deepEqual(widths, [...widths].sort((a, b) => a - b), `${p}: ${widths}`);
      }
  });
});
