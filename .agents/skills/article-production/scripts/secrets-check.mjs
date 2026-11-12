#!/usr/bin/env node
// Pre-publication проверка конфиденциальных данных. Исходники НЕ изменяет (read-only):
// публикуемые копии очищает автор/агент в tmp/drafts/<id>/, исходный архив неприкосновенен.
//
//   node .agents/skills/article-production/scripts/secrets-check.mjs <path…> [--baseline <file>] [--strict] [--json]
//
// Severity: high (ключи/токены/пароли/URL с кредами — блокирует, exit 1),
//           warn (приватные IP, session/cookie, e-mail, внутренние hostnames),
//           info (loopback/localhost — норма для примеров).
// --baseline: файл со строками вида «относительный-путь:строка:severity» — находки,
//             одобренные на ручном review, не блокируют (след ревью остаётся).
// Автоматика не заменяет ручной review; при наличии gitleaks он подключается отдельно.
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

const SKIP_EXT = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".zip", ".gz", ".tgz", ".webm", ".mp4", ".pdf"]);
const DOC_RANGES = /\b(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}\b/g; // RFC 5737 — диапазоны для примеров в статьях

const RULES = [
  { id: "ssh-private-key", sev: "high", re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/ },
  { id: "github-token", sev: "high", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b|github_pat_[A-Za-z0-9_]{20,}/ },
  { id: "aws-key", sev: "high", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "google-api-key", sev: "high", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { id: "openai/slack/gitlab-token", sev: "high", re: /\bsk-[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[\w-]{10,}\b|\bglpat-[\w-]{15,}\b/ },
  { id: "bearer-token", sev: "high", re: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}\b/ },
  // Telegram Bot API: «<bot_id>:<35-символьный секрет>» — ловит и TELEGRAM_BOT_TOKEN=…,
  // и api.telegram.org/bot<id>:<secret>/… (в URL цифры прилегают к «bot», \b там нет)
  { id: "telegram-bot-token", sev: "high", re: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![\w-])/ },
  // ключ регистронезависим (PASSWORD=, ApiKey=) и может закрываться кавычкой JSON ("password": "…")
  { id: "password-assign", sev: "high", re: /\b(pass(word)?|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?[^\s"'#]{6,}/i },
  { id: "url-with-credentials", sev: "high", re: /https?:\/\/[^\s\/@:]+:[^\s@\/]+@[^\s]+/ },
  { id: "session-cookie", sev: "warn", re: /\b(sessionid|session_id|phpsessid|jsessionid|csrf[_-]?token|set-cookie)\b\s*[=:]/i },
  { id: "private-ipv4", sev: "warn", re: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/ },
  { id: "internal-hostname", sev: "warn", re: /\b[\w-]+\.(local|internal|lan|home|corp)\b(?![\w-])/i }, // «www.home» из home-assistant.io не считается
  { id: "email", sev: "warn", re: /\b[\w.+-]+@(?!:?\d{1,3}\.\d{1,3}\.\d{1,3}\.|\[)[\w-]+\.(?!example\b)[\w.-]+\b/ }, // *@example.* — шаблон; user@IP (SSH) — не email
  { id: "loopback", sev: "info", re: /\b(127\.0\.0\.1|localhost)\b/ },
];

const args = process.argv.slice(2);
const paths = args.filter((a) => !a.startsWith("--"));
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const strict = args.includes("--strict");
const asJson = args.includes("--json");
if (!paths.length) {
  console.error("usage: secrets-check.mjs <path…> [--baseline <file>] [--strict] [--json]");
  process.exit(2);
}
const baseline = opt("baseline") && existsSync(opt("baseline")) ? new Set(readFileSync(opt("baseline"), "utf8").split("\n").map((l) => l.trim()).filter(Boolean)) : new Set();

const displayPath = (p) => {
  const rel = relative(process.cwd(), p);
  return rel.startsWith("..") ? p : rel;
};
const findings = [];
async function walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) await walk(join(p, e));
    return;
  }
  if (SKIP_EXT.has(extname(p).toLowerCase())) return;
  if (st.size > 8 * 1024 * 1024) {
    console.error(`WARN  ${displayPath(p)}: файл > 8 МБ пропущен сканером — большие логи проверяй вручную`);
    return;
  }
  if (readFileSync(p).subarray(0, 1024).includes(0)) return; // бинарный файл
  const lines = createInterface({ input: createReadStream(p, "utf8") });
  let no = 0;
  for await (const line of lines) {
    no++;
    for (const rule of RULES) {
      // документационные IP (RFC 5737) вырезаем из строки, а не пропускаем строку целиком:
      // настоящий приватный IP в той же строке должен быть найден
      const scanLine = rule.id === "private-ipv4" ? line.replace(DOC_RANGES, " ") : line;
      const m = rule.re.exec(scanLine);
      if (m) findings.push({ file: displayPath(p), line: no, sev: rule.sev, id: rule.id, sample: m[0].slice(0, 60) });
    }
  }
}
for (const p of paths) await walk(resolve(p));

if (asJson) console.log(JSON.stringify(findings, null, 2));
else findings.forEach((f) => console.log(`${f.sev.toUpperCase().padEnd(4)} ${f.file}:${f.line} [${f.id}] ${f.sample}`));

const allowed = (f) => !baseline.has(`${f.file}:${f.line}:${f.sev}`);
const blocking = findings.filter((f) => f.sev === "high" && allowed(f));
const warns = findings.filter((f) => f.sev === "warn" && allowed(f));
console.error(`\nИтог: high=${blocking.length}, warn=${warns.length}, info=${findings.length - blocking.length - warns.length}. Исходники не изменялись.`);
if (blocking.length) {
  console.error("HIGH-находки блокируют публикацию. Удали секреты из публикуемой копии (не из архива!) и повтори.");
  process.exit(1);
}
if (strict && warns.length) {
  console.error("--strict: warn-находки тоже блокируют (или заведи baseline после ревью).");
  process.exit(1);
}
process.exit(0);
