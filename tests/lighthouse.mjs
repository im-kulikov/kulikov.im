// Lighthouse on the built site (build/test-site, run `npm test` or `node tests/build.mjs` first).
// One Chrome serves all runs, the site is served gzipped from a local server, throttling is Lighthouse's default simulation.
// Fails when a score or a metric crosses its budget. Local numbers differ from the live site (no CDN, no HTTP/2), so the budgets keep a margin.
import { createServer } from "node:http";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";
import { ROOT, SITE } from "./helpers/paths.mjs";

const MARKER = "<!-- lighthouse-summary -->"; // finds our comment again on the next push
const REPORTS = join(ROOT, "build", "lighthouse"); // full HTML reports, one per page (CI uploads the folder)
// every built page except the 404s and Hugo alias redirects (home pages as "/", "/en/"); a new page is covered without touching this file
const PAGES = readdirSync(SITE, { recursive: true })
  .filter(
    (f) =>
      f.endsWith(".html") &&
      basename(f) !== "404.html" &&
      !readFileSync(join(SITE, f), "utf8").includes("http-equiv=refresh"),
  )
  .map((f) => "/" + f.replace(/index\.html$/, ""))
  .sort();
const SCORES = {
  performance: 0.95,
  accessibility: 1,
  "best-practices": 0.95,
  seo: 1,
};
const METRICS = {
  "largest-contentful-paint": ["LCP", 2500],
  "total-blocking-time": ["TBT", 200],
  "cumulative-layout-shift": ["CLS", 0.1],
}; // ms (CLS: unitless)
const RUNS = 3; // successful runs per page; budgets are checked against their median (not best-of-N)
const MAX_ATTEMPTS = 5; // hard cap: extra attempts only for infrastructure errors (interstitial, no metrics), never for budget misses
const QUIET = {
  pauseAfterLoadMs: 250,
  networkQuietThresholdMs: 250,
  cpuQuietThresholdMs: 250,
}; // default is 1-2 s of waiting per run
const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  try {
    let body = await readFile(join(SITE, path));
    const type = TYPES[extname(path)] ?? "application/octet-stream";
    res.setHeader("content-type", type);
    if (
      /^(text|application\/(json|xml))|svg/.test(type) &&
      /gzip/.test(req.headers["accept-encoding"] ?? "")
    ) {
      res.setHeader("content-encoding", "gzip");
      body = gzipSync(body);
    }
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((ok) => server.listen(0, ok));
const origin = `http://localhost:${server.address().port}`;

const started = Date.now();
const chrome = await launch({
  chromeFlags: ["--headless=new", "--no-sandbox"],
  chromePath: process.env.CHROME_PATH,
});
// Best Practices: the `third-party-cookies` audit is skipped — Yandex.Metrika sets its own
// cookies by design (`yandexuid`, `yabs-sid`, `sync_cookie_csrf`, ... from mc.yandex.ru in the
// watch/tag.js responses), so this audit is deterministically red on CI runners while the
// counter is enabled. This is an accepted owner trade-off, NOT a fix of the underlying issue.
// All other Best Practices audits (CSP/XSS, console errors, deprecations, ...) stay active.
// Revisit this exclusion if the analytics integration changes (different vendor or a cookieless mode).
const SKIP_AUDITS = ["third-party-cookies"];
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
// infrastructure error = the page did not actually load (Chrome interstitial, missing metrics);
// budget misses are measurement results and must never trigger a retry
const infraError = (lhr) =>
  lhr.runtimeError?.message ||
  Object.values(lhr.audits).some((a) => a.scoreDisplayMode === "error");
const value = (lhr, id) => lhr.audits[id].numericValue;
const metricCell = (label, v) =>
  label === "CLS" ? Math.round(v * 1000) / 1000 : Math.round(v);

const failures = [];
const rows = [];
mkdirSync(REPORTS, { recursive: true });
try {
  for (const page of PAGES) {
    const runs = [];
    let attempts = 0;
    let lastReport = "";
    while (runs.length < RUNS && attempts < MAX_ATTEMPTS) {
      attempts++;
      const result = await lighthouse(origin + page, {
        port: chrome.port,
        logLevel: "error",
        output: "html",
        onlyCategories: Object.keys(SCORES),
        skipAudits: SKIP_AUDITS,
        ...QUIET,
      });
      if (infraError(result.lhr)) continue;
      runs.push(result.lhr);
      lastReport = result.report; // HTML report of the last successful run (all runs' values go to the table)
    }
    const name =
      page
        .replace(/^\/|\.html$/g, "")
        .replace(/\/$/, "")
        .replaceAll("/", "-") || "home";
    if (runs.length < RUNS) {
      failures.push(
        `${page}: only ${runs.length}/${RUNS} valid runs in ${attempts} attempts (infrastructure errors)`,
      );
      continue;
    }
    const last = { report: lastReport }; // keeps the summary/write block unchanged in shape
    // budgets apply to the median of the RUNS runs; maxima are reported for diagnostics (spike visibility)
    failures.push(
      ...Object.entries(SCORES)
        .filter(
          ([c, min]) => median(runs.map((l) => l.categories[c].score)) < min,
        )
        .map(
          ([c, min]) =>
            `${page}: ${c} median ${median(runs.map((l) => l.categories[c].score))} < ${min}`,
        ),
      ...Object.entries(METRICS)
        .filter(([id, [, max]]) => median(runs.map((l) => value(l, id))) > max)
        .map(
          ([id, [label, max]]) =>
            `${page}: ${label} median ${Math.round(median(runs.map((l) => value(l, id))))} > ${max}`,
        ),
    );
    const med = (id) => median(runs.map((l) => value(l, id)));
    const cells = [
      ...Object.keys(SCORES).map((c) =>
        Math.round(median(runs.map((l) => l.categories[c].score)) * 100),
      ),
      ...Object.entries(METRICS).map(([id, [label]]) =>
        metricCell(label, med(id)),
      ),
    ];
    const maxima = [
      `max LCP ${Math.round(Math.max(...runs.map((l) => value(l, "largest-contentful-paint"))))}`,
      `max TBT ${Math.round(Math.max(...runs.map((l) => value(l, "total-blocking-time"))))}`,
    ];
    writeFileSync(join(REPORTS, `${name}.html`), last.report);
    const runDetail = runs
      .map(
        (l) =>
          `LCP ${Math.round(value(l, "largest-contentful-paint"))}/TBT ${Math.round(value(l, "total-blocking-time"))}`,
      )
      .join(", ");
    rows.push(
      `| ${page} | ${cells.join(" | ")} | ${maxima.join(", ")} (${runs.length} runs: ${runDetail}) |`,
    );
    console.log(
      `${page.padEnd(20)} ${cells.join(" | ")}  ${maxima.join(", ")}  [${runDetail}]`,
    );
  }
} finally {
  await chrome.kill();
  server.close();
}
console.log(
  `${PAGES.length} pages in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
// the table: job summary page (GITHUB_STEP_SUMMARY) and build/lighthouse/summary.md (CI posts it as a pull request comment)
const head = [
  "Page",
  ...Object.keys(SCORES),
  ...Object.values(METRICS).map(([label]) => label),
  "Runs (medians gate the budgets; maxima show spikes)",
];
const budget = [
  "budget (median of 3 runs)",
  ...Object.values(SCORES).map((v) => `≥ ${v * 100}`),
  ...Object.values(METRICS).map(([, max]) => `≤ ${max}`),
  "",
];
const {
  GITHUB_SERVER_URL: host,
  GITHUB_REPOSITORY: repo,
  GITHUB_RUN_ID: run,
  GITHUB_STEP_SUMMARY: summary,
} = process.env;
const md = [
  "### Lighthouse",
  "",
  `| ${head.join(" | ")} |`,
  `|${head.map(() => " --- ").join("|")}|`,
  ...rows,
  `| ${budget.join(" | ")} |`,
  "",
  failures.length
    ? `**Over budget:**\n${failures.map((f) => `- ${f}`).join("\n")}`
    : "Within budget.",
  ...(run
    ? [
        "",
        `Full reports: artifact \`lighthouse-reports\` of [this run](${host}/${repo}/actions/runs/${run}).`,
      ]
    : []),
  "",
].join("\n");
writeFileSync(join(REPORTS, "summary.md"), MARKER + "\n" + md);
if (summary) appendFileSync(summary, md);
if (failures.length) {
  console.error(`\nLighthouse budgets exceeded:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
