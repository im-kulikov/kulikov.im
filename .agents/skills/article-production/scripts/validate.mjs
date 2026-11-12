#!/usr/bin/env node
// Пре-review гейт (шаг 11 конвейера): проверяет материалы tmp/drafts/<id>/ перед сборкой
// review package. Ничего не публикует; единственная запись — telegram.json (её делает tg-check).
//
//   node .agents/skills/article-production/scripts/validate.mjs <id>
//
// Проверки: brief.md (шаблон Article Brief) · article.md (front matter, draft, без mock)
// telegram.md (tg-check, UTF-16) · термины (кандидаты должны быть разрешены) ·
// secrets (high блокируют; warn — на усмотрение review) · images (если уже сгенерированы).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { TMP, validId } from "./lib.mjs";
import { checkImages } from "./images.mjs";

const id = process.argv[2];
if (!id || !validId(id)) {
  console.error("usage: validate.mjs <article-id>");
  process.exit(2);
}
const drafts = join(TMP, "drafts", id);
if (!existsSync(drafts)) {
  console.error(`нет каталога ${drafts}`);
  process.exit(1);
}

const results = [];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const add = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const run = (script, args, input) =>
  spawnSync(process.execPath, [join(import.meta.dirname, script), ...args], { encoding: "utf8", input, env: process.env });

// ---- 1. brief.md: разделы Article Brief ----
const BRIEF_HEADINGS = ["Тема", "Контекст", "Ключевые факты", "Проблема", "Результат", "Аудитория", "Заголовок", "Краткое описание", "Визуальные объекты", "Ограничения и неопределённости"];
const briefPath = join(drafts, "brief.md");
if (!existsSync(briefPath)) add("brief.md", false, "файл отсутствует (шаг 5 конвейера)");
else {
  const text = readFileSync(briefPath, "utf8");
  const missing = BRIEF_HEADINGS.filter((h) => !new RegExp(`^##\\s+${escRe(h)}\\s*$`, "m").test(text));
  add("brief.md: разделы Article Brief", missing.length === 0, missing.length ? `нет: ${missing.join(", ")}` : undefined);
}

