#!/usr/bin/env node
// Детерминированная обработка изображений: размеры, ресайз/кроп → WebP, бюджеты концепций.
// НЕ генерирует изображения: генерация — действие агента через встроенный skill $imagegen
// (см. SKILL.md); этот скрипт только обрабатывает и проверяет уже существующие файлы.
//
//   images.mjs info <file…>                                 — тип, размеры, вес
//   images.mjs convert <src> <width> [--quality 85] [--out] — ресайз по ширине (пропорции) → WebP
//   images.mjs crop <src> <WxH> [--quality 85] [--out]      — center-crop до точных W×H → WebP
//   images.mjs check <images-dir> [--json]                  — форматы/размеры/бюджеты concept-*/
//
// convert/crop используют Chrome (OffscreenCanvas): системный sips в этом окружении сломан
// (exit 13). Бюджеты сайта: webp ≤ 150 КБ каждый (тесты images.test.mjs); покрывает и og ≤ 300 КБ.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

// ---------- размеры без внешних зависимостей (PNG + WebP: VP8X/VP8/VP8L) ----------
export function imageInfo(file) {
  const b = readFileSync(file).subarray(0, 64);
  if (b.length < 32) throw new Error("файл слишком мал, чтобы быть изображением");
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; // IHDR
  }
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { type: "webp", w, h };
    }
    if (chunk === "VP8 ") {
      return { type: "webp", w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const v = b.readUInt32LE(21);
      return { type: "webp", w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
    throw new Error("WebP без известного чанка (VP8X/VP8/VP8L)");
  }
  throw new Error(`не PNG и не WebP (${extname(file) || "без расширения"}); для генерации используй $imagegen`);
}

const KB = 1024;
const LIMITS = {
  telegram: { maxBytes: 5 * KB * KB, label: "5 МБ (фото Telegram)", ar: 3 / 2, arLabel: "3:2" },
  webp: { maxBytes: 150 * KB, label: "150 КБ (бюджет сайта, tests/images.test.mjs)" },
  coverMinW: 1280,
  previewW: [720, 880],
};
// Требуемый формат по имени файла: imageInfo читает тип по magic bytes, и без этой
// сверки PNG, переименованный в blog-cover.webp, проходил бы гейты (переименование ≠ конвертация).
const REQUIRED_TYPE = { "telegram.png": "png", "blog-cover.webp": "webp", "blog-preview.webp": "webp" };
// Допуск на отклонение пропорций (последние ~2% — артефакты округления пикселей, не «другой формат»)
const AR_TOL = 0.02;

// ---------- проверка images/concept-*/ (шаг 10) ----------
export function checkImages(dir) {
  const problems = [];
  const concepts = {};
  if (!existsSync(dir)) return { ok: false, problems: [`каталог не найден: ${dir}`], concepts };
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^concept-\d+$/.test(d.name))
    .map((d) => d.name)
    .sort();
  if (dirs.length !== 3) problems.push(`концепций ${dirs.length}, ожидается 3 (concept-01…03)`);
  let webpSum = 0;
  for (const c of dirs) {
    concepts[c] = {};
    for (const name of ["telegram.png", "blog-cover.webp", "blog-preview.webp"]) {
      const f = join(dir, c, name);
      if (!existsSync(f)) {
        problems.push(`${c}/${name}: отсутствует (заглушки вместо изображений запрещены)`);
        continue;
      }
      const bytes = statSync(f).size;
      const rec = { bytes };
      try {
        Object.assign(rec, imageInfo(f));
      } catch (e) {
        problems.push(`${c}/${name}: ${e.message}`);
        concepts[c][name] = rec;
        continue;
      }
      concepts[c][name] = rec;
      if (rec.type !== REQUIRED_TYPE[name]) problems.push(`${c}/${name}: содержимое — ${rec.type}, а требуется ${REQUIRED_TYPE[name]} (переименование файла не конвертирует его)`);
      if (name === "telegram.png") {
        // 3:2 (например 1200×800) — единый формат ленты канала; квадрат БЫЛ формально
        // «проходным», пока кроп из широких сцен не резал композицию (инцидент поста №16)
        if (Math.abs(rec.w / rec.h - LIMITS.telegram.ar) > AR_TOL)
          problems.push(`${c}/telegram.png: ${rec.w}×${rec.h} — не 3:2 (цель 1200×800); НЕ кропить чужую композицию — генерируй/адаптируй под 3:2`);
        if (bytes > LIMITS.telegram.maxBytes) problems.push(`${c}/telegram.png: ${(bytes / KB / KB).toFixed(1)} МБ > ${LIMITS.telegram.label}`);
      } else {
        webpSum += bytes;
        if (Math.abs(rec.w / rec.h - 16 / 9) > 0.02) problems.push(`${c}/${name}: ${rec.w}×${rec.h} — не 16:9`);
        if (bytes > LIMITS.webp.maxBytes) problems.push(`${c}/${name}: ${(bytes / KB).toFixed(0)} КБ > ${LIMITS.webp.label}`);
        if (name === "blog-cover.webp" && rec.w < LIMITS.coverMinW) problems.push(`${c}/blog-cover.webp: ширина ${rec.w} < ${LIMITS.coverMinW}`);
        if (name === "blog-preview.webp" && (rec.w < LIMITS.previewW[0] || rec.w > LIMITS.previewW[1]))
          problems.push(`${c}/blog-preview.webp: ширина ${rec.w} вне ${LIMITS.previewW.join("–")} (карточка списка)`);
      }
    }
  }
  return { ok: problems.length === 0, problems, concepts, webpSum };
}

