#!/usr/bin/env node
// Правка ОПУБЛИКОВАННЫХ постов канала через Bot API (editMessageCaption / editMessageText).
// Дополняет существующий пост строкой (cross-promotion «в блоге»), НЕ переписывая его смысл:
// источником истины служит ЖИВОЙ текст поста (embed-страница t.me), а не сохранённый черновик.
//
//   tg-edit.mjs preview <post-url> --line "📖 Разбор — в блоге: <url>"
//   tg-edit.mjs apply   <post-url> --line "…" --yes            # --yes = явный approval владельца
//
// Токен: env TELEGRAM_BOT_TOKEN, иначе macOS keychain
//   security find-generic-password -a kulikov -s homeinprod-bot -w
// Гейт Approval (правило №6 скилла): apply без --yes ничего не делает — preview всегда бесплатный.
// Идемпотентность: если ссылка уже есть в посте (точное совпадение hasUrl) — «нечего делать», exit 0.
import { visibleCaption, hasUrl } from "./lib.mjs";

// post-url → { chatId, messageId }: t.me/<username>/<id> (публичный канал)
export function parsePostUrl(url) {
  const m = /^https?:\/\/t\.me\/([A-Za-z0-9_]{4,32})\/(\d+)$/.exec(url);
  if (!m) return null;
  return { chatId: `@${m[1]}`, messageId: +m[2] };
}

// Блок текста поста из embed-страницы. Внутри — только инлайн-разметка (без вложенных div),
// поэтому ленивый матч до первого </div> корректен.
export function extractCaptionHtml(embedHtml) {
  const m = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(embedHtml);
  return m ? m[1] : null;
}

// Медиа-пост (фото/видео) → правим caption; чисто текстовый → правим text.
export function isMediaPost(embedHtml) {
  return /tgme_widget_message_(photo|video|roundvideo|videoplayer)/.test(embedHtml);
}

