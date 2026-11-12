import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, ROOT } from "./paths.mjs";

export const HUGO = process.env.HUGO_BIN || "hugo";
// the commit the footer reports (CI's deploy sets the same variables from the event)
const git = (...a) => spawnSync("git", a, { cwd: ROOT, encoding: "utf8" }).stdout.trim();
export const BUILD_SHA = git("rev-parse", "HEAD");

// Production build exactly like CI. --panicOnWarning turns any template/config warning
// (deprecations included) into a failed build. Returns the log and the generated hugo_stats.json.
// extraArgs (e.g. ["--buildDrafts"]) lets tests reproduce the dev preview build;
// opts.cwd builds an isolated copy of the project — hugo_stats.json is snapshotted and
// restored for THAT copy, so parallel test builds never race over ROOT's tracked file.
export function buildSite(dest, environment = "production", extraArgs = [], opts = {}) {
  const cwd = opts.cwd ?? ROOT;
  const stats = join(cwd, "hugo_stats.json");
  const before = existsSync(stats) ? readFileSync(stats, "utf8") : null;
  try {
    const r = spawnSync(HUGO, ["--gc", "--minify", "--panicOnWarning", ...extraArgs, "--baseURL", `${BASE}/`, "--destination", dest], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HUGO_ENVIRONMENT: environment, HUGO_BUILD_SHA: BUILD_SHA, HUGO_BUILD_DATE: git("show", "-s", "--format=%cI", "HEAD"), TZ: "Europe/Moscow" },
    });
    return { status: r.status, error: r.error, log: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, stats: existsSync(stats) ? readFileSync(stats, "utf8") : "" };
  } finally {
    if (before !== null) writeFileSync(stats, before); // Hugo rewrites the file on every build; keep the tree clean
  }
}
