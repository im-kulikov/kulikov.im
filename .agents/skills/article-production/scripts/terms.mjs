#!/usr/bin/env node
// Реестр «секретных букв» (.agents/skills/article-production/data/terms.yml, схема — в шапке файла).
// Реестр персистентный (в Git): обновляется confirm/publish и коммитится вместе со статьёй.
//
//   terms.mjs list [--status published|confirmed|candidate]
//   terms.mjs check <file.md|-> [--registry <file>]   — известные термины/aliases + КАНДИДАТЫ (только на review)
//   terms.mjs confirm <TERM> --definition "..." [--aliases "a,b"] [--registry <file>]
//   terms.mjs publish <TERM> --article <id> [--telegram-url <url>] [--date 2026-11-11] [--registry <file>]
//
// Кандидаты — эвристика ВСЕХ-КАПС токенов: это подсказка автору, НЕ автодобавление.
// Реестр обновляется вручную: confirm → определение утверждено; publish → только после
// фактической публикации. Дубликаты защищены (проверка по term и aliases, без учёта регистра).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { SKILL_DIR } from "./lib.mjs";

const DEFAULT_REGISTRY = join(SKILL_DIR, "data", "terms.yml"); // в Git; песочницы тестов — через --registry

// шумные слова, которые не считаются аббревиатурами (дополняется по мере практики)
const STOPWORDS = new Set([
  "AND", "OR", "NOT", "THE", "FOR", "ALL", "NEW", "YOU", "HOW", "WHY", "WHAT", "WHEN", "WHERE", "WHO",
  "OK", "ID", "NO", "DO", "IF", "IN", "ON", "AT", "TO", "BY", "UP", "ME", "MY", "WE", "GO", "AS", "IS",
  "IT", "BE", "SO", "AN", "OF", "TODO", "NOTE", "PS", "NB", "LLC", "CEO", "FAQ",
]);

const load = (file) => {
  const doc = YAML.parse(readFileSync(file, "utf8"));
  if (!doc || !Array.isArray(doc.terms)) throw new Error(`${file}: ожидается корневой ключ terms: [ … ]`);
  return doc.terms;
};
const save = (file, terms) => writeFileSync(file, YAML.stringify({ terms }, { lineWidth: 120 }) + "\n");

const args = process.argv.slice(2);
// опции со значением (остальные — флаги); позиционные — то, что не съедено опциями
const OPTS_WITH_VALUE = new Set(["registry", "definition", "aliases", "article", "telegram-url", "date", "status"]);
const positional = [];
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    if (OPTS_WITH_VALUE.has(key)) opts[key] = args[++i];
    else opts[key] = true;
  } else positional.push(args[i]);
}
const opt = (n) => opts[n];
const registry = () => resolve(opts.registry ?? DEFAULT_REGISTRY);
const [cmd] = positional;
const termArg = positional[1];
const fileArg = positional[1];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRe = (t) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(t)}(?![\\p{L}\\p{N}])`, "iu");

const exists = (terms, term) => terms.find((t) => t.term.toLowerCase() === term.toLowerCase() || (t.aliases ?? []).some((a) => a.toLowerCase() === term.toLowerCase()));

if (cmd === "list") {
  const terms = load(registry());
  const status = opt("status");
  const shown = status ? terms.filter((t) => t.status === status) : terms;
  console.log(`Реестр: ${terms.length} терминов${status ? `, показано ${shown.length} (${status})` : ""}`);
  shown.forEach((t) =>
    console.log(`  [${t.status}] ${t.term}${(t.aliases ?? []).length ? ` (${t.aliases.join(", ")})` : ""} — ${t.definition ?? "(определения нет)"}`),
  );
  process.exit(0);
}

if (cmd === "check") {
  if (!fileArg) {
    console.error("usage: terms.mjs check <file.md|-> [--registry <file>]");
    process.exit(2);
  }
  const raw = fileArg === "-" ? readFileSync(0, "utf8") : readFileSync(fileArg, "utf8");
  const terms = load(registry());
  const known = [];
  for (const t of terms) {
    const re = termRe(t.term);
    const hits = (raw.match(new RegExp(re.source, "giu")) ?? []).length;
    const aliasHit = (t.aliases ?? []).some((a) => termRe(a).test(raw));
    if (hits || aliasHit) known.push({ term: t.term, status: t.status, hits, alias: aliasHit });
  }
  // эвристика кандидатов: ВСЕ-КАПС токены (латиница/кириллица/цифры/дефис) вне реестра и стоп-слов.
  // (?![\p{Ll}]) отсекает капс-префиксы смешанных слов («MTP» из «MTProto»).
  const tokens = new Set((raw.match(/(?<![\p{L}\p{Nd}])[\p{Lu}][\p{Lu}\p{Nd}-]{1,11}(?![\p{Ll}])/gu) ?? []));
  const candidates = [...tokens]
    .filter((tok) => !STOPWORDS.has(tok) && !exists(terms, tok) && !terms.some((t) => termRe(t.term).test(tok)))
    .sort();
  console.log(JSON.stringify({ known, candidates, note: "candidates — эвристика для review автора, не автодобавление" }, null, 2));
  known.filter((k) => k.status === "published").forEach((k) => console.error(`  ✓ ${k.term} — уже объяснён, определение НЕ повторять`));
  process.exit(0);
}

if (cmd === "confirm") {
  const term = termArg;
  const definition = opt("definition");
  if (!term || !definition) {
    console.error('usage: terms.mjs confirm <TERM> --definition "..." [--aliases "a,b"]');
    process.exit(2);
  }
  const file = registry();
  const terms = load(file);
  if (exists(terms, term)) {
    console.error(`«${term}» уже есть в реестре (term или alias). Дубликаты запрещены.`);
    process.exit(1);
  }
  terms.push({
    term,
    definition,
    aliases: opt("aliases")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
    status: "confirmed",
    first_published_at: null,
    first_article_id: null,
    first_telegram_url: null,
  });
  save(file, terms);
  console.log(`Подтверждено: ${term} (status=confirmed). Опубликуй публикацией: terms.mjs publish ${term} …`);
  process.exit(0);
}

if (cmd === "publish") {
  const term = termArg;
  const article = opt("article");
  if (!term || !article) {
    console.error("usage: terms.mjs publish <TERM> --article <id> [--telegram-url <url>] [--date YYYY-MM-DD]");
    process.exit(2);
  }
  const file = registry();
  const terms = load(file);
  const t = exists(terms, term);
  if (!t) {
    console.error(`«${term}» нет в реестре. Сначала: terms.mjs confirm ${term} --definition "…"`);
    process.exit(1);
  }
  if (t.status === "published") {
    console.error(`«${t.term}» уже опубликован (${t.first_article_id ?? "исторический"}). Повторная публикация запрещена.`);
    process.exit(1);
  }
  const url = opt("telegram-url");
  if (url && !/^https:\/\/(t\.me|telegram\.me|telegram\.dog)\//.test(url)) {
    console.error(`URL «${url}» не похож на пост Telegram (https://t.me/…). Не выдумывай ссылки.`);
    process.exit(1);
  }
  Object.assign(t, {
    status: "published",
    first_published_at: opt("date") ?? new Date().toISOString().slice(0, 10),
    first_article_id: article,
    first_telegram_url: url ?? null,
  });
  save(file, terms);
  console.log(`Опубликовано: ${t.term} (статья ${article}).`);
  process.exit(0);
}

console.error("usage: terms.mjs <list|check|confirm|publish> …");
process.exit(2);
