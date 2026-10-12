import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname } from "node:path";
import { PAGES, SITE, all, attr, classes, dom, link, localPath, meta, tags } from "./helpers/site.mjs";

const imgs = readdirSync(`${SITE}/img`);
const size = (f) => statSync(`${SITE}/img/${f}`).size;
const pngWidth = (f) => readFileSync(`${SITE}/img/${f}`).readUInt32BE(16);

test("only web-friendly formats are shipped", () => {
  assert.ok(imgs.length > 20);
  for (const f of imgs) assert.ok([".webp", ".png"].includes(extname(f)), f);
});

test("budgets: processed WebP <= 150 KB each and <= 1.2 MB in total", () => {
  const webp = imgs.filter((f) => f.endsWith(".webp"));
  for (const f of webp) assert.ok(size(f) <= 150 * 1024, `${f}: ${size(f)}`);
  assert.ok(webp.reduce((s, f) => s + size(f), 0) <= 1.2 * 1024 * 1024);
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

describe("known gaps (todo)", () => {
  test("og:image is at most 1200px wide and 300 KB", { todo: "preview.png is 2668px / 723 KB" }, () => {
    const f = localPath(meta(dom("index"), "og:image")).replace("/img/", "");
    assert.ok(pngWidth(f) <= 1200 && size(f) <= 300 * 1024, `${f}: ${pngWidth(f)}px ${size(f)}B`);
  });
  test("at most one preload link per image (no media-query ladder)", { todo: "five banner preloads: all (max-width) queries match on phones" }, () => {
    for (const p of PAGES) assert.ok(link(dom(p), "preload").filter((n) => attr(n, "as") === "image").length <= 1, p);
  });
  test("<picture> media sources are ordered so small screens get small files", { todo: "max-width:1280px source is first and matches everywhere" }, () => {
    for (const p of PAGES)
      for (const pic of tags(dom(p), "picture")) {
        const widths = tags(pic, "source").map((s) => +(attr(s, "media") ?? "").match(/max-width:\s*(\d+)/)?.[1]).filter(Boolean);
        assert.deepEqual(widths, [...widths].sort((a, b) => a - b), `${p}: ${widths}`);
      }
  });
});
