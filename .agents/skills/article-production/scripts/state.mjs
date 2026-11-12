#!/usr/bin/env node
// Lifecycle статьи. Один canonical state.json на статью:
//   <TMP>/working/<article-id>/state.json     — единственное место состояния (resolver — lib.mjs)
//   <TMP>/drafts/<article-id>/                — материалы (скрипты их не перезаписывают)
//   <TMP>/done/<article-id>/                  — итоговые материалы + derived-снимок metadata.json
//
// Состояния: new → processing → draft → review → approved → publishing → published → done (+ error).
// error → только через restore (возврат в записанное предыдущее состояние).
//
//   state.mjs <id>                                  — показать состояние и историю
//   state.mjs <id> <state> [--note "…"]             — переход (валидация; publishing→published требует telegram_url)
//   state.mjs <id> error --note "…"                 — зафиксировать сбой (материалы не трогаются)
//   state.mjs <id> restore                          — возврат из error в предыдущее состояние
//   state.mjs <id> step <name>                      — отметить шаг чек-листа публикации
//   state.mjs <id> set key=value …                  — slug / article_url / telegram_url / new_terms…
//   state.mjs <id> verify <article|telegram|links>  — HTTP-проверка реальных URL (без выдумывания);
//                                                     links — двусторонняя: статья ⇄ пост
//   state.mjs <id> crosspromo [--text "…"]          — предложение «📖 Подробный разбор — в блоге»
//                                                     для Telegram-поста (после verify article);
//                                                     идемпотентно: существующую ссылку не дублирует
//
// Переход в done: перемещает архив из inbox в done, копирует материалы drafts → done,
// пишет снимок metadata.json (canonical state.json остаётся в working/).
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKLIST, TMP, TRANSITIONS, checkCrossLinks, crossPromoAnchor, crossPromoLine, readState, transition, utf16Length, visibleCaption, writeStateAtomic } from "./lib.mjs";

const [, , id, cmd2, ...rest] = process.argv;
const note = rest.includes("--note") ? rest[rest.indexOf("--note") + 1] : undefined;

if (!id) {
  console.error("usage: state.mjs <id> [state|error|restore|step|set|verify|crosspromo] …");
  process.exit(2);
}

