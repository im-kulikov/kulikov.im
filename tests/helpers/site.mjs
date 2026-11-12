// Shared helpers: built-site access, content-derived page list and a small DOM API over parse5.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "parse5";
import YAML from "yaml";
import { BASE, ROOT, SITE } from "./paths.mjs";

if (!existsSync(join(SITE, "index.html"))) {
  throw new Error(`No built site in ${SITE}. Run "npm test" (it builds first) or "node tests/build.mjs".`);
}

export { BASE, ROOT, SITE };
export const read = (p) => readFileSync(join(SITE, p), "utf8");
export const exists = (p) => existsSync(join(SITE, p));

// Pages are derived from src/content so a new page is tested automatically; drafts are not built.
function frontMatters() {
  const dir = join(ROOT, "src/content");
  // ?? {} — index.md без front matter валиден для Hugo и не должен ронять весь сьют
  const out = { index: YAML.parse(readFileSync(join(dir, "_index.md"), "utf8").split(/^---\s*$/m)[1] ?? "") ?? {} };
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = ["index.md", "_index.md"].map((n) => join(dir, d.name, n)).find(existsSync);
    if (f) out[d.name] = YAML.parse(readFileSync(f, "utf8").split(/^---\s*$/m)[1] ?? "") ?? {};
    // the blog is a RU-only section of nested article bundles: "blog/<slug>" pages, no EN twins;
    // ключ — фронтматтерный slug (URL статьи), с откатом на имя каталога
    if (d.name === "blog" && existsSync(join(dir, d.name, "_index.md"))) {
      for (const a of readdirSync(join(dir, d.name), { withFileTypes: true })) {
        if (!a.isDirectory()) continue;
        const af = join(dir, d.name, a.name, "index.md");
        if (existsSync(af)) {
          const fm = YAML.parse(readFileSync(af, "utf8").split(/^---\s*$/m)[1] ?? "") ?? {};
          out[`blog/${fm.slug ?? a.name}`] = fm;
        }
      }
    }
  }
  return out;
}
const FM = frontMatters();
export function contentPages() {
  return Object.keys(FM).filter((p) => !FM[p].draft).sort();
}
// Old URLs kept alive through `aliases` front matter: { from: "hobbies", to: "open-source" }
export const ALIASES = Object.entries(FM).flatMap(([page, fm]) => (fm.aliases ?? []).map((a) => ({ from: a.replace(/^\/|\.html$/g, ""), to: page })));
export const MENU_ORDER = Object.entries(FM).filter(([, fm]) => fm.menus?.main).sort((a, b) => a[1].menus.main.weight - b[1].menus.main.weight).map(([page]) => page);
// English pages exist where the page has an index.en.md / _index.en.md next to the Russian one.
export const EN_PAGES = Object.keys(FM).filter((p) => !FM[p].draft && ["index.en.md", "_index.en.md"].some((n) => existsSync(join(ROOT, "src/content", p === "index" ? "" : p, n)))).sort();
export const enPath = (page) => (page === "index" ? "/en/" : `/en/${page}.html`);
// the blog section renders at /blog/ (directory permalink), its articles at /blog/<slug>.html
export const urlPath = (page) => (page === "index" ? "/" : page === "blog" ? "/blog/" : `/${page}.html`);
// html file of a page inside the built site ("blog" lives at blog/index.html, not blog.html)
export const htmlPath = (page) => (page === "blog" ? "blog/index" : page);
export const PAGES = contentPages(); // indexable pages (without 404)
export const ALL_PAGES = [...PAGES, "404"].sort();

// ---- DOM (parse5) ----
const cache = new Map();
export function dom(page) {
  if (!cache.has(page)) cache.set(page, parse(read(`${htmlPath(page)}.html`)));
  return cache.get(page);
}
export function* walk(n) {
  yield n;
  for (const c of n.childNodes ?? []) yield* walk(c);
  if (n.content) yield* walk(n.content); // <template>
}
export const all = (root, pred) => [...walk(root)].filter((n) => n.nodeName && !n.nodeName.startsWith("#") && pred(n));
export const tags = (root, name) => all(root, (n) => n.tagName === name);
export const attr = (n, name) => n.attrs?.find((a) => a.name === name)?.value;
export const hasAttr = (n, name) => n.attrs?.some((a) => a.name === name);
export const text = (n) => [...walk(n)].filter((x) => x.nodeName === "#text").map((x) => x.value).join("");
export const meta = (root, key) => attr(all(root, (n) => n.tagName === "meta" && (attr(n, "name") === key || attr(n, "property") === key))[0] ?? { attrs: [] }, "content");
export const link = (root, rel) => all(root, (n) => n.tagName === "link" && attr(n, "rel") === rel);
export const classes = (n) => (attr(n, "class") ?? "").split(/\s+/).filter(Boolean);

// Maps a URL found in a page to a path inside the built site (or null for external URLs).
export function localPath(url, from = "/") {
  if (/^(mailto|tel|data|javascript):/.test(url)) return null;
  if (url.startsWith("//")) return null;
  let u;
  try {
    u = new URL(url, `${BASE}${from}`);
  } catch {
    return null;
  }
  if (u.origin !== BASE) return null;
  return decodeURIComponent(u.pathname);
}
export const fileFor = (p) => (p.endsWith("/") ? `${p}index.html` : p).replace(/^\//, "");