// ---------- convert/crop через Chrome canvas ----------
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
async function toWebp(src, mode, quality, out) {
  const { chromium } = await import("playwright-core");
  const mime = MIME[extname(src).toLowerCase()];
  if (!mime) throw new Error(`не поддерживаю ${extname(src)} как источник`);
  const dataUrl = `data:${mime};base64,${readFileSync(src).toString("base64")}`;
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  const b64 = await page.evaluate(async ([url, m, q]) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    let w, h, sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    if (m.type === "fit") {
      w = m.width;
      h = Math.round((img.naturalHeight * w) / img.naturalWidth);
    } else {
      const scale = Math.max(m.w / img.naturalWidth, m.h / img.naturalHeight); // cover
      sw = m.w / scale; sh = m.h / scale;
      sx = (img.naturalWidth - sw) / 2; sy = (img.naturalHeight - sh) / 2;
      w = m.w; h = m.h;
    }
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: q });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (const byte of buf) bin += String.fromCharCode(byte);
    return btoa(bin);
  }, [dataUrl, mode, quality]);
  await browser.close();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, Buffer.from(b64, "base64"));
  return out;
}

// ---------- CLI (только при прямом запуске; validate.mjs/package.mjs импортируют функции выше) ----------
const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, ...rest] = process.argv;
  const opt = (n, d) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : d);
  const pos = () => rest.filter((a) => !a.startsWith("--"));

  try {
    if (cmd === "info") {
      const files = pos();
      if (!files.length) throw new Error("usage: images.mjs info <file…>");
      for (const f of files) {
        const i = imageInfo(f);
        console.log(`${f}: ${i.type} ${i.w}×${i.h}, ${(statSync(f).size / KB).toFixed(1)} КБ`);
      }
    } else if (cmd === "convert" || cmd === "crop") {
      const [src, spec] = pos();
      if (!src || !spec) throw new Error(`usage: images.mjs ${cmd} <src> ${cmd === "convert" ? "<width>" : "<WxH>"} [--quality 85] [--out <file>]`);
      const quality = +opt("quality", 85) / 100;
      const mode = cmd === "convert" ? { type: "fit", width: +spec } : { type: "crop", w: +spec.split("x")[0], h: +spec.split("x")[1] };
      // ГЕОМЕТРИЯ ≠ АДАПТАЦИЯ (инцидент поста №16: центр-кроп широкой СЦЕНЫ в квадрат
      // срезал третью станцию конвейера и самолётик). Кроп при несовпадении пропорций —
      // только осознанно: явный --force-crop-ar. Совпадающие пропорции (ресайз-кроп) — как было.
      if (cmd === "crop" && !rest.includes("--force-crop-ar")) {
        const si = imageInfo(resolve(src));
        if (Math.abs(si.w / si.h - mode.w / mode.h) > AR_TOL)
          throw new Error(
            `кроп ${si.w}×${si.h} → ${mode.w}×${mode.h} меняет пропорции (${(si.w / si.h).toFixed(2)} → ${(mode.w / mode.h).toFixed(2)}) — центр-кроп режет композицию. ` +
              `Варианты: сгенерировать/адаптировать под целевой формат; convert (ресайз с сохранением пропорций); поле --force-crop-ar — только если обрезаемое заведомо не смысл.`,
          );
      }
      const base = src.replace(/\.[^.]+$/, "");
      const out = resolve(opt("out", cmd === "convert" ? `${base}.webp` : `${base}-${spec}.webp`));
      await toWebp(resolve(src), mode, quality, out);
      const i = imageInfo(out);
      console.log(`${out}: ${i.w}×${i.h}, ${(statSync(out).size / KB).toFixed(1)} КБ`);
    } else if (cmd === "check") {
      const [dir] = pos();
      if (!dir) throw new Error("usage: images.mjs check <images-dir> [--json]");
      const res = checkImages(resolve(dir));
      if (rest.includes("--json")) console.log(JSON.stringify(res, null, 2)); // документированный булев флаг, а не опция со значением
      else {
        for (const [c, files] of Object.entries(res.concepts))
          for (const [name, r] of Object.entries(files))
            console.log(`${c}/${name}: ${r.w ?? "?"}×${r.h ?? "?"}, ${(r.bytes / KB).toFixed(1)} КБ`);
        res.problems.forEach((p) => console.error(`✗ ${p}`));
        if (res.webpSum) console.log(`суммарно webp: ${(res.webpSum / KB).toFixed(0)} КБ (лимит сайта на выборную концепцию — 3 МБ)`);
        console.error(res.ok ? "✓ изображения прошли проверки" : `✗ ${res.problems.length} проблем`);
      }
      process.exit(res.ok ? 0 : 1);
    } else {
      throw new Error("usage: images.mjs <info|convert|crop|check> …");
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