let state;
try {
  state = readState(id);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

async function finishDone(s) {
  const done = join(TMP, "done", s.id);
  mkdirSync(done, { recursive: true });
  const zip = join(TMP, "inbox", `${s.id}.zip`);
  if (existsSync(zip)) renameSync(zip, join(done, `${s.id}.zip`)); // перемещаем, не удаляем
  const drafts = join(TMP, "drafts", s.id);
  if (existsSync(drafts)) cpSync(drafts, join(done, "drafts"), { recursive: true }); // материалы только копируются
  // derived-снимок для удобства; canonical state.json остаётся в working/<id>/
  writeFileSync(join(done, "metadata.json"), JSON.stringify(s, null, 2) + "\n");
}

const TELEGRAM_URL_RE = /^https:\/\/(t\.me|telegram\.me|telegram\.dog)\//;

// ---- show ----
if (!cmd2) {
  console.log(`${state.id}: ${state.state}`);
  const pending = CHECKLIST.filter((k) => !state.checklist?.[k]);
  if (["publishing", "published"].includes(state.state)) console.log(`  чек-лист: ${pending.length ? `осталось [${pending.join(", ")}]` : "все шаги выполнены"}`);
  console.log(`  article_url: ${state.article_url ?? "—"}; telegram_url: ${state.telegram_url ?? "—"}`);
  state.history.forEach((h) => console.log(`  ${h.at}  ${h.from} → ${h.to}${h.note ? `  (${h.note})` : ""}`));
  process.exit(0);
}

try {
  // ---- restore: error → prev_state ----
  if (cmd2 === "restore") {
    if (state.state !== "error") {
      console.error(`restore доступен только из error (сейчас ${state.state}).`);
      process.exit(1);
    }
    const back = state.prev_state ?? "processing";
    state.history.push({ from: "error", to: back, at: new Date().toISOString(), note: note ?? "restore после исправления" });
    state.state = back;
    writeStateAtomic(state);
    console.log(`${id}: error → ${back} (восстановлено). Результаты предыдущих этапов на месте.`);
    process.exit(0);
  }

  // ---- step <name> ----
  if (cmd2 === "step") {
    const name = rest[0];
    if (!CHECKLIST.includes(name)) {
      console.error(`неизвестный шаг «${name}». Допустимо: ${CHECKLIST.join(", ")}`);
      process.exit(2);
    }
    if (!["publishing", "published"].includes(state.state)) {
      console.error(`шаги чек-листа отмечаются в publishing/published (сейчас ${state.state}).`);
      process.exit(1);
    }
    state.checklist[name] = true;
    writeStateAtomic(state);
    console.log(`${id}: ✓ ${name}`);
    process.exit(0);
  }

  // ---- set key=value ----
  if (cmd2 === "set") {
    for (const kv of rest) {
      const [key, ...v] = kv.split("=");
      const value = v.join("=");
      if (!["slug", "article_url", "telegram_url"].includes(key) && !key.startsWith("images.") && !key.startsWith("new_terms")) {
        console.error(`поле «${key}» менять через set нельзя (разрешено: slug, article_url, telegram_url, images.*, new_terms).`);
        process.exit(2);
      }
      if (key === "telegram_url" && value && !TELEGRAM_URL_RE.test(value)) {
        console.error(`«${value}» не похож на пост Telegram (https://t.me/…). Не выдумывай URL.`);
        process.exit(1);
      }
      // URL сменился — подтверждения прежнего URL больше не действительны: снимаем флаги,
      // иначе crosspromo/verify примут новый URL как уже проверенный
      if ((key === "article_url" || key === "telegram_url") && state[key] && state[key] !== value) {
        if (key === "article_url") state.checklist.article_url_verified = false;
        if (key === "telegram_url") state.checklist.telegram_url_verified = false;
        state.checklist.links_checked = false;
        console.log(`${id}: ${key} изменился — проверки article_url_verified/telegram_url_verified/links_checked сброшены.`);
      }
      if (key.startsWith("images.")) state.images[key.slice(7)] = value;
      else if (key.startsWith("new_terms")) state.new_terms = value.split(",").map((s) => s.trim()).filter(Boolean);
      else state[key] = value;
    }
    writeStateAtomic(state);
    console.log(`${id}: ${rest.join(", ")} → сохранено.`);
    process.exit(0);
  }

  // ---- crosspromo: предложение «Telegram → блог» (после публикации и проверки URL статьи) ----
  if (cmd2 === "crosspromo") {
    const customIdx = rest.indexOf("--text");
    const custom = customIdx !== -1 ? rest[customIdx + 1] : undefined;
    if (!state.article_url) {
      console.error(`${id}: article_url не задан — дополнение к посту готовится только после фактической публикации статьи.`);
      process.exit(1);
    }
    if (!state.checklist.article_url_verified) {
      console.error(`${id}: сначала проверь URL статьи: state.mjs ${id} verify article.`);
      process.exit(1);
    }
    const drafts = join(TMP, "drafts", id);
    mkdirSync(drafts, { recursive: true });
    const readIf = (f) => (existsSync(join(drafts, f)) ? readFileSync(join(drafts, f), "utf8") : "");
    const finalText = readIf("telegram-final.md"); // снимок фактически опубликованного поста (если вёлся)
    const draftText = readIf("telegram.md");
    // идемпотентность: ревизуем ОПУБЛИКОВАННЫЙ снимок, если он есть (черновик мог содержать
    // ссылку, которую в пост не вставили), иначе — черновик
    if ((finalText || draftText).includes(state.article_url)) {
      console.log(`${id}: ссылка на статью уже есть в тексте поста (${finalText ? "снимок telegram-final.md" : "черновик telegram.md"}) — дополнение не требуется (дубликаты не добавляем).`);
      process.exit(0);
    }
    // строка дополнения обязана нести ссылку: если в --text её нет — добавляем в конец
    const line = !custom
      ? crossPromoLine(state.article_url)
      : custom.includes(state.article_url)
        ? custom
        : `${custom.trimEnd()} ${state.article_url}`;
    const anchor = line.replaceAll(state.article_url, "").replace(/\s+/g, " ").trim().replace(/[:\s]+$/, "") || crossPromoAnchor;
    const base = visibleCaption((finalText || draftText).trim());
    const withTail = (visible) => (base ? `${base}\n\n${visible}` : visible);
    // длина видимого текста: простой URL считается целиком, URL внутри HTML-ссылки — нет
    const asText = utf16Length(withTail(visibleCaption(line)));
    const asHtml = utf16Length(withTail(anchor));
    const over = (n, limit) => `${n}/${limit}${n > limit ? " ПРЕВЫШЕНА" : ""}`;
    const proposal = [
      `# Cross-Promotion: ${id} (Telegram → блог)`,
      "",
      `- Telegram-пост: ${state.telegram_url ?? "— (появится после публикации/правки поста)"}`,
      `- Статья (URL проверен): ${state.article_url}`,
      "- Ссылка в тексте поста: отсутствует → предложение ниже",
      "",
      "## Предлагаемое дополнение к посту",
      "",
      line,
      "",
      `HTML-вариант (parse_mode=HTML): <a href="${state.article_url}">${anchor}</a>`,
      "",
      "## Длина после добавления (UTF-16, видимый текст)",
      "",
      `- как текст (URL виден): caption ${over(asText, 1024)} · сообщение ${over(asText, 4096)}`,
      `- как HTML-ссылка (URL скрыт): caption ${over(asHtml, 1024)} · сообщение ${over(asHtml, 4096)}`,
      "",
      "## Применение",
      "",
      "- Правка существующего поста — только с approval владельца и правами на редактирование;",
      "  автоматических правок нет. Если правка невозможна — этот файл и есть текст для ручного обновления.",
      "- Новые сообщения вместо правки старых — только по отдельному согласованию.",
      "- Повторный запуск идемпотентен: ссылка уже в telegram(-final).md → команда сообщает и не дублирует.",
      "",
    ].join("\n");
    writeFileSync(join(drafts, "crosspromo.md"), proposal);
    console.log(`${id}: предложение записано в tmp/drafts/${id}/crosspromo.md`);
    if (asText > 1024 && asHtml > 1024 && asText <= 4096 && asHtml <= 4096) {
      console.log(`⚠ caption с медией не влезает (1024) — варианты: текстовое сообщение до 4096 или сократить текст.`);
    }
    if (asText > 4096 && asHtml > 4096) {
      console.error(`${id}: дополнение не влезает даже в текстовое сообщение (4096) — сократи текст поста.`);
      process.exit(1);
    }
    process.exit(0);
  }

  // ---- verify <article|telegram|links> ----
  if (cmd2 === "verify") {
    const what = rest[0];
    const targets = what === "article" ? ["article_url"] : what === "telegram" ? ["telegram_url"] : what === "links" ? ["article_url", "telegram_url"] : null;
    if (!targets) {
      console.error("usage: state.mjs <id> verify <article|telegram|links>");
      process.exit(2);
    }
    const fetchBody = async (key) => {
      const url = state[key];
      if (!url) {
        console.error(`${id}: ${key} не задан. Реальный URL вводит автор после публикации; выдумывать нельзя.`);
        process.exit(1);
      }
      try {
        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          console.error(`${id}: ${key} ${url} → HTTP ${res.status}`);
          process.exit(1);
        }
        console.log(`${id}: ${key} ${url} → HTTP ${res.status} OK`);
        return await res.text();
      } catch (e) {
        console.error(`${id}: ${key} ${url} недоступен (${e.message})`);
        process.exit(1);
      }
    };
    // «Сначала сбросить, потом заработать»: провал перечеки не должен оставлять
    // на диске флаги прежнего успеха — сбрасываем и персистим ДО любых запросов
    const FLAG = { article_url: "article_url_verified", telegram_url: "telegram_url_verified" };
    for (const key of targets) state.checklist[FLAG[key]] = false;
    if (what === "links") state.checklist.links_checked = false;
    writeStateAtomic(state);

    const bodies = {};
    for (const key of targets) bodies[key] = await fetchBody(key);
    if (what === "article") state.checklist.article_url_verified = true;
    if (what === "telegram") state.checklist.telegram_url_verified = true;
    if (what === "links") {
      state.checklist.article_url_verified = true;
      state.checklist.telegram_url_verified = true;
      writeStateAtomic(state); // доступность обоих URL подтверждена — фиксируем до проверки содержимого
      // полнота текста поста: embed-версия содержит сообщение целиком (в og:description оно обрезано)
      try {
        const embed = state.telegram_url + (state.telegram_url.includes("?") ? "&" : "?") + "embed=1&mode=tme";
        const res = await fetch(embed, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
        if (res.ok) bodies.telegram_url += await res.text();
      } catch {
        /* embed недоступен — базовой страницы достаточно для проверки */
      }
      const problems = checkCrossLinks({ articleHtml: bodies.article_url, telegramHtml: bodies.telegram_url, articleUrl: state.article_url, telegramUrl: state.telegram_url });
      if (problems.length) {
        problems.forEach((p) => console.error(`${id}: ${p}`));
        process.exit(1);
      }
      console.log(`${id}: ссылки двусторонние: статья ⇄ пост ✓`);
      state.checklist.links_checked = true;
    }
    writeStateAtomic(state);
    process.exit(0);
  }

  // ---- transition <state> ----
  if (cmd2 === "error" && !note) {
    console.error('error требует --note "причина"');
    process.exit(2);
  }
  if (cmd2 === "published") {
    // published = «всё фактически вышло»: статья + пост; без реального URL поста помечать нельзя
    if (!(TRANSITIONS[state.state] ?? []).includes("published")) {
      console.error(`published достижим только из publishing (сейчас ${state.state}).`);
      process.exit(1);
    }
    if (!state.telegram_url) {
      console.error(`${id}: transition в published требует реальный telegram_url (state.mjs ${id} set telegram_url=https://t.me/…).`);
      process.exit(1);
    }
  }
  if (cmd2 === "done" && (TRANSITIONS[state.state] ?? []).includes("done")) {
    // done = публикация завершена целиком: чек-лист обязан быть закрыт, иначе архив
    // переедет в done/ с недоведёнными ссылками. Невалидные переходы отсекает transition()
    const pending = CHECKLIST.filter((k) => !state.checklist?.[k]);
    if (pending.length) {
      console.error(`${id}: переход в done требует закрытый чек-лист публикации (не выполнено: ${pending.join(", ")}). См. references/workflow.md §3.`);
      process.exit(1);
    }
  }
  transition(state, cmd2, note);
  if (cmd2 === "done") await finishDone(state);
  writeStateAtomic(state);
  console.log(`${id}: → ${state.state}${cmd2 === "done" ? ` (материалы и снимок metadata.json в tmp/done/${id}/)` : ""}`);
  if (cmd2 === "error") console.log("Материалы не тронуты. После исправления: state.mjs restore.");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
