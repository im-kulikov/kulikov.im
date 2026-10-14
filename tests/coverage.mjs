// JS coverage of src/assets/js: builds the site unminified with an inline source map (Hugo environment "coverage"),
// runs the browser tests against it with V8 coverage on, and writes build/coverage/lcov.info (uploaded to Codecov by CI).
// Hugo templates, YAML and CSS have no line coverage; their checks are the tests in tests/*.test.mjs.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import v8toIstanbul from "v8-to-istanbul";
import { buildSite } from "./helpers/hugo.mjs";
import { ROOT } from "./helpers/paths.mjs";

const SITE = join(ROOT, "build", "coverage-site");
const OUT = join(ROOT, "build", "coverage");
const SOURCE = "src/assets/js/main.js"; // the bundle contains exactly this file (no plugin scripts)

rmSync(SITE, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
const built = buildSite(SITE, "coverage");
if (built.status !== 0) {
  console.error(built.error ?? built.log);
  process.exit(1);
}

const e2e = spawnSync("node", ["--test", "tests/e2e/layout.e2e.mjs"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, SITE_DIR: SITE, COVERAGE: "1" } });
if (e2e.status !== 0) process.exit(e2e.status ?? 1);

const bundle = readFileSync(join(SITE, "js", "script.js"), "utf8");
const [, b64] = bundle.match(/sourceMappingURL=data:application\/json;base64,(.+)$/m);
const map = JSON.parse(Buffer.from(b64, "base64").toString());
const code = bundle.replace(/\n\/\/# sourceMappingURL=.*$/m, "");
const total = {}; // statement id -> best hit count over all pages (applyCoverage overwrites, it does not add up)
let statements;
for (const entry of JSON.parse(readFileSync(join(OUT, "v8.json"), "utf8"))) {
  const conv = v8toIstanbul(join(ROOT, SOURCE), 0, { source: code, originalSource: map.sourcesContent[0], sourceMap: { sourcemap: { ...map, sources: ["main.js"], sourceRoot: "" } } });
  await conv.load();
  conv.applyCoverage(entry.functions);
  const [file] = Object.values(conv.toIstanbul());
  statements = file.statementMap;
  for (const [id, n] of Object.entries(file.s)) total[id] = Math.max(total[id] ?? 0, n);
}

const hits = new Map(); // line -> hits (a line counts as hit if any statement starting on it ran)
for (const [id, { start }] of Object.entries(statements)) hits.set(start.line, Math.max(hits.get(start.line) ?? 0, total[id]));
const lines = [...hits].sort((a, b) => a[0] - b[0]);
const lcov = ["TN:", `SF:${SOURCE}`, ...lines.map(([l, n]) => `DA:${l},${n}`), `LF:${lines.length}`, `LH:${lines.filter(([, n]) => n > 0).length}`, "end_of_record", ""].join("\n");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "lcov.info"), lcov);
const missed = lines.filter(([, n]) => n === 0).map(([l]) => l);
console.log(`JS coverage ${SOURCE}: ${lines.length - missed.length}/${lines.length} lines${missed.length ? `, not run: ${missed.join(", ")}` : ""}`);
