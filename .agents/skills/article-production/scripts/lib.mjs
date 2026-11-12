// Shared library for the article-production skill scripts (no CLI of its own).
// Постоянная часть скилла живёт здесь (в Git), материалы конкретных публикаций — в tmp/ (вне Git).
// The workspace root is overridable with EDITORIAL_TMP so tests can run in a sandbox.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SKILL_DIR = resolve(import.meta.dirname, ".."); // …/.agents/skills/article-production
export const REPO_ROOT = resolve(SKILL_DIR, "..", "..", "..");
// Per-publication workspace: inbox/, working/, drafts/, done/. Никаких промптов/скриптов/реестров.
export const TMP = process.env.EDITORIAL_TMP || join(REPO_ROOT, "tmp");

// ---------- canonical state ----------
// One canonical state.json per article, always at <TMP>/working/<article-id>/state.json.
// drafts/ and done/ hold materials; done/<id>/metadata.json is a derived read-only snapshot.
export const statePath = (id) => join(TMP, "working", id, "state.json");
export const validId = (id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);

export const STATES = ["new", "processing", "draft", "review", "approved", "publishing", "published", "done", "error"];
export const TRANSITIONS = {
  new: ["processing"],
  processing: ["draft", "error"],
  draft: ["review", "error"],
  review: ["draft", "approved", "error"],
  approved: ["publishing", "review", "error"],
  publishing: ["published", "error"],
  published: ["done", "error"],
  done: [],
  error: [], // error is left only via `restore` (returns to the recorded previous state)
};

// sub-steps of the publishing flow (order matters; recorded in state.checklist)
export const CHECKLIST = ["article_published", "article_url_verified", "telegram_published", "telegram_url_verified", "site_redeployed", "links_checked"];
export const newChecklist = () => Object.fromEntries(CHECKLIST.map((k) => [k, false]));

export function newState(id, archiveSha256 = null) {
  return {
    id,
    state: "new",
    slug: null,
    archive_sha256: archiveSha256,
    article_url: null,
    telegram_url: null,
    images: { telegram: null, cover: null },
    new_terms: [],
    checklist: newChecklist(),
    history: [],
  };
}

export function readState(id) {
  if (!validId(id)) throw new Error(`недопустимый article-id «${id}» (паттерн: ^[a-z0-9][a-z0-9-]{0,63}$)`);
  const file = statePath(id);
  if (!existsSync(file)) throw new Error(`state.json для «${id}» не найден: ${file}`);
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`state.json «${id}» повреждён (${e.message}); восстанови из истории вручную`);
  }
  for (const key of ["id", "state", "checklist", "history"]) {
    if (!(key in state)) throw new Error(`state.json «${id}»: отсутствует обязательное поле «${key}»`);
  }
  if (!STATES.includes(state.state)) throw new Error(`state.json «${id}»: неизвестное состояние «${state.state}»`);
  return state;
}

// atomic metadata write: temp file in the same directory + rename
export function writeStateAtomic(state) {
  const file = statePath(state.id);
  mkdirSync(join(TMP, "working", state.id), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, file);
}

export function transition(state, to, note = undefined) {
  if (!STATES.includes(to)) throw new Error(`неизвестное состояние «${to}». Допустимо: ${STATES.join(", ")}`);
  if (state.state === to) return state; // idempotent no-op
  const allowed = TRANSITIONS[state.state] ?? [];
  if (!allowed.includes(to)) throw new Error(`переход ${state.state} → ${to} не разрешён. Из ${state.state}: [${allowed.join(", ") || "только restore"}]`);
  state.history.push({ from: state.state, to, at: new Date().toISOString(), note, prev_state: state.state === "error" ? state.prev_state : undefined });
  state.state = to;
  if (to === "error") state.prev_state = state.history.at(-2)?.to ?? state.history[0]?.from ?? "processing";
  return state;
}

// ---------- Telegram caption ----------
// JS strings are UTF-16: .length already counts code units (a surrogate pair = 2), like Telegram.
export const utf16Length = (s) => s.length;

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

