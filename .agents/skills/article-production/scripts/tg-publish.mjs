#!/usr/bin/env node
// Публикация нового поста в Telegram-канал: sendPhoto через Bot API (Node fetch, БЕЗ curl).
//
//   tg-publish.mjs preview <image.png> <caption.md> [--chat @homeinprod]
//   tg-publish.mjs publish <image.png> <caption.md> [--chat @homeinprod] --yes
//
// Токен: env TELEGRAM_BOT_TOKEN (как в tg-edit.mjs). --api — базовый URL для тестов
// (по умолчанию https://api.telegram.org).
//
// Уроки инцидента 2026-11-17 (посты №18/№19 ушли БЕЗ подписи при ok:true):
// 1) curl -F "name=@value" трактуется как ФАЙЛ (chat_id=@homeinprod = ошибка 26;
//    caption=@file в песочнице мог прочесть пустой файл — молча пустое поле).
//    Публикация — только Node fetch + FormData, строковые поля через set(), не shell.
// 2) env-prefix `VAR=$(cat f) cmd --arg "$VAR"` не работает: расширение ДО присваивания.
// 3) ГЛАВНОЕ: ok:true ≠ пост корректен. Ответ sendPhoto обязан содержать result.caption,
//    равный ожидаемому видимому тексту (UTF-16); иначе — deleteMessage и отказ.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { utf16Length, visibleCaption } from "./lib.mjs";

const DEFAULT_API = "https://api.telegram.org";
const CAPTION_LIMIT = 1024;

export const pngMagic = (buf) =>
  buf.length > 8 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG";

// Единственная истина о том, что бот ОТПРАВИЛ — ответ API. Проверяем caption ПО СОДЕРЖАНИЮ:
// должен существовать и совпасть видимым текстом с ожидаемым. Эхо приходит как
// разобранный текст + caption_entities (без разметки), но могло бы прийти и с разметкой —
// принимаем оба вида; голая длина недостаточна (та же длина ≠ та же подпись).
export function verifySendResponse(json, expectedVisibleText) {
  if (!json || json.ok !== true || !json.result) {
    const d = json && json.description ? json.description : "нет result";
    return { ok: false, message_id: null, reason: `API вернул ошибку: ${d}` };
  }
  const id = json.result.message_id ?? null;
  const cap = json.result.caption;
  if (typeof cap !== "string" || cap.length === 0) {
    return {
      ok: false,
      message_id: id,
      reason: "пост ушёл БЕЗ подписи (result.caption отсутствует) — инцидент 2026-11-17, пост удаляется",
    };
  }
  const asMarkup = visibleCaption(cap, "html"); // эхо с разметкой → снять её
  if (asMarkup !== expectedVisibleText && cap !== expectedVisibleText) {
    return {
      ok: false,
      message_id: id,
      reason: "подпись в ответе не совпала с ожидаемым текстом — пост удаляется",
    };
  }
  return { ok: true, message_id: id, reason: "" };
}

// Ответ потерян/не-JSON (прокси 502, обрыв): факт публикации НЕИЗВЕСТЕН, message_id
// недоступен — удалять нечего, требуется ручная проверка канала (getUpdates/вкладка).
export class ApiStateUnknownError extends Error {}

