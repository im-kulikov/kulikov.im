#!/usr/bin/env node
// Тесты article-production skill. Запуск: node .agents/skills/article-production/scripts/test.mjs
// Каждый набор работает в своей песочнице (EDITORIAL_TMP=mkdtemp), живой реестр data/terms.yml
// тестами не изменяется (песочницы получают копию через --registry).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPTS = import.meta.dirname;
const SKILL_DIR = resolve(SCRIPTS, "..");
const ROOT = resolve(SKILL_DIR, "..", "..", ".."); // корень репозитория kulikov.im

// ---------- helpers ----------
const box = () => mkdtempSync(join(tmpdir(), "editorial-"));
const run = (script, args, sandbox, opts = {}) => {
  const r = spawnSync("node", [join(SCRIPTS, script), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, EDITORIAL_TMP: sandbox },
    timeout: opts.timeout ?? 30_000,
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const jsonOf = (s) => JSON.parse(s.trim().split("\n")[0]);
const py = (code) => {
  const r = spawnSync("python3", ["-c", code], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error("python fixture failed:\n" + r.stderr);
};
const makeZip = (sandbox, name, files) => {
  // files: [{path, content}] — обычный zip
  const dir = join(sandbox, "inbox");
  mkdirSync(dir, { recursive: true });
  const entries = Object.entries(files)
    .map(([p, c]) => `zf.writestr(${JSON.stringify(p)}, ${JSON.stringify(c)})`)
    .join(";");
  py(`import zipfile; zf=zipfile.ZipFile(${JSON.stringify(join(dir, name))},"w");${entries};zf.close()`);
  return join(dir, name);
};
const registry = (sandbox) => {
  mkdirSync(join(sandbox, "data"), { recursive: true });
  const src = join(SKILL_DIR, "data", "terms.yml");
  cpSync(src, join(sandbox, "data/terms.yml"));
  return join(sandbox, "data/terms.yml");
};
// минимальные заголовки изображений (парсер images.mjs читает только заголовок — этого достаточно)
const pngHdr = (w, h) => {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const webpHdr = (w, h) => {
  const b = Buffer.alloc(64);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(56, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b.writeUInt32LE(9, 16);
  b.writeUInt8(0x2f, 20); // signature VP8L
  const v = (((w - 1) | ((h - 1) << 14)) >>> 0);
  b[21] = v & 0xff;
  b[22] = (v >> 8) & 0xff;
  b[23] = (v >> 16) & 0xff;
  b[24] = (v >> 24) & 0xff;
  return b;
};

// =====================================================================
describe("UTF-16 length validation (tg-check.mjs)", () => {
  const sb = box();
  const file = (name, text) => {
    const p = join(sb, "drafts/x", name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };

  test("кириллица: точная длина в UTF-16 units", () => {
    const text = "Пр".repeat(300) + "\nещё строка"; // 600 + 1 + 10 = 611
    const r = run("tg-check.mjs", [file("t1.md", text)], sb);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(jsonOf(r.out), { format: "html", length: 611, limit: 1024, remaining: 1024 - 611, target: 950, valid: true });
  });

  test("emoji: суррогатная пара = 2 units", () => {
    const text = "😀".repeat(10) + "а".repeat(5); // 10×2 + 5 = 25
    const r = run("tg-check.mjs", [file("t2.md", text)], sb);
    assert.equal(jsonOf(r.out).length, 25);
  });

  test("html: теги убраны, текст ссылки учтён, href — нет, entities декодированы", () => {
    const text = 'Поехали <b>жирно</b> и <a href="https://kulikov.im/blog/abc.html">ссылка</a> &amp; всё';
    // видимый: "Поехали жирно и ссылка & всё" = 28
    const r = run("tg-check.mjs", [file("t3.md", text)], sb);
    assert.equal(jsonOf(r.out).length, 28);
    assert.equal(jsonOf(r.out).format, "html");
  });

  test("markdownv2: [текст](url) → текст", () => {
    const text = "Смотри [заметку](https://kulikov.im/blog/x.html) *важно*";
    // видимый: "Смотри заметку важно" = 20
    const r = run("tg-check.mjs", [file("t4.md", text), "--format", "markdownv2"], sb);
    assert.equal(jsonOf(r.out).length, 20);
  });

  test("превышение лимита: exit 1, remaining отрицательный", () => {
    const r = run("tg-check.mjs", [file("t5.md", "Ж".repeat(1100))], sb);
    assert.equal(r.status, 1);
    const j = jsonOf(r.out);
    assert.equal(j.valid, false);
    assert.equal(j.remaining, -76);
    assert.equal(j.length, 1100);
  });

  test("служебные HTML-комментарии не публикуются и не считаются", () => {
    const text = "<!-- meta: draft v2 -->Видимый текст"; // видимый текст = 13 units
    const r = run("tg-check.mjs", [file("t6.md", text)], sb);
    assert.equal(jsonOf(r.out).length, 13);
  });

  test("метаданные пишутся в telegram.json рядом с подписью", () => {
    const f = file("meta-sub/telegram.md", "Проверка метаданных"); // своя папка — чужой формат не просочится
    run("tg-check.mjs", [f], sb);
    const meta = JSON.parse(readFileSync(join(sb, "drafts/x/meta-sub/telegram.json"), "utf8"));
    for (const k of ["format", "length", "limit", "remaining", "valid", "checked_at"]) assert.ok(k in meta, k);
    assert.equal(meta.valid, true);
    assert.equal(meta.format, "html");
  });
});

// =====================================================================
describe("terminology registry (terms.mjs)", () => {
  const sb = box();
  const reg = registry(sb);

  test("известные термины и aliases находятся", () => {
    const res = spawnSync("node", [join(SCRIPTS, "terms.mjs"), "check", "-", "--registry", reg], {
      input: "Поднял Virtual Private Server и настроил MTProto.",
      encoding: "utf8", env: { ...process.env, EDITORIAL_TMP: sb },
    });
    assert.equal(res.status, 0, res.stderr);
    const j = JSON.parse(res.stdout); // check печатает один JSON-блок (заметки — в stderr)
    assert.deepEqual(j.known.map((k) => k.term).sort(), ["MTProto", "VPS"]);
    assert.equal(j.known.find((k) => k.term === "VPS").alias, true);
  });

  test("эвристика кандидатов: находит новое, игнорирует стоп-слова и известные", () => {
    const res = spawnSync("node", [join(SCRIPTS, "terms.mjs"), "check", "-", "--registry", reg], {
      input: "THE NAT и DHCP, плюс MTProto. Смешанное слово MTPROTO не капс.",
      encoding: "utf8", env: { ...process.env, EDITORIAL_TMP: sb },
    });
    assert.equal(res.status, 0, res.stderr);
    const j = JSON.parse(res.stdout);
    assert.ok(j.candidates.includes("NAT") && j.candidates.includes("DHCP"));
    assert.ok(!j.candidates.includes("THE"));
    assert.ok(!j.candidates.some((c) => c === "MTP" || c === "MTPROTO")); // префикс смешанного слова
  });

  test("confirm добавляет с определением; дубликат запрещён", () => {
    const ok = run("terms.mjs", ["confirm", "NAT", "--definition", "Network Address Translation", "--registry", reg], sb);
    assert.equal(ok.status, 0, ok.err);
    const dup = run("terms.mjs", ["confirm", "nat", "--definition", "дубль", "--registry", reg], sb);
    assert.equal(dup.status, 1);
    assert.match(dup.err, /уже есть в реестре/);
  });

  test("publish: заполняет first_*, повтор запрещён, битый URL отклоняется", () => {
    const bad = run("terms.mjs", ["publish", "NAT", "--article", "a1", "--telegram-url", "https://example.com/x", "--registry", reg], sb);
    assert.equal(bad.status, 1);
    assert.match(bad.err, /не похож на пост Telegram/);
    const ok = run("terms.mjs", ["publish", "NAT", "--article", "a1", "--telegram-url", "https://t.me/dompod/7", "--date", "2026-11-11", "--registry", reg], sb);
    assert.equal(ok.status, 0, ok.err);
    const yml = readFileSync(reg, "utf8");
    assert.match(yml, /first_article_id: a1/);
    assert.match(yml, /first_telegram_url: https:\/\/t\.me\/dompod\/7/);
    assert.match(yml, /first_published_at: "?2026-11-11/);
    const again = run("terms.mjs", ["publish", "NAT", "--article", "a2", "--registry", reg], sb);
    assert.equal(again.status, 1);
    assert.match(again.err, /Повторная публикация запрещена/);
  });

  test("list фильтрует по status", () => {
    const r = run("terms.mjs", ["list", "--status", "published", "--registry", reg], sb);
    assert.equal(r.status, 0);
    assert.match(r.out, /VPS/);
    assert.doesNotMatch(r.out, /status=confirmed/);
  });
});

// =====================================================================
describe("state transitions (state.mjs + lib.mjs)", () => {
  const sb = box();
  const mk = (id = "art") => {
    run("intake.mjs", [makeZip(sb, `${id}.zip`, { "note.txt": "факт" })], sb);
  };

  test("полный happy path до done; published требует реальный telegram_url", () => {
    mk();
    for (const to of ["processing", "draft", "review", "approved", "publishing"]) {
      const r = run("state.mjs", ["art", to], sb);
      assert.equal(r.status, 0, `${to}: ${r.err}`);
    }
    const noUrl = run("state.mjs", ["art", "published"], sb);
    assert.equal(noUrl.status, 1);
    assert.match(noUrl.err, /требует реальный telegram_url/); // отсутствующий Telegram URL не выдумываем
    run("state.mjs", ["art", "set", "telegram_url=https://t.me/dompod/9"], sb);
    run("state.mjs", ["art", "step", "article_published"], sb);
    const pub = run("state.mjs", ["art", "published"], sb);
    assert.equal(pub.status, 0, pub.err);
    const done = run("state.mjs", ["art", "done"], sb);
    assert.equal(done.status, 0, done.err);
  });

  test("done: архив покидает inbox, в done/<id> появляются материалы и metadata.json", () => {
    assert.ok(!existsSync(join(sb, "inbox/art.zip")));
    assert.ok(existsSync(join(sb, "done/art/metadata.json")));
    const meta = JSON.parse(readFileSync(join(sb, "done/art/metadata.json"), "utf8"));
    assert.equal(meta.state, "done");
    assert.equal(meta.telegram_url, "https://t.me/dompod/9");
    assert.equal(meta.checklist.article_published, true);
  });

  test("невалидные переходы отклоняются", () => {
    mk("bad");
    const r = run("state.mjs", ["bad", "done"], sb); // processing → done
    assert.equal(r.status, 1);
    assert.match(r.err, /не разрешён/);
  });

  test("error фиксирует сбой, restore возвращает прежнее состояние; история сохраняется", () => {
    mk("flaky");
    run("state.mjs", ["flaky", "draft"], sb);
    run("state.mjs", ["flaky", "review"], sb);
    const err = run("state.mjs", ["flaky", "error", "--note", "упало"], sb);
    assert.equal(err.status, 0);
    const res = run("state.mjs", ["flaky", "restore"], sb);
    assert.equal(res.status, 0);
    assert.match(res.out, /error → review/);
    const show = run("state.mjs", ["flaky"], sb);
    assert.match(show.out, /flaky: review/);
    assert.match(show.out, /упало/); // история на месте
  });

  test("error без --note и step вне publishing отклоняются", () => {
    mk("guard");
    const noNote = run("state.mjs", ["guard", "error"], sb);
    assert.equal(noNote.status, 2);
    run("state.mjs", ["guard", "draft"], sb);
    const step = run("state.mjs", ["guard", "step", "article_published"], sb);
    assert.equal(step.status, 1);
  });

  test("повторная обработка: intake на существующем id пропускается", () => {
    mk("twin");
    const again = run("intake.mjs", [join(sb, "inbox/twin.zip")], sb);
    assert.equal(again.status, 0);
    assert.match(again.out, /защита от повторной обработки/);
  });

  test("повреждённый state.json и битый article-id дают внятную ошибку", () => {
    mk("broken");
    writeFileSync(join(sb, "working/broken/state.json"), "{ not json");
    const r = run("state.mjs", ["broken"], sb);
    assert.equal(r.status, 1);
    assert.match(r.err, /повреждён/);
    const bad = run("state.mjs", ["Bad_ID!"], sb);
    assert.equal(bad.status, 1);
    assert.match(bad.err, /недопустимый article-id/);
  });

  test("verify: недоступный URL не отмечает шаг; отсутствующий URL не выдумывается", () => {
    mk("net");
    for (const to of ["draft", "review", "approved", "publishing"]) run("state.mjs", ["net", to], sb);
    const missing = run("state.mjs", ["net", "verify", "article"], sb);
    assert.equal(missing.status, 1);
    assert.match(missing.err, /не задан/);
    run("state.mjs", ["net", "set", "article_url=http://127.0.0.1:9/blog/x.html"], sb); // закрытый порт
    const dead = run("state.mjs", ["net", "verify", "article"], sb);
    assert.equal(dead.status, 1);
    const show = run("state.mjs", ["net"], sb);
    assert.match(show.out, /осталось \[/);
    assert.match(show.out, /article_url_verified/); // шаг не отмечен — URL был недоступен
  });

  test("lib: из error прямые переходы запрещены (только restore); UTF-16 units", async () => {
    const lib = await import(join(SCRIPTS, "lib.mjs"));
    assert.deepEqual(lib.TRANSITIONS.error, []);
    assert.equal(lib.utf16Length("🛠️x"), 4); // 🛠️ = 2 (emoji) + 1 (VS16), +1 буква
    assert.equal(lib.utf16Length("😀"), 2);
  });
});

// =====================================================================
describe("intake: ZIP security", () => {
  const sb = box();

  test("нормальный архив: inventory + state=processing", () => {
    const zip = makeZip(sb, "good.zip", { "notes/readme.md": "# факт", "log.txt": "ok" });
    const r = run("intake.mjs", [zip], sb);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Готово: tmp\/working\/good/);
    const inv = readFileSync(join(sb, "working/good/inventory.md"), "utf8");
    assert.match(inv, /notes\/readme\.md/);
    assert.match(inv, /недоверенные данные/i);
  });

  test("zip-slip (../) отклоняется до распаковки", () => {
    const dir = join(sb, "inbox");
    mkdirSync(dir, { recursive: true });
    py(`import zipfile; zf=zipfile.ZipFile(${JSON.stringify(join(dir, "slip.zip"))},"w"); zf.writestr("../evil.txt","x"); zf.writestr("ok.txt","y"); zf.close()`);
    const r = run("intake.mjs", [join(dir, "slip.zip")], sb);
    assert.equal(r.status, 1);
    assert.match(r.err, /zip-slip/);
    assert.ok(!existsSync(join(sb, "evil.txt")));
  });

  test("дублирующиеся пути отклоняются", () => {
    const dir = join(sb, "inbox");
    mkdirSync(dir, { recursive: true });
    py(`import zipfile; zf=zipfile.ZipFile(${JSON.stringify(join(dir, "dup.zip"))},"w"); zf.writestr("a.txt","1"); zf.writestr("a.txt","2"); zf.close()`);
    const r = run("intake.mjs", [join(dir, "dup.zip")], sb);
    assert.equal(r.status, 1);
    assert.match(r.err, /Дублирующиеся пути/);
  });

  test("ZIP-бомба (4×60 МБ нулей) отклоняется по ratio-эвристике", () => {
    const dir = join(sb, "inbox");
    // 240 МБ суммарно (под лимитом 256 МиБ), каждый файл под 64 МиБ — срабатывает только ratio
    py(`import zipfile; zf=zipfile.ZipFile(${JSON.stringify(join(dir, "bomb.zip"))},"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9)
for i in range(4): zf.writestr(f"z{i}.bin","0"*60_000_000)
zf.close()`);
    const r = run("intake.mjs", [join(dir, "bomb.zip")], sb);
    assert.equal(r.status, 1);
    assert.match(r.err, /ZIP-бомб/);
  });

  test("symlink-запись отклоняется ДО распаковки (окно для записи наружу закрыто)", () => {
    const dir = join(sb, "inbox");
    py(`import zipfile
zf = zipfile.ZipFile(${JSON.stringify(join(dir, "sym.zip"))}, "w")
info = zipfile.ZipInfo("link.txt")
info.external_attr = 0o120777 << 16
zf.writestr(info, "../outside-target")
zf.writestr("real.txt", "ok")
zf.close()`);
    const r = run("intake.mjs", [join(dir, "sym.zip")], sb);
    assert.equal(r.status, 1);
    assert.match(r.err, /symlink-записи/);
    assert.match(r.err, /link\.txt/);
    assert.ok(!existsSync(join(sb, "working/sym/archive/link.txt")));
    assert.ok(!existsSync(join(sb, "working/sym/archive"))); // вообще не распаковывался
  });

  test("подделанный листинг (CD patched): фактический размер > 64 МиБ — отказ и очистка", () => {
    const dir = join(sb, "inbox");
    mkdirSync(dir, { recursive: true });
    // 70 МБ нулей; несжатый размер в central directory патчится до 100 байт:
    // unzip -l показывает 100, unzip -o распаковывает все 70 МБ (поведение проверено вручную)
    py(`import zipfile, struct
path = ${JSON.stringify(join(dir, "forged.zip"))}
zf = zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6)
zf.writestr("big.bin", "0" * 70_000_000)
zf.close()
data = bytearray(open(path, "rb").read())
i = data.find(b"PK\\x01\\x02")
while i != -1:
    name_len = struct.unpack("<H", data[i + 28:i + 30])[0]
    if data[i + 46:i + 46 + name_len] == b"big.bin":
        data[i + 24:i + 28] = struct.pack("<I", 100)
    i = data.find(b"PK\\x01\\x02", i + 4)
open(path, "wb").write(data)`);
    const r = run("intake.mjs", [join(dir, "forged.zip")], sb, { timeout: 120_000 });
    assert.equal(r.status, 1);
    assert.match(r.err, /Фактический распакованный объём/);
    assert.ok(!existsSync(join(sb, "working/forged/archive"))); // каталог удалён, не оставляем распакованное
  });

  test("исполняемые вложения помечаются в inventory", () => {
    const zip = makeZip(sb, "exec.zip", { "run.sh": "#!/bin/sh\necho hi", "doc.md": "текст" });
    const r = run("intake.mjs", [zip], sb);
    assert.equal(r.status, 0, r.err);
    const inv = readFileSync(join(sb, "working/exec/inventory.md"), "utf8");
    assert.match(inv, /\| run\.sh \| \.sh \| [^|]+ \| исполняемый/);
  });

  test("article-id из имени архива валидируется", () => {
    const dir = join(sb, "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Bad Name!.zip"), "x");
    const r = run("intake.mjs", [join(dir, "Bad Name!.zip")], sb);
    assert.equal(r.status, 2);
    assert.match(r.err, /article-id/);
  });
});

// =====================================================================
describe("secrets-check", () => {
  const sb = box();
  const file = (name, text) => {
    mkdirSync(join(sb, "d"), { recursive: true });
    writeFileSync(join(sb, "d", name), text);
    return join(sb, "d", name);
  };

  test("high (пароль/токены/URL с кредами) блокирует", () => {
    const f = file(
      "secret.md",
      "password: hunter2secret\ntoken ghp_AbCdEf1234567890AbCdEf12\ncurl https://user:pass@example.com/x\n",
    );
    const r = run("secrets-check.mjs", [f], sb);
    assert.equal(r.status, 1);
    assert.match(r.out, /password-assign/);
    assert.match(r.out, /github-token/);
    assert.match(r.out, /url-with-credentials/);
  });

  test("SSH private key обнаруживается", () => {
    const f = file("id.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nMIbogus\n");
    const r = run("secrets-check.mjs", [f], sb);
    assert.equal(r.status, 1);
    assert.match(r.out, /ssh-private-key/);
  });

  test("приватные IP — warn; loopback — info; RFC 5737 (192.0.2.x) не флагается", () => {
    const f = file("net.md", "host 10.1.2.3 и 192.168.1.1, пример 192.0.2.42, сам 127.0.0.1\n");
    const r = run("secrets-check.mjs", [f, "--json"], sb);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.out); // --json печатает findings одним JSON-блоком (итог — в stderr)
    assert.deepEqual([...new Set(j.map((x) => x.sev))].sort(), ["info", "warn"]);
    assert.ok(!j.some((x) => x.sample.includes("192.0.2.42")));
  });

  test("doc-IP (RFC 5737) не глушит приватный IP в той же строке", () => {
    const f = file("mixed.md", "шлюз 192.0.2.42, стенд 10.5.5.5 в лабе\n");
    const r = run("secrets-check.mjs", [f, "--json"], sb);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.out);
    assert.ok(j.some((x) => x.id === "private-ipv4" && x.sample.includes("10.5.5.5")));
    assert.ok(!j.some((x) => x.sample.includes("192.0.2.42")));
  });

  test("baseline после ручного review подавляет конкретную находку", () => {
    const f = file("base.md", "внутренний стенд 10.5.5.5\n");
    mkdirSync(join(sb, "d"), { recursive: true });
    // baseline-строка = «отображаемый путь:строка:severity»; отображаемый путь здесь абсолютный (файл вне cwd)
    writeFileSync(join(sb, "d/baseline.txt"), `${join(sb, "d/base.md")}:1:warn`);
    const strict = run("secrets-check.mjs", [f, "--baseline", join(sb, "d/baseline.txt"), "--strict"], sb);
    assert.equal(strict.status, 0, strict.err);
  });
});

// =====================================================================
describe("visibleCaption (lib.mjs) — юнит-уровень", () => {
  test("html/markdownv2/plain векторы", async () => {
    const { visibleCaption } = await import(join(SCRIPTS, "lib.mjs"));
    assert.equal(visibleCaption("a<br>b", "html"), "a\nb");
    assert.equal(visibleCaption("<b>x</b>y&amp;z", "html"), "xy&z");
    assert.equal(visibleCaption("[текст](https://t.me/x)", "markdownv2"), "текст");
    assert.equal(visibleCaption("<!-- c -->текст", "plain"), "текст");
  });
});

// =====================================================================
describe("images.mjs: размеры и бюджеты (без генерации)", () => {
  const sb = box();
  const concept = (dir, n, opts = {}) => {
    const c = join(dir, `concept-0${n}`);
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "telegram.png"), opts.tg ?? pngHdr(1024, 1024));
    writeFileSync(join(c, "blog-cover.webp"), opts.cover ?? webpHdr(1280, 720));
    writeFileSync(join(c, "blog-preview.webp"), opts.preview ?? webpHdr(800, 450));
    writeFileSync(join(c, "prompt.md"), "prompt");
  };

  test("info читает размеры PNG и WebP по заголовкам", () => {
    writeFileSync(join(sb, "t.png"), pngHdr(640, 480));
    writeFileSync(join(sb, "t.webp"), webpHdr(1280, 720));
    const r = run("images.mjs", ["info", join(sb, "t.png"), join(sb, "t.webp")], sb);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /t\.png: png 640×480/);
    assert.match(r.out, /t\.webp: webp 1280×720/);
  });

  test("check: три корректные концепции проходят", () => {
    const dir = join(sb, "drafts/ok/images");
    [1, 2, 3].forEach((n) => concept(dir, n));
    const r = run("images.mjs", ["check", dir], sb);
    assert.equal(r.status, 0, r.err);
  });

  test("check: не-квадрат, не-16:9, лишний вес, две концепции — отклоняется", () => {
    const dir = join(sb, "drafts/bad/images");
    concept(dir, 1, { tg: pngHdr(1024, 768) }); // telegram не 1:1
    concept(dir, 2, { cover: Buffer.concat([webpHdr(1024, 768), Buffer.alloc(160 * 1024)]) }); // не 16:9 + >150 КБ
    // concept-03 отсутствует
    const r = run("images.mjs", ["check", dir], sb);
    assert.equal(r.status, 1);
    assert.match(r.err, /не квадрат 1:1/);
    assert.match(r.err, /не 16:9/);
    assert.match(r.err, /150 КБ/);
    assert.match(r.err, /концепций 2/);
  });
});

// =====================================================================
describe("validate.mjs: пре-review гейт", () => {
  const sb = box();
  const BRIEF = [
    "# Brief: val",
    "",
    ...["Тема", "Контекст", "Ключевые факты", "Проблема", "Результат", "Аудитория", "Заголовок", "Краткое описание", "Визуальные объекты", "Ограничения и неопределённости"].map((h) => `## ${h}\n\nтекст`),
    "",
  ].join("\n");
  const article = (body = "Текст статьи без капс-аббревиатур.", draft = "true") => [
    "---",
    'title: "Проверка сборки пакета"',
    'description: "Описание ровно в пятидесяти символах плюс немного запаса"',
    "date: 2026-11-11",
    "tags: [тест]",
    `draft: ${draft}`,
    "slug: val-check",
    "image: cover.webp",
    "---",
    "",
    body,
    "",
  ].join("\n");
  const fixture = (opts = {}) => {
    const d = join(sb, "drafts", opts.id ?? "val");
    mkdirSync(d, { recursive: true });
    if (!opts.noBrief) writeFileSync(join(d, "brief.md"), BRIEF);
    writeFileSync(join(d, "article.md"), article(opts.body, opts.draft));
    writeFileSync(join(d, "telegram.md"), "Просто живой текст заметки.");
    return d;
  };

  test("полный комплект материалов проходит", () => {
    fixture();
    const r = run("validate.mjs", ["val"], sb);
    assert.equal(r.status, 0, r.err + r.out);
    assert.match(r.out, /все проверки пройдены/);
    assert.ok(existsSync(join(sb, "drafts/val/telegram.json"))); // tg-check записал метаданные
  });

  test("неразрешённый капс-термин в статье проваливает гейт", () => {
    fixture({ id: "cand", body: "Столкнулся с странным кодом XMLQ в логах." });
    const r = run("validate.mjs", ["cand"], sb);
    assert.equal(r.status, 1);
    assert.match(r.out, /FAIL\s+термины: кандидаты разрешены/);
    assert.match(r.out, /XMLQ/);
  });

  test("draft:false и отсутствие brief.md проваливают гейт", () => {
    fixture({ id: "prem", draft: "false", noBrief: true });
    const r = run("validate.mjs", ["prem"], sb);
    assert.equal(r.status, 1);
    assert.match(r.out, /FAIL\s+brief\.md/);
    assert.match(r.out, /FAIL\s+article\.md: draft: true до approval/);
  });
});

// =====================================================================
describe("package.mjs: сборка review package", () => {
  const sb = box();
  const BRIEF = [
    "# Brief: pkg",
    "",
    ...["Тема", "Контекст", "Ключевые факты", "Проблема", "Результат", "Аудитория", "Заголовок", "Краткое описание", "Визуальные объекты", "Ограничения и неопределённости"].map((h) => `## ${h}\n\nтекст`),
    "",
  ].join("\n");
  const ARTICLE = [
    "---",
    'title: "Проверка сборки пакета"',
    'description: "Описание ровно в пятидесяти символах плюс немного запаса"',
    "date: 2026-11-11",
    "tags: [тест]",
    "draft: true",
    "slug: pkg-check",
    "image: cover.webp",
    "---",
    "",
    "Текст статьи без капс-аббревиатур.",
    "",
  ].join("\n");

  test("полный пакет: metadata.json + review.md; пересборка metadata идемпотентна", () => {
    const d = join(sb, "drafts", "pkg");
    const img = join(d, "images");
    mkdirSync(img, { recursive: true });
    writeFileSync(join(d, "brief.md"), BRIEF);
    writeFileSync(join(d, "article.md"), ARTICLE);
    writeFileSync(join(d, "telegram.md"), "Просто живой текст заметки.");
    writeFileSync(join(img, "brief.md"), "# Image Brief\n\nтри концепции\n");
    [1, 2, 3].forEach((n) => {
      const c = join(img, `concept-0${n}`);
      mkdirSync(c, { recursive: true });
      writeFileSync(join(c, "prompt.md"), "использованный промпт");
      writeFileSync(join(c, "telegram.png"), pngHdr(1024, 1024));
      writeFileSync(join(c, "blog-cover.webp"), webpHdr(1280, 720));
      writeFileSync(join(c, "blog-preview.webp"), webpHdr(800, 450));
    });
    const r = run("package.mjs", ["pkg"], sb, { timeout: 60_000 });
    assert.equal(r.status, 0, r.err + r.out);
    const meta = JSON.parse(readFileSync(join(d, "metadata.json"), "utf8"));
    assert.equal(meta.images["concept-01"]["blog-cover.webp"].w, 1280);
    assert.equal(meta.telegram.valid, true);
    const review = readFileSync(join(d, "review.md"), "utf8");
    assert.match(review, /concept-01/);
    assert.match(review, /Решение владельца/);
    const again = run("package.mjs", ["pkg", "--skip-validate"], sb);
    assert.equal(again.status, 0, again.err);
    const review2 = readFileSync(join(d, "review.md"), "utf8");
    assert.equal(review2, review); // каркас не перезаписывается
  });

  test("неполный пакет (нет концепции) не собирается даже с --skip-validate", () => {
    const d = join(sb, "drafts", "gap");
    const img = join(d, "images");
    mkdirSync(join(img, "concept-01"), { recursive: true });
    writeFileSync(join(d, "brief.md"), BRIEF);
    writeFileSync(join(d, "article.md"), ARTICLE);
    writeFileSync(join(d, "telegram.md"), "Просто живой текст заметки.");
    writeFileSync(join(d, "telegram.json"), JSON.stringify({ format: "html", length: 10, limit: 1024, valid: true }));
    writeFileSync(join(img, "brief.md"), "# Image Brief\n");
    const r = run("package.mjs", ["gap", "--skip-validate"], sb);
    assert.equal(r.status, 1);
    assert.match(r.err, /нужно ровно 3/);
    assert.ok(!existsSync(join(d, "metadata.json"))); // ничего не собрано вхолостую
  });
});

// =====================================================================
describe("cross-promotion: state.mjs crosspromo + checkCrossLinks", () => {
  const sb = box();
  const mk = (id) => run("intake.mjs", [makeZip(sb, `${id}.zip`, { "note.txt": "факт" })], sb);
  // сети в песочнице нет: состояние «URL опубликован и проверен» ставим напрямую в canonical state.json
  const publish = (id, files = {}) => {
    const sp = join(sb, "working", id, "state.json");
    const st = JSON.parse(readFileSync(sp, "utf8"));
    st.article_url = files.article_url ?? `https://kulikov.im/blog/${id}.html`;
    st.checklist.article_url_verified = true;
    st.telegram_url = files.telegram_url ?? "https://t.me/homeinprod/5";
    writeFileSync(sp, JSON.stringify(st));
    const d = join(sb, "drafts", id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "telegram.md"), files.telegram_md ?? "Короткая заметка об эксперименте.");
  };

  test("требует опубликованный и проверенный URL статьи", () => {
    mk("cp0");
    const none = run("state.mjs", ["cp0", "crosspromo"], sb);
    assert.equal(none.status, 1);
    assert.match(none.err, /article_url не задан/);
    const sp = join(sb, "working/cp0/state.json");
    const st = JSON.parse(readFileSync(sp, "utf8"));
    st.article_url = "https://kulikov.im/blog/cp0.html";
    writeFileSync(sp, JSON.stringify(st));
    const unverified = run("state.mjs", ["cp0", "crosspromo"], sb);
    assert.equal(unverified.status, 1);
    assert.match(unverified.err, /verify article/);
  });

  test("пишет предложение с проверенной ссылкой и длиной; повтор не дублирует", () => {
    mk("cp1");
    publish("cp1");
    const r = run("state.mjs", ["cp1", "crosspromo"], sb);
    assert.equal(r.status, 0, r.err + r.out);
    const out = readFileSync(join(sb, "drafts/cp1/crosspromo.md"), "utf8");
    assert.match(out, /📖 Подробный разбор — в блоге: https:\/\/kulikov\.im\/blog\/cp1\.html/);
    assert.match(out, /UTF-16/);
    assert.match(out, /caption \d+\/1024/);
    assert.match(out, /approval владельца/);
    // идемпотентность: ссылка уже в фактическом тексте поста — новое предложение не формируется
    writeFileSync(join(sb, "drafts/cp1/telegram-final.md"), "Пост. Подробный разбор: https://kulikov.im/blog/cp1.html");
    const dup = run("state.mjs", ["cp1", "crosspromo"], sb);
    assert.equal(dup.status, 0);
    assert.match(dup.out, /уже есть в тексте поста/);
  });

  test("превышение лимита 4096 блокирует предложение", () => {
    mk("cp2");
    publish("cp2", { telegram_md: "Ж".repeat(4100) });
    const r = run("state.mjs", ["cp2", "crosspromo"], sb);
    assert.equal(r.status, 1);
    assert.match(r.err, /4096/);
  });

  test("--text без URL получает ссылку в конце; текст с URL не дублирует её", () => {
    mk("cp3");
    publish("cp3");
    const noUrl = run("state.mjs", ["cp3", "crosspromo", "--text", "Подробности в блоге"], sb);
    assert.equal(noUrl.status, 0, noUrl.err);
    const out1 = readFileSync(join(sb, "drafts/cp3/crosspromo.md"), "utf8");
    assert.match(out1, /Подробности в блоге https:\/\/kulikov\.im\/blog\/cp3\.html/); // ссылка добавлена
    assert.match(out1, />Подробности в блоге<\/a>/); // anchor без хвостового двоеточия и пробелов
    const withUrl = run("state.mjs", ["cp3", "crosspromo", "--text", "Разбор: https://kulikov.im/blog/cp3.html"], sb);
    assert.equal(withUrl.status, 0, withUrl.err);
    const out2 = readFileSync(join(sb, "drafts/cp3/crosspromo.md"), "utf8");
    assert.equal(out2.match(/https:\/\/kulikov\.im\/blog\/cp3\.html/g).length >= 2, true); // текст + href
    assert.match(out2, />Разбор<\/a>/); // двойной пробел после замены схлопнут
  });

  test("checkCrossLinks: двусторонние ссылки находятся, отсутствие — фиксируется", async () => {
    const lib = await import(join(SCRIPTS, "lib.mjs"));
    const articleUrl = "https://kulikov.im/blog/x.html";
    const telegramUrl = "https://t.me/homeinprod/5";
    assert.deepEqual(
      lib.checkCrossLinks({ articleHtml: `<a href="${telegramUrl}">тг</a>`, telegramHtml: `смотри ${articleUrl}`, articleUrl, telegramUrl }),
      [],
    );
    const bad = lib.checkCrossLinks({ articleHtml: "нет ссылки на пост", telegramHtml: "нет ссылки на статью", articleUrl, telegramUrl });
    assert.equal(bad.length, 2);
    assert.match(bad.join("\n"), /на странице статьи нет ссылки/);
    assert.match(bad.join("\n"), /в Telegram-посте нет ссылки/);
    assert.equal(lib.crossPromoLine(articleUrl), `📖 Подробный разбор — в блоге: ${articleUrl}`);
  });
});