// Visible caption text after formatting is applied (what Telegram actually counts):
// tags, link URLs and markup are not counted; the inner text, emoji and newlines are.
export function visibleCaption(raw, format = "html") {
  let text = raw.replace(/<!--.*?-->/gs, ""); // service comments never go to the client
  if (format === "html") {
    text = text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li)>/gi, "\n")
      .replace(/<[^>]*>/g, "");
    // сущности — одним проходом: именованные из таблицы, числовые/hex декодируются в символ
    // (суррогатная пара честно занимает 2 UTF-16 unit при .length), незнакомые остаются как есть.
    // Последовательные замены запрещены: «&amp;lt;» не должно превращаться в «<» двойным декодом
    text = text.replace(/&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (ent) => {
      if (ENTITIES[ent] !== undefined) return ENTITIES[ent];
      const code = /^&#x/i.test(ent) ? parseInt(ent.slice(3, -1), 16) : /^&#/.test(ent) ? parseInt(ent.slice(2, -1), 10) : NaN;
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ent;
    });
  } else if (format === "markdownv2") {
    // Один проход альтернатив: содержимое кода (```фенсы``` и `спаны`) литерально —
    // Telegram считает его посимвольно (внутри кода нет ни разметки, ни эскейпов),
    // поэтому оно матчится АТОМОМ раньше срезания разметки и возвращается без маркеров.
    // Последовательные replace'ы срезали бы литеральные «_»/«*»/«\.» внутри кода — недосчёт.
    text = text.replace(
      /```[\s\S]*?```|`[^`\n]*`|\[[^\]]*\]\([^)]*\)|[*_~]{1,2}|\\([^\w\s])/g,
      (m, esc) => {
        if (m.startsWith("```")) return m.slice(3, -3);
        if (m.startsWith("`")) return m.slice(1, -1);
        if (m.startsWith("[")) return m.slice(1, m.indexOf("]("));
        if (esc !== undefined) return esc; // эскейп \. → виден сам символ
        return ""; // * _ ~ — маркеры разметки
      },
    );
  }
  // внутренние переносы НЕ схлопываем: Telegram считает их как есть, нормализация занижала бы длину
  return text.trim();
}

// ---------- cross-promotion (Telegram ↔ blog) ----------
// Стандартное дополнение к Telegram-посту после публикации и проверки URL статьи.
// Формулировку можно адаптировать под пост (state.mjs <id> crosspromo --text "…").
export const crossPromoLine = (articleUrl) => `📖 Подробный разбор — в блоге: ${articleUrl}`;
export const crossPromoAnchor = "📖 Подробный разбор — в блоге";

// Точное совпадение ссылки: substring-проверка принимала пост /50 за /5 (префикс).
// Сразу за URL не может стоять символ, меняющий адрес: ЛЮБАЯ буква/цифра (включая
// кириллицу — \w в JS ASCII-only, без флага u кириллица «пряталась» за URL) или
// «/» (другой путь). Query (?utm=…) и фрагмент (#anchor) адрес не меняют —
// это ссылки на тот же адрес, их принимаем.
export const hasUrl = (haystack, url) => {
  if (!haystack || !url) return false;
  return new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}/-])`, "u").test(haystack);
};

// Двусторонняя проверка ссылок по телам уже загруженных страниц:
// статья содержит ссылку на пост («Обсудить в Telegram»), пост — ссылку на статью.
// Пустое тело = ссылки нет (HTTP 200 с пустым ответом — не доказательство).
// Возвращает список человекочитаемых проблем (пусто = всё на месте).
export function checkCrossLinks({ articleHtml, telegramHtml, articleUrl, telegramUrl }) {
  const problems = [];
  if (telegramUrl && !hasUrl(articleHtml, telegramUrl)) {
    problems.push(`на странице статьи нет ссылки на Telegram-пост (${telegramUrl}); обнови front matter telegram: и передеплой`);
  }
  if (articleUrl && !hasUrl(telegramHtml, articleUrl)) {
    problems.push(`в Telegram-посте нет ссылки на статью (${articleUrl}); примени дополнение из crosspromo (с approval владельца)`);
  }
  return problems;
}
