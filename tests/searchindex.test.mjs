// The internal search index (/searchindex.json) and the cleanliness guarantees around it:
// only published kulikov.im articles are indexed, the "sources" section of an article
// (external citations) stays readable in the page but never enters the searchable text,
// and mock/demo content cannot reach a production build at all.
//
// The blog content is Git-tracked; the hasBlog guard below only protects against running
// against a checkout/copy where src/content/blog is absent (then the production assertions
// still run — the index must exist and be empty — while the content-dependent suites skip).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { BASE, ROOT, read, exists } from "./helpers/site.mjs";
import { buildSite, HUGO } from "./helpers/hugo.mjs";

const BLOG_DIR = join(ROOT, "src/content/blog");
const hasBlog = existsSync(BLOG_DIR);

// Articles are derived from src/content/blog so real articles replace the mock ones without test edits.
function blogArticles() {
  return readdirSync(BLOG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const file = join(BLOG_DIR, d.name, "index.md");
      const text = readFileSync(file, "utf8");
      const fm = YAML.parse(text.split(/^---\s*$/m)[1]) ?? {};
      return { slug: fm.slug ?? d.name, fm, text, file };
    });
}
const ARTICLES = hasBlog ? blogArticles() : [];
const url = (a) => `${BASE}/blog/${a.slug}.html`;
// external citations live in the {{< sources >}} shortcode block of each article
const sourcesOf = (a) => {
  const m = /\{\{<\s*sources[^>]*>\}\}([\s\S]*?)\{\{<\s*\/sources\s*>\}\}/.exec(a.text);
  if (!m) return { urls: [], labels: [] };
  return {
    urls: [...m[1].matchAll(/\]\((https?:[^)\s]+)\)/g)].map((x) => x[1]),
    labels: [...m[1].matchAll(/\[([^\]]+)\]\(https?:[^)\s]+\)/g)].map((x) => x[1]),
  };
};
// a phrase from the middle of the body (after the more divider) — must stay searchable
const bodyPhraseOf = (a) => a.text.split("<!--more-->")[1].match(/^##\s.+$/m)[0].replace(/^##\s+/, "");

describe("searchindex.json: production build ships only published kulikov.im articles", () => {
  test("valid JSON array with exactly the published (non-draft, non-mock) articles", () => {
    assert.ok(exists("searchindex.json"));
    const idx = JSON.parse(read("searchindex.json"));
    assert.ok(Array.isArray(idx));
    const published = ARTICLES.filter((a) => a.fm.draft !== true && a.fm.mock !== true);
    assert.deepEqual(
      idx.map((e) => e.uri).sort(),
      published.map(url).sort(),
    );
  });

  test("every entry is an internal article URL with the full metadata — an external source can never become an entry", () => {
    const idx = JSON.parse(read("searchindex.json"));
    for (const e of idx) {
      assert.match(e.uri, new RegExp(`^${BASE}/blog/[a-z0-9-]+\\.html$`), e.uri);
      for (const key of ["uri", "title", "description", "keywords", "tags", "date", "text"]) assert.ok(key in e, `${e.uri}: no ${key}`);
      for (const list of [e.keywords, e.tags]) assert.ok(Array.isArray(list), `${e.uri}: keywords/tags must be arrays, not null`);
      // ловим НЕДОДЕКОДИРОВАННЫЕ сущности; сам «&» легитимен (например «&&» в shell-сниппетах)
      assert.doesNotMatch(e.text, /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/, `${e.uri}: html entities left in the searchable text`);
    }
  });

  test("the English home ships an empty search index (the blog is RU-only)", () => {
    assert.ok(exists("en/searchindex.json"), "en/searchindex.json must exist");
    assert.deepEqual(JSON.parse(read("en/searchindex.json")), []);
  });

  test("production artifacts contain no draft or mock blog pages; sitemap lists exactly the published articles", () => {
    const dirty = ARTICLES.filter((a) => a.fm.draft === true || a.fm.mock === true);
    const published = ARTICLES.filter((a) => a.fm.draft !== true && a.fm.mock !== true);
    for (const a of dirty) {
      assert.ok(!exists(`blog/${a.slug}.html`), `${a.slug}: draft/mock page built in production`);
      assert.ok(!read("ru/sitemap.xml").includes(`/blog/${a.slug}`), `${a.slug}: in the sitemap`);
    }
    // безусловно: sitemap и фид перечисляют ровно опубликованные статьи и страницу секции
    const sitemapBlog = [...read("ru/sitemap.xml").matchAll(/<loc>([^<]*\/blog\/[^<]*)<\/loc>/g)].map((m) => m[1]).sort();
    const expectedSitemap = published.length
      ? [`${BASE}/blog/`, ...published.map((a) => `${BASE}/blog/${a.slug}.html`)]
      : [];
    assert.deepEqual(sitemapBlog, expectedSitemap.sort());
    if (published.length > 0) {
      assert.ok(exists("blog/index.xml"), "published articles imply the section feed");
      const feed = read("blog/index.xml");
      for (const a of published) assert.ok(feed.includes(`/blog/${a.slug}.html`), `${a.slug}: missing from the feed`);
      for (const a of dirty) assert.ok(!feed.includes(`/blog/${a.slug}.html`), `${a.slug}: draft/mock in the production feed`);
    }
  });
});

// Everything below needs the (gitignored) blog content — skipped on a fresh checkout.
(hasBlog ? describe : describe.skip)("with blog content: sources stay out of the index text; mock cannot ship", () => {
  // Drafts/guard builds run in an isolated copy of the project: node --test runs files in
  // parallel, and a second build inside ROOT would race determinism.test.mjs over the
  // shared hugo_stats.json and build/resources.
  const FX = join(ROOT, "build", "searchindex-fixture");
  const DRAFTS = join(FX, "drafts-out");
  let fixtureReady = false;
  const makeFixture = () => {
    if (fixtureReady) return;
    rmSync(FX, { recursive: true, force: true });
    mkdirSync(FX, { recursive: true });
    // project copy (VCS and gitignored dirs excluded); node_modules is symlinked for the CSS pipeline.
    // hugo_stats.json НЕ копируем rsync'ом: параллельный determinism-тест перезаписывает его в ROOT,
    // и «разорванный» файл уехал бы в фикстуру — копируем атомарно, через буфер в памяти
    const cp = spawnSync("rsync", ["-a", "--exclude", ".git", "--exclude", "build", "--exclude", "tmp", "--exclude", "node_modules", "--exclude", "hugo_stats.json", `${ROOT}/`, `${FX}/`]);
    assert.equal(cp.status, 0, cp.stderr);
    symlinkSync(join(ROOT, "node_modules"), join(FX, "node_modules"));
    writeFileSync(join(FX, "hugo_stats.json"), readFileSync(join(ROOT, "hugo_stats.json")));
    fixtureReady = true;
  };
  const readDrafts = (p) => readFileSync(join(DRAFTS, p), "utf8");

  test("the drafts (dev preview) build succeeds in the fixture copy; a nested raw <section> inside sources cannot leak", () => {
    makeFixture();
    // вставляем в копию одной статьи вложенный <section> внутри {{< sources >}}:
    // strip-регекс шаблона обязан дойти до сентинела <!--/sources-->, а не до первого </section>
    const target = ARTICLES.find((a) => a.fm.mock !== true);
    const artFile = join(FX, "src/content/blog", target.slug, "index.md");
    writeFileSync(artFile, `${readFileSync(artFile, "utf8")}\n\n{{< sources >}}\n- [Проверка утечки](https://example.com/leak-check)\n\n<section>вложенная секция LEAKMARK не должна попасть в индекс</section>\n\n- [Ещё](https://example.com/also)\n{{< /sources >}}\n`);
    const r = buildSite(DRAFTS, "development", ["--buildDrafts", "--enableGitInfo=false"], { cwd: FX });
    assert.ok(r.status === 0, `drafts build failed:\n${r.log}`);
    assert.ok(existsSync(join(DRAFTS, "searchindex.json")));
    const idx = JSON.parse(readFileSync(join(DRAFTS, "searchindex.json"), "utf8"));
    const entry = idx.find((e) => e.uri === url(target));
    assert.ok(entry, `${target.slug}: entry present`);
    assert.ok(!entry.text.includes("LEAKMARK"), "nested section content leaked into the index text");
    assert.ok(!entry.text.includes("leak-check"), "source URL leaked into the index text");
  });

  test("each article is one entry; source URLs and labels never leak into its text", () => {
    const idx = JSON.parse(readDrafts("searchindex.json"));
    assert.deepEqual(
      idx.map((e) => e.uri).sort(),
      ARTICLES.map(url).sort(),
    );
    for (const a of ARTICLES) {
      const entry = idx.find((e) => e.uri === url(a));
      const { urls, labels } = sourcesOf(a);
      assert.ok(urls.length > 0, `${a.slug}: no sources block found`);
      for (const u of urls) assert.ok(!entry.text.includes(u), `${a.slug}: source URL leaked: ${u}`);
      for (const l of labels) assert.ok(!entry.text.includes(l), `${a.slug}: source label leaked: ${l}`);
      assert.ok(entry.text.includes(bodyPhraseOf(a)), `${a.slug}: body heading missing from the index text`);
    }
  });

  test("the sources section stays visible to the reader in the article HTML", () => {
    for (const a of ARTICLES) {
      const html = readDrafts(`blog/${a.slug}.html`);
      assert.match(html, /<section[^>]*data-search-exclude[^>]*>/, a.slug);
      for (const u of sourcesOf(a).urls) assert.ok(html.includes(u), `${a.slug}: ${u} disappeared from the page`);
    }
  });

  test("the blog RSS feed lists the built articles and no demo markers", () => {
    const feed = readDrafts("blog/index.xml");
    for (const a of ARTICLES) assert.ok(feed.includes(url(a)), a.slug);
    assert.ok(!feed.includes(">демо<"));
  });

  test("a mock article with draft removed fails the production build (no demo pages can ship)", () => {
    makeFixture();
    const undraft = (p) => {
      const s = readFileSync(p, "utf8");
      assert.match(s, /^draft: true$/m, p);
      writeFileSync(p, s.replace(/^draft: true$/m, "draft: false"));
    };
    let build;
    try {
      // the wrong integration, simulated in the throwaway copy only: a synthetic demo
      // article (mock: true) goes live together with the section
      const demo = join(FX, "src/content/blog/mock-guard-demo");
      mkdirSync(demo, { recursive: true });
      writeFileSync(join(demo, "index.md"), [
        "---",
        'title: "Демо-статья для guard-теста"',
        "description: Служебный фиктивный материал, существует только внутри тестовой копии сайта.",
        "date: 2026-11-11",
        "tags: [тест]",
        "draft: true",
        "slug: mock-guard-demo",
        "mock: true",
        "---",
        "",
        "Текст фиктивной статьи.",
        "",
      ].join("\n"));
      undraft(join(demo, "index.md"));
      build = spawnSync(HUGO, ["--gc", "--minify", "--panicOnWarning", "--enableGitInfo=false", "--baseURL", `${BASE}/`, "--destination", "guard-out"], {
        cwd: FX,
        encoding: "utf8",
        env: { ...process.env, HUGO_ENVIRONMENT: "production" },
      });
    } finally {
      rmSync(FX, { recursive: true, force: true });
    }
    assert.notEqual(build.status, 0, "a mock article was published by a production build");
    assert.match(`${build.stdout}\n${build.stderr}`, /marked `mock`/);
  });
});
