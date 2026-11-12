#!/usr/bin/env node
// Шаг 11: сборка Review Package в tmp/drafts/<id>/. Сначала validate.mjs (если не --skip-validate),
// затем проверка полноты (brief/article/telegram/metadata + 3 концепции × {prompt, telegram.png,
// blog-cover.webp, blog-preview.webp}), затем metadata.json и каркас review.md.
//
// Пользовательские материалы (brief/article/telegram/prompts/изображения) НЕ перезаписываются:
// metadata.json пересобирается каждый запуск, review.md создаётся только если его ещё нет.
//
//   node .agents/skills/article-production/scripts/package.mjs <id> [--skip-validate]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP, readState, validId } from "./lib.mjs";
import { checkImages, imageInfo } from "./images.mjs";

const id = process.argv[2];
const skipValidate = process.argv.includes("--skip-validate");
if (!id || !validId(id)) {
  console.error("usage: package.mjs <article-id> [--skip-validate]");
  process.exit(2);
}
const drafts = join(TMP, "drafts", id);
if (!existsSync(drafts)) {
  console.error(`нет каталога ${drafts}`);
  process.exit(1);
}

if (!skipValidate) {
  const v = spawnSync(process.execPath, [join(import.meta.dirname, "validate.mjs"), id], { stdio: "inherit" });
  if (v.status !== 0) {
    console.error("\nvalidate не прошёл — review package не собирается. Исправь и повтори.");
    process.exit(1);
  }
}

// ---- полнота (отсутствующие изображения заглушками не подменяются) ----
const REQUIRED = ["brief.md", "article.md", "telegram.md", "telegram.json"];
const CONCEPT_FILES = ["prompt.md", "telegram.png", "blog-cover.webp", "blog-preview.webp"];
const imagesDir = join(drafts, "images");
const missing = [];
for (const f of REQUIRED) if (!existsSync(join(drafts, f))) missing.push(f);
if (!existsSync(join(imagesDir, "brief.md"))) missing.push("images/brief.md (Image Brief)");
const concepts = existsSync(imagesDir)
  ? readdirSync(imagesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^concept-\d+$/.test(d.name)).map((d) => d.name).sort()
  : [];
if (concepts.length !== 3) missing.push(`концепции: найдено ${concepts.length}, нужно ровно 3 (concept-01…03)`);
for (const c of concepts) for (const f of CONCEPT_FILES) if (!existsSync(join(imagesDir, c, f))) missing.push(`${c}/${f}`);
if (missing.length) {
  console.error("Отсутствуют обязательные файлы (генерация не завершена или не сохранена):");
  missing.forEach((m) => console.error(`  ✗ ${m}`));
  process.exit(1);
}

const img = checkImages(imagesDir);
if (!img.ok) {
  img.problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error("Изображения не прошли проверку — review package не собирается.");
  process.exit(1);
}

// ---- metadata.json (пересобирается; материалы не трогаем) ----
let state = null;
try { state = readState(id); } catch { /* state необязателен для пакета */ }
const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const fileRec = (f) => ({ bytes: statSync(f).size, sha256: sha256(f) });
let title = null;
{
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(drafts, "article.md"), "utf8"));
  if (m) { try { title = (await import("yaml")).parse(m[1]).title ?? null; } catch { /* невалидный фронтматтер — validate уже ругнулся */ } }
}
let telegramMeta = null;
try {
  telegramMeta = JSON.parse(readFileSync(join(drafts, "telegram.json"), "utf8"));
} catch (e) {
  console.error(`telegram.json не читается (${e.message}); прогони tg-check.mjs и повтори.`);
  process.exit(1);
}
const meta = {
  id,
  generated_at: new Date().toISOString(),
  slug: state?.slug ?? null,
  state: state?.state ?? null,
  article_title: title,
  telegram: telegramMeta,
  new_terms: state?.new_terms ?? [],
  files: Object.fromEntries(REQUIRED.map((f) => [f, fileRec(join(drafts, f))])),
  images: Object.fromEntries(
    concepts.map((c) => [
      c,
      Object.fromEntries(
        CONCEPT_FILES.map((f) => {
          const p = join(imagesDir, c, f);
          return [f, f === "prompt.md" ? fileRec(p) : { ...fileRec(p), ...imageInfo(p) }];
        }),
      ),
    ]),
  ),
};
writeFileSync(join(drafts, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");

// ---- review.md: каркас только если его ещё нет (правки агента/владельца не затираем) ----
const reviewPath = join(drafts, "review.md");
if (!existsSync(reviewPath)) {
  const rows = concepts.map((c) => {
    const cell = (f) => {
      const r = meta.images[c][f];
      return r.w ? `${r.w}×${r.h} · ${(r.bytes / 1024).toFixed(0)} КБ` : `${(r.bytes / 1024).toFixed(0)} КБ`;
    };
    return `| ${c} | ${cell("telegram.png")} | ${cell("blog-cover.webp")} | ${cell("blog-preview.webp")} |`;
  });
  writeFileSync(
    reviewPath,
    [
      `# Review: ${id}`,
      "",
      "<!-- Каркас собран package.mjs; секции TODO заполняет агент перед показом владельцу. -->",
      "",
      "## Telegram-заметка",
      `- длина (UTF-16): ${meta.telegram.length} / ${meta.telegram.limit}, target ≤ ${meta.telegram.target} — ${meta.telegram.valid ? "valid" : "НЕVALID"}`,
      "- файл: `telegram.md`",
      "",
      "## Статья",
      `- файл: \`article.md\`; slug: ${meta.slug ?? "(state нет — задай через state.mjs set slug=…)"}`,
      `- заголовок: ${meta.article_title ?? "—"}`,
      "",
      "## Визуальные концепции (по одной строке на концепцию; prompt.md рядом с каждой)",
      "",
      "| Концепция | telegram.png (1:1) | blog-cover.webp (16:9) | blog-preview.webp (16:9) |",
      "|---|---|---|---|",
      ...rows,
      "",
      "## Новые термины",
      "TODO: список новых терминов (или «нет»)",
      "",
      "## Технические риски и открытые вопросы",
      "TODO: …",
      "",
      "## Решение владельца",
      "- [ ] Выбранная концепция: …",
      "- [ ] Правки: …",
      "- [ ] Approval на публикацию: …",
      "",
    ].join("\n"),
  );
}

console.log(`Review package собран: tmp/drafts/${id}/`);
console.log(`  brief.md, article.md, telegram.md (+json), metadata.json, review.md`);
console.log(`  images/brief.md + ${concepts.length} концепции × {prompt.md, telegram.png, blog-cover.webp, blog-preview.webp}`);
console.log(`  Telegram: ${meta.telegram.length}/1024 UTF-16 (target ≤ ${meta.telegram.target})`);
console.log("Дальше: заполнить TODO в review.md и показать пакет владельцу (шаг 12).");