// Нормализация embed-HTML под Bot API parse_mode=HTML:
// - кастомные-emoji обёртки <i class="emoji"…><b>🤖</b></i> → сам символ emoji (обёртки не переводимы)
// - <br/> → <br>
// - посторонние атрибуты убираем: Bot API принимает теги БЕЗ атрибутов, кроме <a href>
//   (embed рендерит ссылки с target/rel/onclick — с ними Bot API ответит 400 can't parse entities)
// - голый «&» внутри href экранируем в &amp; (требование Bot API); именованные/числовые
//   сущности не трогаем. Поддерживаются только &lt; &gt; &amp; &quot; и ВСЕ числовые —
//   именованные вроде &nbsp; Bot API не принимает (в embed их не бывает, только числовые)
export function toBotHtml(captionHtml) {
  return captionHtml
    .replace(/<i class="emoji"[^>]*>([\s\S]*?)<\/i>/g, "$1")
    .replace(/<br\s*\/?>/g, "<br>")
    .replace(/<(\/?)(b|i|u|s)\s[^>]*>/g, "<$1$2>")
    .replace(/<a\s[^>]*?href="([^"]*)"[^>]*>/g, '<a href="$1">')
    .replace(/href="([^"]*)"/g, (m, h) => `href="${h.replace(/&(?!#?[a-zA-Z0-9]+;)/g, "&amp;")}"`);
}

// Экранирование plain-текста дополнения: & < > запрещены голыми в Bot API HTML.
const escapeHtml = (s) => s.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Дополнение → HTML: сначала экранируем (строка — plain text), затем URL делаем кликабельным
// <a> (видимая длина не меняется); «голая» метка kulikov.im/… получает href с https://
// (Telegram требует абсолютный href). Чужие голые домены не линкуются.
export function linkifyLine(line) {
  return escapeHtml(line)
    .replace(/https?:\/\/[^\s<>]+/g, (u) => `<a href="${u}">${u}</a>`)
    .replace(/(?<![\w>/.-])kulikov\.im\/[^\s<>]+/g, (u) => `<a href="https://${u}">${u}</a>`);
}

// Режим --link: вся строка — анкор ссылки, URL живёт только в href.
// Видимая длина не зависит от длины URL (спасает посты у лимита caption).
export function anchorLine(text, url) {
  const href = /^https?:\/\//.test(url) ? url : `https://${url}`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

// URL дополнения для проверки дубля: хвостовую пунктуацию (…URL). — в URL не входит,
// с ней hasUrl не совпал бы и повторный apply вставил бы дубликат.
export function lineUrlOf(line) {
  const strip = (u) => u.replace(/[.,;:!?…)\]]+$/, "");
  return strip(/https?:\/\/[^\s<>]+/.exec(line)?.[0] ?? /(?<![\w>/.-])kulikov\.im\/[^\s<>]+/.exec(line)?.[0] ?? "");
}

// Абзацы поста: нормализованный HTML, разбитый по пустой строке (<br><br>).
export function splitParagraphs(captionHtml) {
  return toBotHtml(captionHtml).split(/<br><br>/);
}

// Сборка итогового HTML из абзацев + дополнения (пустой пост → только дополнение).
// Дополнение ВСЕГДА последний элемент — таково требование к кросс-промо-ссылке.
export function buildEditedHtml(paragraphs, line, link = null) {
  const body = paragraphs.filter((p) => visibleCaption(p, "html").trim() !== "").join("<br><br>");
  const tail = link ? anchorLine(line, link) : linkifyLine(line);
  return body ? `${body}<br><br>${tail}` : tail;
}

// Bot API parse_mode=html НЕ поддерживает <br> («Unsupported start tag "br"», проверено на
// живом канале 2026-11-12): переводы строк передаются обычными символами \n.
// Длину это не меняет — visibleCaption считает <br> и \n одинаково (по одному \n).
export const toApiHtml = (html) => html.replace(/<br>/g, "\n");

// Поабзацный diff (LCS): « » контекст, «-» убрано, «+» добавлено — для preview.
export function diffParagraphs(oldParas, newParas) {
  const n = oldParas.length;
  const m = newParas.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = oldParas[i] === newParas[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldParas[i] === newParas[j]) out.push({ t: " ", s: oldParas[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", s: oldParas[i++] });
    else out.push({ t: "+", s: newParas[j++] });
  }
  while (i < n) out.push({ t: "-", s: oldParas[i++] });
  while (j < m) out.push({ t: "+", s: newParas[j++] });
  return out;
}

// Убирает абзац: последний (--drop-last-paragraph) или по видимому префиксу
// (--drop-paragraph "Правда, обнаружился нюанс:"). Возвращает [оставшиеся абзацы, убранный].
export function dropParagraph(paragraphs, prefix = null) {
  if (prefix === null) return [paragraphs.slice(0, -1), paragraphs.at(-1)];
  const i = paragraphs.findIndex((p) => visibleCaption(p, "html").startsWith(prefix));
  if (i < 0) throw new Error(`абзац с видимым началом «${prefix}» не найден`);
  return [[...paragraphs.slice(0, i), ...paragraphs.slice(i + 1)], paragraphs[i]];
}

// Дубль-контроль: ссылка уже в посте? Проверяем СЫРОЙ HTML caption (не видимый текст):
// в анкор-режиме URL живёт в href и в тексте не виден — проверка по тексту слепа,
// повторный apply продублиров бы строку (поймано на живом канале: пост спас лимит-гейт).
export const alreadyLinked = (captionHtml, url) =>
  hasUrl(toBotHtml(captionHtml), String(url).replace(/^https?:\/\//, ""));

// ── CLI ──────────────────────────────────────────────────────────────────────
const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, postUrl, ...rest] = process.argv;
  // флаг обязан иметь значение сразу после себя; «флаг последним аргументом» ≠ «флага нет»
  const opt = (n) => {
    const i = rest.indexOf(`--${n}`);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`--${n} требует значение сразу после флага.`);
      process.exit(2);
    }
    return v;
  };
  const line = opt("line");
  const dropPrefix = opt("drop-paragraph");
  const linkUrl = opt("link");
  const usage = "usage: tg-edit.mjs <preview|apply> <post-url> --line \"текст\" [--link <url>] [--drop-paragraph \"видимый префикс\" | --drop-last-paragraph] [--yes]\n  без --link: URL внутри строки станет ссылкой; с --link: ВСЯ строка — анкор, URL только в href (короче для лимита)";
  if ((cmd !== "preview" && cmd !== "apply") || !line || !postUrl) {
    console.error(usage);
    process.exit(2);
  }
  if (linkUrl !== undefined && !/^(https?:\/\/|kulikov\.im\/)/.test(linkUrl)) {
    console.error(`--link: «${linkUrl}» не похож на URL (https://… или kulikov.im/…).`);
    process.exit(2);
  }
  if (dropPrefix !== undefined && !dropPrefix.trim()) {
    console.error("--drop-paragraph: префикс не может быть пустым (пустой матчит первый попавшийся абзац).");
    process.exit(2);
  }
  if (dropPrefix !== undefined && rest.includes("--drop-last-paragraph")) {
    console.error("--drop-paragraph и --drop-last-paragraph взаимно исключают друг друга.");
    process.exit(2);
  }
  if (cmd === "apply" && !rest.includes("--yes")) {
    console.error("apply требует --yes: явный approval владельца на правку опубликованного поста.\nСначала покажи diff: tg-edit.mjs preview <post-url> --line \"…\"");
    process.exit(2);
  }
  const target = parsePostUrl(postUrl);
  if (!target) {
    console.error(`«${postUrl}» не похож на пост публичного канала (https://t.me/<username>/<id>).`);
    process.exit(2);
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (cmd === "apply" && !token) {
    console.error("TELEGRAM_BOT_TOKEN не задан (env или keychain-обёртка запускающего).");
    process.exit(2);
  }

  const embedUrl = `${postUrl}${postUrl.includes("?") ? "&" : "?"}embed=1&mode=tme`;
  let embedHtml;
  try {
    const res = await fetch(embedUrl, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    embedHtml = await res.text();
  } catch (e) {
    console.error(`пост недоступен (${embedUrl}): ${e.message}`);
    process.exit(1);
  }
  const captionHtml = extractCaptionHtml(embedHtml);
  if (captionHtml === null) {
    console.error("текстовый блок не найден: пост не существует/удалён либо текста в нём нет.");
    process.exit(1);
  }
  const current = visibleCaption(toBotHtml(captionHtml), "html");
  const lineUrl = linkUrl ?? lineUrlOf(line);
  // дубль-контроль по сырому HTML: ловит и полную ссылку в тексте, и URL в href анкора
  // (кэш t.me может отдать старую страницу — тогда последнюю инстанцию скажет API: «not modified»)
  if (lineUrl && alreadyLinked(captionHtml, lineUrl)) {
    console.log(`${postUrl}: ссылка уже в посте — дополнение не нужно (идемпотентность).`);
    process.exit(0);
  }
  const media = isMediaPost(embedHtml);

  // опциональное удаление абзаца (место под дополнение); убранное показываем владельцу
  let paragraphs = splitParagraphs(captionHtml);
  let dropped = null;
  if (dropPrefix !== undefined || rest.includes("--drop-last-paragraph")) {
    try {
      [paragraphs, dropped] = dropParagraph(paragraphs, dropPrefix);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
  const editedHtml = buildEditedHtml(paragraphs, line, linkUrl);
  const edited = visibleCaption(editedHtml, "html");
  const limit = media ? 1024 : 4096; // UTF-16, как считает Telegram
  const len = edited.length;
  console.log(`пост ${postUrl} (${media ? "медиа: правка caption" : "текст: правка text"})`);
  console.log(`длина: ${current.length} → ${len} UTF-16 (лимит ${limit}${len > limit ? " — ПРЕВЫШЕН" : ""})`);
  // diff по абзацам: владелец видит, что именно изменится, а не весь пост целиком
  const oldVis = splitParagraphs(captionHtml).map((p) => visibleCaption(p, "html"));
  const newVis = edited.split("\n\n");
  for (const d of diffParagraphs(oldVis, newVis)) console.log(`${d.t} ${d.s.replace(/\n/g, "\n  ")}`);
  console.log(`добавляемый фрагмент (последний элемент): ${JSON.stringify(toApiHtml(buildEditedHtml([], line, linkUrl)))}`);
  if (len > limit) {
    console.error("лимит превышен: сократи строку-анкор или убери второстепенный абзац (--drop-paragraph).");
    process.exit(1);
  }
  if (cmd === "preview") {
    console.log("preview: ничего не отправлено. Применение: tg-edit.mjs apply <post-url> --line \"…\" [--link <url>] --yes");
    process.exit(0);
  }

  const api = media ? "editMessageCaption" : "editMessageText";
  const body = {
    chat_id: target.chatId,
    message_id: target.messageId,
    parse_mode: "html",
    [media ? "caption" : "text"]: toApiHtml(editedHtml), // <br> → \n: Bot API HTML не знает <br>
  };
  let resp;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${api}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    resp = await r.json();
  } catch (e) {
    console.error(`Bot API ${api} недоступен: ${e.message}`);
    process.exit(1);
  }
  if (!resp.ok) {
    // «message is not modified» = контент уже идентичен: правка применена РАНЬШЕ.
    // Это авторитетная идемпотентность: локальная проверка по embed может не увидеть
    // свежую правку из-за кэша t.me, а API сравнивает фактическое содержимое.
    if (/not modified/i.test(resp.description ?? "")) {
      console.log(`✓ пост ${target.chatId}/${target.messageId}: правка уже применена (контент идентичен).`);
      process.exit(0);
    }
    console.error(`Bot API ${api} отклонил правку: ${resp.error_code} ${resp.description}`);
    process.exit(1);
  }
  console.log(`✓ пост ${target.chatId}/${target.messageId} обновлён (${api}); проверь: ${postUrl}`);
}
