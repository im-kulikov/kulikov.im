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
  const out = { index: YAML.parse(readFileSync(join(dir, "_index.md"), "utf8").split(/^---\s*$/m)[1]) };
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = ["index.md", "_index.md"].map((n) => join(dir, d.name, n)).find(existsSync);
    if (f) out[d.name] = YAML.parse(readFileSync(f, "utf8").split(/^---\s*$/m)[1] ?? "") ?? {};
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
export const urlPath = (page) => (page === "index" ? "/" : `/${page}.html`);
export const PAGES = contentPages(); // indexable pages (without 404)
export const ALL_PAGES = [...PAGES, "404"].sort();

// ---- DOM (parse5) ----
const cache = new Map();
export function dom(page) {
  if (!cache.has(page)) cache.set(page, parse(read(`${page}.html`)));
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
