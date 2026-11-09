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
    for (const [ent, ch] of Object.entries(ENTITIES)) text = text.split(ent).join(ch);
    text = text.replace(/&#\d+;/g, "?");
  } else if (format === "markdownv2") {
    text = text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""))
      .replace(/[*_~]{1,2}/g, "")
      .replace(/\\([^\w\s])/g, "$1"); // escaped punctuation \. → .
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- cross-promotion (Telegram ↔ blog) ----------
// Стандартное дополнение к Telegram-посту после публикации и проверки URL статьи.
// Формулировку можно адаптировать под пост (state.mjs <id> crosspromo --text "…").
export const crossPromoLine = (articleUrl) => `📖 Подробный разбор — в блоге: ${articleUrl}`;
export const crossPromoAnchor = "📖 Подробный разбор — в блоге";

// Двусторонняя проверка ссылок по телам уже загруженных страниц:
// статья содержит ссылку на пост («Обсудить в Telegram»), пост — ссылку на статью.
// Возвращает список человекочитаемых проблем (пусто = всё на месте).
export function checkCrossLinks({ articleHtml, telegramHtml, articleUrl, telegramUrl }) {
  const problems = [];
  if (telegramUrl && articleHtml && !articleHtml.includes(telegramUrl)) {
    problems.push(`на странице статьи нет ссылки на Telegram-пост (${telegramUrl}); обнови front matter telegram: и передеплой`);
  }
  if (articleUrl && telegramHtml && !telegramHtml.includes(articleUrl)) {
    problems.push(`в Telegram-посте нет ссылки на статью (${articleUrl}); примени дополнение из crosspromo (с approval владельца)`);
  }
  return problems;
}
