// Yandex.Metrika regression: the counter was disabled for months by a stray `(false)`
// in the partial's condition (see src/layouts/partials/yandex.metrika.html).
// These tests keep the analytics wired into the production build on every page.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "./helpers/hugo.mjs";
import { ALL_PAGES, htmlPath, read } from "./helpers/site.mjs";

const COUNTER = "25758743";

describe("yandex metrika in the production build", () => {
  for (const p of ALL_PAGES) {
    test(`${p}: tag.js loader, exactly one ym(${COUNTER}) init and a noscript fallback`, () => {
      const html = read(`${htmlPath(p)}.html`);
      assert.equal(
        (html.match(/mc\.yandex\.ru\/metrika\/tag\.js/g) ?? []).length,
        1,
        `${p}: tag.js`,
      );
      assert.equal(
        (html.match(new RegExp(`ym\\(${COUNTER},\\s*"init"`, "g")) ?? [])
          .length,
        1,
        `${p}: ym init`,
      );
      assert.equal(
        (
          html.match(
            new RegExp(`mc\\.yandex\\.ru\\/watch\\/${COUNTER}`, "g"),
          ) ?? []
        ).length,
        1,
        `${p}: noscript watch`,
      );
    });
  }

  // A second *installed* counter can only come from executable Hugo templates
  // (src/layouts/**/*.html). Prose in src/content/** is authored text — articles
  // may legitimately mention the counter id (e.g. the metrika-lighthouse post)
  // without being a counter, so content is intentionally out of scope here.
  const layoutFilesWithId = (root) => {
    const files = (d, base = d) =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(d, e.name), base) : [join(d, e.name)],
      );
    return files(root)
      .filter((f) => f.endsWith(".html"))
      .filter((f) => readFileSync(f, "utf8").includes(COUNTER));
  };

  test("counter id appears only in the metrika partial (no duplicate counters)", () => {
    assert.deepEqual(layoutFilesWithId("src/layouts"), [
      "src/layouts/partials/yandex.metrika.html",
    ]);
  });

  test("counter id mentioned in content prose is not a counter (regression: metrika-lighthouse article)", () => {
    const dir = mkdtempSync(join(tmpdir(), "analytics-content-"));
    try {
      const post = join(dir, "src/content/blog/metrika-lighthouse");
      mkdirSync(post, { recursive: true });
      writeFileSync(
        join(post, "index.md"),
        `---\ntitle: t\ndraft: true\n---\n\nСчётчик ${COUNTER} существует и настроен на сайт.`,
      );
      assert.deepEqual(layoutFilesWithId(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Costs a second hugo build, so it runs in CI (CI=true) or with TEST_SLOW=1 — same policy as determinism.test.mjs.
const slow = process.env.CI || process.env.TEST_SLOW;
test(
  "no analytics in a development build",
  { skip: slow ? false : "set TEST_SLOW=1 (runs in CI)" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "site-dev-"));
    try {
      const r = buildSite(dir, "development");
      assert.equal(r.status, 0, r.log);
      const index = readFileSync(join(dir, "index.html"), "utf8");
      assert.ok(
        !index.includes("mc.yandex.ru"),
        "development build must not contain the Metrika counter",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