// ---- 2. article.md: front matter ----
let body = "";
const articlePath = join(drafts, "article.md");
let fm = null;
if (!existsSync(articlePath)) add("article.md", false, "файл отсутствует");
else {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(readFileSync(articlePath, "utf8"));
  if (!m) add("article.md: front matter", false, "блок «--- … ---» не найден");
  else {
    body = m[2];
    try {
      fm = YAML.parse(m[1]);
    } catch (e) {
      add("article.md: front matter", false, `YAML не разбирается: ${e.message}`);
    }
  }
}
// блок «--- … ---» есть, но YAML пуст или не отображение: молча пропустить проверки —
// значит пропустить статью без title/slug/draft через гейт
if (fm === null || typeof fm !== "object" || Array.isArray(fm)) {
  add("article.md: front matter", false, "блок найден, но не является YAML-отображением (пустой или сломанный)");
}
if (fm) {
  const req = ["title", "description", "date", "tags", "slug", "draft", "image"];
  const miss = req.filter((k) => !(k in fm));
  add("article.md: обязательные ключи", miss.length === 0, miss.length ? `отсутствуют: ${miss.join(", ")}` : undefined);
  if (!miss.length) {
    add("article.md: title ≤ 60 симв.", String(fm.title).length <= 60, `${String(fm.title).length} симв.`);
    const d = String(fm.description).trim();
    add("article.md: description 50–200 симв.", d.length >= 50 && d.length <= 200, `${d.length} симв.`);
    add("article.md: draft: true до approval", fm.draft === true, fm.draft === true ? undefined : `draft: ${JSON.stringify(fm.draft)}`);
    add("article.md: без mock", fm.mock === undefined, fm.mock === undefined ? undefined : "mock — только для демо-статей мокапа");
    add("article.md: telegram не заполнен", !fm.telegram, fm.telegram ? "URL появляется только после реального поста" : undefined);
  }
  // источники: только через shortcode — заголовок «## Источники» вне контракта поиска
  // (внутри {{< sources >}} секция видна читателю, но исключена из searchindex сайта)
  const sourcesShortcode = /\{\{<\s*sources[^>]*>[\s\S]*\{\{<\s*\/sources\s*>}}/.test(body);
  // кодовые блоки не считаются (упоминание заголовка в примере — не заголовок);
  // NB: \b после кириллицы в JS-regex не работает (ASCII-граница) — поэтому явный lookahead
  const bodyNoFences = body.replace(/```[\s\S]*?```/g, "");
  const legacySourcesHeading = /^#{2,}\s*\**\s*Источники(?=\s|[:;,.)\]}»*]*\s*$).*$/m.test(bodyNoFences);
  add(
    "article.md: источники через {{< sources >}}",
    !legacySourcesHeading,
    legacySourcesHeading
      ? "заголовок ## Источники вне контракта поиска — оберни список в shortcode {{< sources >}}…{{< /sources >}}"
      : sourcesShortcode
        ? undefined
        : "источников нет — ок",
  );
}

// ---- 3. telegram.md: видимая длина UTF-16 ----
const tgPath = join(drafts, "telegram.md");
if (!existsSync(tgPath)) add("telegram.md + tg-check", false, "файл отсутствует");
else {
  const r = run("tg-check.mjs", [tgPath]);
  let j = null;
  try { j = JSON.parse((r.stdout ?? "").trim().split("\n")[0]); } catch { /* вывод не разобран */ }
  add("telegram.md: tg-check (≤ 1024 UTF-16)", r.status === 0 && j?.valid === true, j ? `${j.length}/1024, target ≤ ${j.target}` : (r.stderr ?? "").split("\n")[0]);
}

// ---- 4. термины: кандидаты должны быть разрешены (confirm или убрать из текста) ----
const known = [];
const candidates = new Set();
let registryFailed = false;
for (const [label, text] of [["article", body], ["telegram", existsSync(tgPath) ? readFileSync(tgPath, "utf8") : ""]]) {
  if (!text.trim()) continue;
  const r = run("terms.mjs", ["check", "-"], text); // текст — на stdin, не argv
  if (r.status !== 0) {
    registryFailed = true; // недоступный/битый реестр — не «ноль кандидатов», а упавшая проверка
    continue;
  }
  try {
    const j = JSON.parse(r.stdout);
    j.known?.forEach((k) => known.push(`${k.term}(${k.status})`));
    j.candidates?.forEach((c) => candidates.add(c));
  } catch {
    registryFailed = true;
  }
}
add(
  "термины: кандидаты разрешены",
  candidates.size === 0 && !registryFailed,
  registryFailed
    ? "реестр терминов недоступен или повреждён (terms.mjs check упал) — проверка не выполнена"
    : candidates.size
      ? `подтверди (terms.mjs confirm) или убери: ${[...candidates].join(", ")}`
      : known.length
        ? `известные: ${[...new Set(known)].join(", ")}`
        : "новых капс-терминов нет",
);

// ---- 5. secrets: high блокируют ----
const sec = run("secrets-check.mjs", [drafts]);
const secSum = /Итог: high=(\d+), warn=(\d+)/.exec(sec.stderr ?? "");
add("secrets: high = 0", sec.status === 0, secSum ? `high=${secSum[1]}, warn=${secSum[2]} (warn — разобрать на review)` : (sec.stderr ?? "").trim().split("\n").at(-1));

// ---- 6. images (когда уже сгенерированы — шаг 9-10) ----
const imagesDir = join(drafts, "images");
if (existsSync(imagesDir)) {
  const res = checkImages(imagesDir);
  add("images: форматы/пропорции/бюджеты", res.ok, res.ok ? `${Object.keys(res.concepts).length} концепции ✓` : res.problems.join("; "));
} else {
  add("images", true, "каталога ещё нет — генерация на шаге 9 ($imagegen)");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `✗ не прошло проверок: ${failed.length}` : "✓ все проверки пройдены"}`);
process.exit(failed.length ? 1 : 0);
