#!/usr/bin/env node
// Проверка подписи Telegram к изображению: длина ВИДИМОГО текста в UTF-16 code units
// (как считает сам Telegram) после обработки форматирования.
//
// Формат отправки фиксирован в prompts/telegram.md скилла: parse_mode=HTML.
// Подпись хранится в telegram.md (текст с HTML-разметкой), метаданные — в telegram.json.
//
//   node .agents/skills/article-production/scripts/tg-check.mjs tmp/drafts/<id>/telegram.md
//     [--format html|markdownv2|plain] [--limit 1024] [--target 950] [--meta <file>]
//
// stdout: {"format","length","limit","remaining","target","valid"}; exit 1 при превышении.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TMP, utf16Length, visibleCaption } from "./lib.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);

if (!file) {
  console.error("usage: tg-check.mjs <telegram.md|-> [--format html] [--limit 1024] [--target 950] [--meta <file>]");
  process.exit(2);
}

const LIMIT = +opt("limit", 1024);
const TARGET = +opt("target", 950);
const FORMAT = opt("format", ""); // empty = take from meta, fallback html
const metaFile = resolve(opt("meta", file === "-" ? join(TMP, "telegram.json") : join(dirname(resolve(file)), "telegram.json")));

const raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
let meta = {};
try {
  meta = JSON.parse(readFileSync(metaFile, "utf8"));
} catch {
  meta = {};
}
const format = FORMAT || meta.format || "html";
if (!["html", "markdownv2", "plain"].includes(format)) {
  console.error(`неизвестный формат «${format}» (допустимо: html, markdownv2, plain)`);
  process.exit(2);
}

const visible = visibleCaption(raw, format);
const length = utf16Length(visible); // JS-строка — уже UTF-16, суррогатная пара = 2
const remaining = LIMIT - length;
const valid = remaining >= 0;

const result = { format, length, limit: LIMIT, remaining, target: TARGET, valid };
meta = { ...meta, format, limit: LIMIT, target: TARGET, checked_at: new Date().toISOString(), length, remaining, valid };
if (file !== "-") meta.caption_file = file.split("/").slice(-2).join("/");
writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");

console.log(JSON.stringify(result));
if (!valid) {
  console.error(`Превышение лимита на ${-remaining} UTF-16 units. Сократи текст и повтори проверку.`);
  process.exit(1);
}
if (length > TARGET) console.error(`Внимание: ${length} > целевых ${TARGET}. Запас на правки мал, стоит сократить.`);
