import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { ALIASES, ALL_PAGES, SITE, all, attr, classes, dom, exists, fileFor, link, localPath, read, tags, urlPath } from "./helpers/site.mjs";

// Every reference found in a page: [kind, url, node]
function refs(p) {
  const d = dom(p);
  const out = [];
  for (const n of all(d, (x) => ["a", "link", "img", "source", "script"].includes(x.tagName))) {
    const rel = attr(n, "rel");
    if (n.tagName === "link" && ["dns-prefetch", "preconnect"].includes(rel)) continue;
    for (const k of ["href", "src"]) if (attr(n, k) !== undefined) out.push([`${n.tagName}[${k}]`, attr(n, k), n]);
    if (attr(n, "srcset")) for (const part of attr(n, "srcset").split(",")) out.push([`${n.tagName}[srcset]`, part.trim().split(/\s+/)[0], n]);
  }
  for (const k of ["og:image", "twitter:image", "og:url"]) {
    const m = all(d, (x) => x.tagName === "meta" && [attr(x, "name"), attr(x, "property")].includes(k))[0];
    if (m) out.push([`meta[${k}]`, attr(m, "content"), m]);
  }
  return out;
}

describe("internal references resolve to files of the built site", () => {
  for (const p of ALL_PAGES) {
    test(p, () => {
      const r = refs(p);
      assert.ok(r.length > 10, "expected to find references");
      const missing = [];
      for (const [kind, url, n] of r) {
        const lp = localPath(url, urlPath(p));
        if (lp === null) continue;
        if (!exists(fileFor(lp))) missing.push(`${kind} ${url}`);
      }
      assert.deepEqual(missing, []);
    });
  }
});

describe("fragments", () => {
  test("every #fragment link targets an existing id", () => {
    const bad = [];
    for (const p of ALL_PAGES)
      for (const n of tags(dom(p), "a")) {
        const h = attr(n, "href");
        if (!h?.includes("#")) continue;
        const [path, frag] = h.split("#");
        if (!frag) continue;
        const lp = path ? localPath(path, urlPath(p)) : urlPath(p);
        if (lp === null) continue;
        const target = lp === "/" ? "index" : lp.replace(/^\//, "").replace(/\.html$/, "");
        const ids = new Set(all(dom(target), (x) => x.attrs?.some((a) => a.name === "id")).map((x) => attr(x, "id")));
        if (!ids.has(frag)) bad.push(`${p}: ${h}`);
      }
    assert.deepEqual(bad, []);
  });
});

describe("policy", () => {
  test("nothing links to /index.html (home is '/')", () => {
    for (const p of ALL_PAGES) for (const [kind, url] of refs(p)) assert.ok(!/(^|\/)index\.html$/.test(url), `${p}: ${kind} ${url}`);
  });
  test("nothing links to an alias URL (aliases only serve old external links)", () => {
    for (const p of ALL_PAGES) for (const [kind, url] of refs(p)) for (const a of ALIASES) assert.ok(!url.endsWith(`/${a.from}.html`), `${p}: ${kind} ${url}`);
  });
  test("external links use https; target=_blank links have rel=noopener", () => {
    let n = 0;
    for (const p of ALL_PAGES)
      for (const a of tags(dom(p), "a")) {
        const h = attr(a, "href");
        if (!/^https?:\/\//.test(h ?? "") || localPath(h) !== null) continue;
        n++;
        assert.match(h, /^https:\/\//, `${p}: ${h}`);
        if (attr(a, "target") === "_blank") assert.match(attr(a, "rel") ?? "", /noopener/, `${p}: ${h}`);
      }
    assert.ok(n > 0, "expected external links");
  });
  test("CSS url() references exist", () => {
    for (const f of readdirSync(`${SITE}/css`)) for (const m of read(`css/${f}`).matchAll(/url\(["']?([^)"']+)/g)) {
      const lp = localPath(m[1], "/css/");
      if (lp !== null) assert.ok(exists(fileFor(lp)), m[1]);
    }
  });
});
