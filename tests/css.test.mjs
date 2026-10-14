import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { ALL_PAGES, SITE, all, attr, classes, dom, link, read } from "./helpers/site.mjs";

const files = readdirSync(`${SITE}/css`);
const css = files.map((f) => read(`css/${f}`)).join("\n");

test("every page links exactly one local stylesheet and it exists", () => {
  for (const p of ALL_PAGES) {
    const own = link(dom(p), "stylesheet").map((n) => attr(n, "href")).filter((h) => h.startsWith("/css/"));
    assert.equal(own.length, 1, p);
    assert.ok(files.includes(own[0].replace("/css/", "")), own[0]);
  }
});

test("size budget: CSS <= 90 KB (now ~64 KB)", () => {
  for (const f of files) assert.ok(statSync(`${SITE}/css/${f}`).size <= 90 * 1024, f);
});

test("dark mode styles are present (prefers-color-scheme: dark)", () => {
  assert.match(css, /prefers-color-scheme:\s*dark/);
});

test("no unprocessed Tailwind/PostCSS directives leaked into the output", () => {
  assert.doesNotMatch(css, /@(apply|theme|plugin|utility|source|tailwind)\b/);
  assert.doesNotMatch(css, /@import\b/);
});

// Classes used in the HTML but without any rule in the CSS: only page/marker hooks are allowed.
// A new entry here would be a class that silently does nothing (typo): review before adding.
const NO_RULE = new Set([
  "about", "default-page", "git-date", "git-hash", "git-info", "home", "home-page", "img", "open-source", "open-source-page",
  "projects", "projects-page", "resume", "resume-page", "services", "services-page", "system",
]);
test("classes used in HTML have a CSS rule (except the allowlist)", () => {
  const defined = new Set([...css.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, "$1")));
  const used = new Set(ALL_PAGES.flatMap((p) => all(dom(p), (n) => attr(n, "class")).flatMap(classes)));
  const missing = [...used].filter((c) => !defined.has(c) && !NO_RULE.has(c)).sort();
  assert.deepEqual(missing, []);
  // and the allowlist must not rot: every entry is still used and still without a rule
  const stale = [...NO_RULE].filter((c) => !used.has(c) || defined.has(c)).sort();
  assert.deepEqual(stale, [], "remove these from NO_RULE");
});

describe("accessibility and print", () => {
  test("print stylesheet exists (header must not stay sticky on paper)", () => assert.match(css, /@media print/));
  test("reduced-motion is respected", () => assert.match(css, /prefers-reduced-motion/));
});
