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
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
// Расширение выхода = фактический формат содержимого (дефект 2026-11-13: crop всегда
// кодировал WebP, и telegram.png с WebP-нутрим упирался в гейт magic bytes). PNG — lossless.
const OUT_TYPE = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
function assertSrcMatchesExt(src) {
  const real = imageInfo(src).type,
    claimed = extname(src).toLowerCase().replace(".", "");
  if (!["png", "webp", "jpg", "jpeg"].includes(claimed)) return;
  if (real !== claimed)
    throw new Error(
      `${src}: содержимое — ${real}, а расширение .${claimed} (переименование ≠ конвертация; приведи файл к честному расширению)`,
    );
}
async function toWebp(src, mode, quality, out) {
  const { chromium } = await import("playwright-core");
  const mime = MIME[extname(src).toLowerCase()];
  if (!mime) throw new Error(`не поддерживаю ${extname(src)} как источник`);
  assertSrcMatchesExt(resolve(src));
  const outType = OUT_TYPE[extname(out).toLowerCase()];
  if (!outType)
    throw new Error(
      `не поддерживаю ${extname(out)} как выходной формат (png/webp/jpg)`,
    );
  const dataUrl = `data:${mime};base64,${readFileSync(src).toString("base64")}`;
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  const b64 = await page.evaluate(async ([url, m, q, outType]) => {
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
    const blob = await canvas.convertToBlob({ type: outType, quality: outType === "image/png" ? undefined : q });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (const byte of buf) bin += String.fromCharCode(byte);
    return btoa(bin);
  }, [dataUrl, mode, quality, outType]);
  await browser.close();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, Buffer.from(b64, "base64"));
  return out;
}

