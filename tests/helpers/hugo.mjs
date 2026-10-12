import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, ROOT } from "./paths.mjs";

export const HUGO = process.env.HUGO_BIN || "hugo";
const STATS = join(ROOT, "hugo_stats.json");

// Production build exactly like CI. --panicOnWarning turns any template/config warning
// (deprecations included) into a failed build. Returns the log and the generated hugo_stats.json.
export function buildSite(dest) {
  const before = readFileSync(STATS, "utf8");
  try {
    const r = spawnSync(HUGO, ["--gc", "--minify", "--panicOnWarning", "--baseURL", `${BASE}/`, "--destination", dest], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, HUGO_ENVIRONMENT: "production", TZ: "Europe/Moscow" },
    });
    return { status: r.status, error: r.error, log: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, stats: readFileSync(STATS, "utf8") };
  } finally {
    writeFileSync(STATS, before); // Hugo rewrites the tracked file on every build; keep the tree clean
  }
}