// =====================================================================
describe("validate.mjs: источники через shortcode", () => {
  const sb = box();
  const BRIEF = [
    "# Brief: src",
    "",
    ...["Тема", "Контекст", "Ключевые факты", "Проблема", "Результат", "Аудитория", "Заголовок", "Краткое описание", "Визуальные объекты", "Ограничения и неопределённости"].map((h) => `## ${h}\n\nтекст`),
    "",
  ].join("\n");
  const article = (body) => [
    "---",
    'title: "Источники и поиск"',
    'description: "Описание ровно в пятидесяти символах плюс немного запаса"',
    "date: 2026-11-11",
    "tags: [тест]",
    "draft: true",
    "slug: src-check",
    "image: cover.webp",
    "---",
    "",
    body,
    "",
  ].join("\n");
  const fixture = (id, body) => {
    const d = join(sb, "drafts", id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "brief.md"), BRIEF);
    writeFileSync(join(d, "article.md"), article(body));
    writeFileSync(join(d, "telegram.md"), "Просто живой текст заметки.");
  };

  test("голый заголовок ## Источники проваливает гейт", () => {
    fixture("srchead", "Текст статьи.\n\n## Источники\n\n- [Дока](https://example.com)\n");
    const r = run("validate.mjs", ["srchead"], sb);
    assert.equal(r.status, 1);
    assert.match(r.out, /FAIL\s+article\.md: источники через/);
    assert.match(r.out, /shortcode/);
    // варианты заголовка тоже ловятся: h3 и bold
    fixture("srch3", "Текст.\n\n### Источники\n\n- [Дока](https://example.com)\n");
    assert.equal(run("validate.mjs", ["srch3"], sb).status, 1);
    fixture("srcbold", "Текст.\n\n## **Источники**\n\n- [Дока](https://example.com)\n");
    assert.equal(run("validate.mjs", ["srcbold"], sb).status, 1);
  });

  test("упоминание заголовка внутри кодового блока — не заголовок", () => {
    fixture("srcfence", "Текст.\n\n```markdown\n## Источники\n```\n\nЕщё текст без внешних ссылок.\n");
    const r = run("validate.mjs", ["srcfence"], sb);
    assert.equal(r.status, 0, r.out);
  });

  test("shortcode проходит; статья без источников не затрагивается", () => {
    fixture("srcok", "Текст статьи.\n\n{{< sources >}}\n- [Дока](https://example.com)\n{{< /sources >}}\n");
    const r = run("validate.mjs", ["srcok"], sb);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PASS\s+article\.md: источники через/);
    fixture("srcnone", "Простой текст без внешних ссылок.");
    const r2 = run("validate.mjs", ["srcnone"], sb);
    assert.equal(r2.status, 0, r2.out);
  });
});