const apiCall = async (api, token, method, formData) => {
  let res;
  try {
    res = await fetch(`${api}/bot${token}/${method}`, { method: "POST", body: formData });
  } catch (e) {
    throw new ApiStateUnknownError(`сеть не ответила (${e.message})`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiStateUnknownError(`не-JSON ответ (HTTP ${res.status}) — возможно, прокси/Cloudflare`);
  }
};

export async function sendPhoto({ api, token, chat, photoPath, caption }) {
  const photo = readFileSync(resolve(photoPath));
  const fd = new FormData();
  fd.set("chat_id", chat); // строки — set(): никаких @-файлов
  fd.set("parse_mode", "HTML");
  fd.set("caption", caption);
  fd.set("photo", new Blob([photo], { type: "image/png" }), "photo.png");
  return apiCall(api, token, "sendPhoto", fd);
}

export async function deleteMessage({ api, token, chat, message_id }) {
  const fd = new FormData();
  fd.set("chat_id", chat);
  fd.set("message_id", String(message_id));
  return apiCall(api, token, "deleteMessage", fd);
}

// Ошибки входа — исключение (не process.exit): main() вызывается и тестами,
// где exit убил бы раннер. CLI-обёртка внизу превращает её в код 2.
export class UsageError extends Error {}

const usage = (msg) => {
  throw new UsageError(`usage: tg-publish.mjs <preview|publish> <image.png> <caption.md> [--chat @homeinprod] [--yes] [--api <url>]\n${msg}`);
};

export async function main(argv) {
  try {
    const args = argv.slice(2);
    const [cmd, image, captionFile] = args.filter((a) => !a.startsWith("--"));
    const opt = (name) => {
      const i = args.indexOf(name);
      const eq = args.find((a) => a.startsWith(`${name}=`));
      if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
      if (eq) return eq.slice(name.length + 1);
      if (i !== -1) usage(`${name} указан без значения — канал по умолчанию не подставляется молча`);
      return undefined;
    };
    const chat = opt("--chat") ?? "@homeinprod";
    const yes = args.includes("--yes");
    const api = opt("--api") ?? DEFAULT_API;
    if (!cmd || !image || !captionFile || !["preview", "publish"].includes(cmd)) {
      usage("нужны подкоманда preview|publish, изображение и файл подписи");
    }
    const raw = readFileSync(resolve(captionFile), "utf8");
    const expectedText = visibleCaption(raw, "html");
    const expected = utf16Length(expectedText);
    if (expected > CAPTION_LIMIT) {
      usage(`видимая длина подписи ${expected} > ${CAPTION_LIMIT} UTF-16 — сократить текст`);
    }
    const photo = readFileSync(resolve(image));
    if (!pngMagic(photo)) usage("изображение обязано быть PNG по magic bytes");

    console.log(JSON.stringify({ image: resolve(image), caption: resolve(captionFile), visible_length: expected, limit: CAPTION_LIMIT, chat }));
    if (cmd === "preview") {
      console.log("preview: сеть не трогали. Публикация: tg-publish.mjs publish … --yes");
      return 0;
    }

    if (!yes) usage("публикация требует явного --yes (approval владельца)");
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) usage("нет TELEGRAM_BOT_TOKEN в окружении");

    let sent;
    try {
      sent = await sendPhoto({ api, token, chat, photoPath: image, caption: raw });
    } catch (e) {
      if (e instanceof ApiStateUnknownError) {
        console.error(`✗ ${e.message} — состояние публикации НЕИЗВЕСТНО (message_id недоступен). Проверьте канал вручную (t.me/<канал>, getUpdates) — при наличии поста без подписи удалите его.`);
        return 1;
      }
      throw e;
    }
    const verdict = verifySendResponse(sent, expectedText);
    if (verdict.ok) {
      console.log(`опубликовано: message_id=${verdict.message_id}, подпись (${expected}/${CAPTION_LIMIT} UTF-16) подтверждена из ответа API`);
      console.log(`URL поста: https://t.me/${chat.replace(/^@/, "")}/${verdict.message_id}`);
      return 0;
    }
    console.error(`✗ ${verdict.reason}`);
    if (verdict.message_id != null) {
      try {
        const del = await deleteMessage({ api, token, chat, message_id: verdict.message_id });
        console.error(del.ok ? `✗ битый пост ${verdict.message_id} удалён` : `✗ НЕ удалось удалить пост ${verdict.message_id} — удалить вручную!`);
      } catch (e) {
        console.error(`✗ удаление не удалось (${e.message}) — удалить пост ${verdict.message_id} вручную!`);
      }
    }
    return 1;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

// dual-use guard (урок PR #31: импорт CLI-скрипта не должен выполнять argv-диспетчер)
const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code), (e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