// ---------- Telegram-first outpainting (tg-master 1536×1024 → expanded 1820×1024) ----------
const TG = { w: 1536, h: 1024, side: 142, expandedW: 1820 };
async function decodePixels(src) {
  const { chromium } = await import("playwright-core");
  const mime = MIME[extname(src).toLowerCase()];
  if (!mime) throw new Error(`не поддерживаю ${extname(src)} как источник`);
  assertSrcMatchesExt(resolve(src));
  const dataUrl = `data:${mime};base64,${readFileSync(src).toString("base64")}`;
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  const px = await page.evaluate(async (url) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return {
      w: img.naturalWidth,
      h: img.naturalHeight,
      data: Array.from(
        ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data,
      ),
    };
  }, dataUrl);
  await browser.close();
  return px;
}
async function encodePixels(w, h, data, out) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  const b64 = await page.evaluate(
    async ([w, h, data]) => {
      const c = new OffscreenCanvas(w, h);
      c.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(data), w, h),
        0,
        0,
      );
      const blob = await c.convertToBlob({ type: "image/png" }); // lossless: центр должен сохраниться пиксель в пиксель
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (const byte of buf) bin += String.fromCharCode(byte);
      return btoa(bin);
    },
    [w, h, data],
  );
  await browser.close();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, Buffer.from(b64, "base64"));
  return out;
}
// stage: master по центру expanded-холста, боковые зоны — растянутые крайние столбцы
// (это только ЗАГОТОВКА для генеративного заполнения, не итог; см. image.md §Outpainting)
async function outpaintStage(master, side, out) {
  const m = await decodePixels(master);
  if (m.w !== TG.w || m.h !== TG.h)
    throw new Error(
      `master должен быть ровно ${TG.w}×${TG.h}, получено ${m.w}×${m.h}`,
    );
  if (side !== TG.side)
    throw new Error(
      `side должен быть ровно ${TG.side} (симметричное расширение до ${TG.expandedW}×${TG.h})`,
    );
  const W = TG.expandedW,
    H = TG.h,
    ch = 4;
  const data = new Array(W * H * ch).fill(0);
  const col = (x) => {
    // цвет крайнего столбца master для заглушки-подсказки генератору
    const out = new Array(H * ch);
    for (let y = 0; y < H; y++)
      for (let c = 0; c < ch; c++)
        out[y * ch + c] = m.data[(y * m.w + x) * ch + c];
    return out;
  };
  const left = col(0),
    right = col(m.w - 1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = x >= side && x < side + m.w;
      const o = (y * W + x) * ch;
      if (src)
        for (let c = 0; c < ch; c++)
          data[o + c] = m.data[(y * m.w + (x - side)) * ch + c];
      else
        for (let c = 0; c < ch; c++)
          data[o + c] = (x < side ? left : right)[y * ch + c];
    }
  }
  return encodePixels(W, H, data, out);
}
// verify: центральная область expanded должна совпадать с master пиксель в пиксель
// (decoded RGBA, не побайтовое PNG-совпадение); швы на границах — информационно
async function outpaintVerify(expanded, master, side) {
  const e = await decodePixels(expanded),
    m = await decodePixels(master);
  if (e.w !== TG.expandedW || e.h !== TG.h)
    throw new Error(
      `expanded должен быть ровно ${TG.expandedW}×${TG.h}, получено ${e.w}×${e.h}`,
    );
  if (m.w !== TG.w || m.h !== TG.h)
    throw new Error(
      `master должен быть ровно ${TG.w}×${TG.h}, получено ${m.w}×${m.h}`,
    );
  let mismatch = 0,
    first = null;
  for (let y = 0; y < TG.h; y++)
    for (let x = 0; x < TG.w; x++) {
      const eo = (y * e.w + (x + side)) * 4,
        mo = (y * m.w + x) * 4;
      for (let c = 0; c < 4; c++)
        if (e.data[eo + c] !== m.data[mo + c]) {
          mismatch++;
          if (!first)
            first = `(${x + side},${y}) ch${c}: ${e.data[eo + c]}≠${m.data[mo + c]}`;
        }
    }
  const seam = (x) => {
    let d = 0;
    for (let y = 0; y < TG.h; y += 8)
      for (let c = 0; c < 3; c++)
        d += Math.abs(
          e.data[(y * e.w + x) * 4 + c] - e.data[(y * e.w + x - 1) * 4 + c],
        );
    return d;
  };
  const seams = { left: seam(side), right: seam(side + TG.w) };
  return { mismatch, first, seams };
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
    } else if (cmd === "outpaint-stage") {
      const [master] = pos();
      const side = +opt("side", TG.side);
      const out = resolve(opt("out", "outpaint-expanded.png"));
      if (!master)
        throw new Error(
          "usage: images.mjs outpaint-stage <master.png> [--side 142] --out expanded.png",
        );
      await outpaintStage(resolve(master), side, out);
      console.log(
        `${out}: ${TG.expandedW}×${TG.h} (master по центру, x=${side}; боковые зоны — заглушка для генеративного заполнения)`,
      );
    } else if (cmd === "outpaint-verify") {
      const [expanded, master] = pos();
      const side = +opt("side", TG.side);
      if (!expanded || !master)
        throw new Error(
          "usage: images.mjs outpaint-verify <expanded.png> <master.png> [--side 142]",
        );
      const r = await outpaintVerify(resolve(expanded), resolve(master), side);
      console.log(
        `center pixels mismatched: ${r.mismatch}${r.first ? ` (первое: ${r.first})` : ""}`,
      );
      console.log(
        `seams @x=${side}: ${r.seams.left}, @x=${side + TG.w}: ${r.seams.right} (информационно; швы требует визуального review)`,
      );
      if (r.mismatch) {
        console.error(
          "✗ центральная область не совпадает с master пиксель в пиксель",
        );
        process.exit(1);
      }
      console.log(
        "✓ round-trip: центральная область идентична master (decoded RGBA)",
      );
    } else if (cmd === "manifest") {
      const [file] = pos();
      if (!file)
        throw new Error("usage: images.mjs manifest <visual-manifest.json>");
      const m = JSON.parse(readFileSync(resolve(file), "utf8"));
      const problems = [];
      if (!["telegram-first", "separate-compositions"].includes(m.mode))
        problems.push(
          `mode: ${m.mode} — ожидается telegram-first | separate-compositions`,
        );
      if (m.mode === "telegram-first") {
        if (!m.master || m.master.w !== TG.w || m.master.h !== TG.h)
          problems.push(`master: ожидается {w:${TG.w},h:${TG.h}}`);
        if (m.side_px !== TG.side)
          problems.push(`side_px: ожидается ${TG.side}`);
        if (!m.outpaint_instructions)
          problems.push("outpaint_instructions: отсутствует");
        if (!m.expanded)
          problems.push("expanded: отсутствует (1820×1024 intermediate)");
        if (!["pending-review", "approved", "needs-iteration"].includes(m.visual_review?.status))
          problems.push(
            "visual_review.status: ожидается pending-review | approved | needs-iteration (ставит владелец после осмотра швов; tests/provenance его НЕ выставляют)",
          );
      }
      for (const k of ["telegram", "cover", "preview"])
        if (!m.outputs?.[k]) problems.push(`outputs.${k}: отсутствует`);
      if (!m.brief)
        problems.push("brief: отсутствует (canonical visual brief)");
      if (!m.provenance) problems.push("provenance: отсутствует");
      if (problems.length) {
        problems.forEach((x) => console.error(`✗ ${x}`));
        process.exit(1);
      }
      console.log(`✓ manifest валиден (mode=${m.mode})`);
    } else if (cmd === "provenance") {
      const [dir] = pos();
      if (!dir) throw new Error("usage: images.mjs provenance <concept-dir>");
      const { createHash } = await import("node:crypto");
      const mode = JSON.parse(
        readFileSync(resolve(dir, "visual-manifest.json"), "utf8"),
      ).mode;
      const req = [
        "visual-brief.md",
        "visual-manifest.json",
        "blog-cover.webp",
        "blog-preview.webp",
        ...(mode === "telegram-first"
          ? [
              "telegram-master.png",
              "telegram.png",
              "outpaint-expanded.png",
              "outpaint-instructions.md",
            ]
          : ["telegram.png"]),
      ];
      const missing = req.filter((f) => !existsSync(resolve(dir, f)));
      if (missing.length) {
        missing.forEach((f) => console.error(`✗ отсутствует ${f}`));
        process.exit(1);
      }
      const files = {};
      for (const f of req) {
        const buf = readFileSync(resolve(dir, f));
        // размеры — best effort: provenance фиксирует и ещё не обработанные файлы
        let i = null;
        try {
          i = imageInfo(resolve(dir, f));
        } catch {}
        files[f] = {
          sha256: createHash("sha256").update(buf).digest("hex"),
          bytes: buf.length,
          ...(i ? { w: i.w, h: i.h, type: i.type } : {}),
        };
      }
      const out = resolve(dir, "provenance.json");
      writeFileSync(
        out,
        JSON.stringify(
          { generated_at: new Date().toISOString(), mode, files },
          null,
          2,
        ),
      );
      console.log(`${out}: ${req.length} файлов зафиксировано`);
    } else {
      throw new Error("usage: images.mjs <info|convert|crop|check|outpaint-stage|outpaint-verify|manifest|provenance> …");
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