// =====================================================================
describe("hardening: фиксы по ревью PR #31 (Copilot)", () => {
  const sb = box();

  test("visibleCaption: сущности одним проходом, астральные — по UTF-16, переносы сохраняются", async () => {
    const { visibleCaption } = await import(join(SCRIPTS, "lib.mjs"));
    assert.equal(visibleCaption("<b>&#128512;</b>", "html"), "😀"); // у вызывающего .length = 2 unit
    assert.equal(visibleCaption("&amp;lt;", "html"), "&lt;"); // двойной декод исключён
    assert.equal(visibleCaption("a\n\n\n\nb", "html"), "a\n\n\n\nb"); // внутренние переносы Telegram считает как есть
    assert.equal(visibleCaption("a<br>b", "html"), "a\nb");
  });

  test("checkCrossLinks: пустое тело ответа = отсутствующая ссылка, не успех", async () => {
    const { checkCrossLinks } = await import(join(SCRIPTS, "lib.mjs"));
    assert.equal(checkCrossLinks({ articleHtml: "", telegramHtml: "", articleUrl: "https://kulikov.im/blog/x.html", telegramUrl: "https://t.me/c/5" }).length, 2);
    assert.equal(
      checkCrossLinks({ articleHtml: `<a href="https://t.me/c/5">x</a>`, telegramHtml: `смотри https://kulikov.im/blog/x.html подробнее`, articleUrl: "https://kulikov.im/blog/x.html", telegramUrl: "https://t.me/c/5" }).length,
      0,
    );
  });

  test("secrets: Telegram Bot API токен (env и URL) и регистронезависимые/JSON-пароли — high", () => {
    const token = `1234567890:AAE${"x".repeat(32)}`; // id + ровно 35 символов секрета
    const d = join(sb, "sec2");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "t.md"), `TELEGRAM_BOT_TOKEN=${token}\ncurl https://api.telegram.org/bot${token}/sendMessage\nPASSWORD=hunter2secret\n"password": "hunter2secret"\n`);
    const r = run("secrets-check.mjs", [d], sb);
    assert.equal(r.status, 1);
    const tg = (r.out.match(/telegram-bot-token/g) ?? []).length;
    const pw = (r.out.match(/password-assign/g) ?? []).length;
    assert.equal(tg, 2, "токен найден в обеих формах: env и URL");
    assert.equal(pw, 2, "PASSWORD= и \"password\": обе формы");
  });

  test("terms: «MTProto» не порождает кандидата MT (нет отката квантификера); коллизия алиаса отклоняется", () => {
    const reg = registry(sb);
    const res = spawnSync("node", [join(SCRIPTS, "terms.mjs"), "check", "-", "--registry", reg], {
      input: "Поднял MTProto и VPS, потом NAT.",
      encoding: "utf8", env: { ...process.env, EDITORIAL_TMP: sb },
    });
    assert.equal(res.status, 0, res.stderr);
    const j = JSON.parse(res.stdout);
    assert.ok(j.known.some((k) => k.term === "MTProto"));
    assert.ok(j.candidates.includes("NAT"));
    assert.ok(!j.candidates.includes("MT"), `MT не должен извлекаться из MTProto: ${JSON.stringify(j.candidates)}`);
    const dup = run("terms.mjs", ["confirm", "NAT", "--definition", "x", "--aliases", "SSH", "--registry", reg], sb);
    assert.equal(dup.status, 1);
    assert.match(dup.err, /уже есть в реестре/);
  });

  test("validate: пустой front matter проваливает гейт, а не пропускается молча", () => {
    const d = join(sb, "drafts", "emptyfm");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "brief.md"), "# Brief\n\n## Тема\n\nx\n"); // brief неполный — не важно, fm-фолт главный
    writeFileSync(join(d, "article.md"), "---\n---\n\nТекст без фронта.\n");
    writeFileSync(join(d, "telegram.md"), "Текст.");
    const r = run("validate.mjs", ["emptyfm"], sb);
    assert.equal(r.status, 1);
    assert.match(r.out, /FAIL\s+article\.md: front matter/);
    assert.match(r.out, /YAML-отображени/);
  });

  test("intake: отказ чистит за собой — повтор запуска обрабатывает архив; «./a.txt» == «a.txt» — дубль", () => {
    const dir = join(sb, "inbox");
    mkdirSync(dir, { recursive: true });
    // ./a.txt и a.txt распакуются в один файл — молчаливый overwrite недопустим
    py(`import zipfile; zf=zipfile.ZipFile(${JSON.stringify(join(dir, "dupdot.zip"))},"w"); zf.writestr("./a.txt","1"); zf.writestr("a.txt","2"); zf.close()`);
    const bad = run("intake.mjs", [join(dir, "dupdot.zip")], sb);
    assert.equal(bad.status, 1);
    assert.match(bad.err, /Дублирующиеся пути/);
    assert.ok(!existsSync(join(sb, "working/dupdot/archive")), "после отказа рабочего каталога распаковки быть не должно");
    // тот же id, хороший архив: повторный запуск обязан обработать, а не «пропустить»
    makeZip(sb, "dupdot.zip", { "note.txt": "факт" });
    const good = run("intake.mjs", [join(dir, "dupdot.zip")], sb);
    assert.equal(good.status, 0, good.err);
    assert.match(good.out, /Готово: tmp\/working\/dupdot/);
    assert.doesNotMatch(good.out, /пропуск/);
  });

  test("state: смена telegram_url сбрасывает подтверждения; crosspromo дедуп по опубликованному снимку", () => {
    run("intake.mjs", [makeZip(sb, "cp4.zip", { "n.txt": "x" })], sb);
    const sp = join(sb, "working/cp4/state.json");
    const st = JSON.parse(readFileSync(sp, "utf8"));
    st.article_url = "https://kulikov.im/blog/cp4.html";
    st.telegram_url = "https://t.me/homeinprod/5";
    st.checklist = { article_url_verified: true, telegram_url_verified: true, links_checked: true };
    writeFileSync(sp, JSON.stringify(st));
    const r = run("state.mjs", ["cp4", "set", "telegram_url=https://t.me/homeinprod/9"], sb);
    assert.equal(r.status, 0, r.err);
    const after = JSON.parse(readFileSync(sp, "utf8"));
    assert.equal(after.checklist.telegram_url_verified, false);
    assert.equal(after.checklist.links_checked, false);
    assert.equal(after.checklist.article_url_verified, true, "проверка статьи не зависит от поста");
    // ссылка была в черновике, но в ОПУБЛИКОВАННОМ снимке её нет → предложение формируется
    const dr = join(sb, "drafts/cp4");
    mkdirSync(dr, { recursive: true });
    writeFileSync(join(dr, "telegram.md"), "Черновок со ссылкой https://kulikov.im/blog/cp4.html внутри.");
    writeFileSync(join(dr, "telegram-final.md"), "Опубликованный текст без ссылки.");
    const cp = run("state.mjs", ["cp4", "crosspromo"], sb);
    assert.equal(cp.status, 0, cp.err);
    assert.doesNotMatch(cp.out, /уже есть/);
    assert.ok(existsSync(join(dr, "crosspromo.md")), "предложение записано");
  });

  test("images: check --json реально печатает JSON (флаг, а не опция со значением)", () => {
    const img = join(sb, "drafts/js/images");
    [1, 2, 3].forEach((n) => {
      const c = join(img, `concept-0${n}`);
      mkdirSync(c, { recursive: true });
      writeFileSync(join(c, "telegram.png"), pngHdr(1024, 1024));
      writeFileSync(join(c, "blog-cover.webp"), webpHdr(1280, 720));
      writeFileSync(join(c, "blog-preview.webp"), webpHdr(800, 450));
      writeFileSync(join(c, "prompt.md"), "p");
    });
    const r = run("images.mjs", ["check", img, "--json"], sb);
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out.trim());
    assert.equal(j.ok, true);
    assert.ok(j.concepts["concept-01"]);
  });
});
