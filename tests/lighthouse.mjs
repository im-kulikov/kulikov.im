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
const failures = [];
const rows = [];
mkdirSync(REPORTS, { recursive: true });
try {
  for (const page of PAGES) {
    const { lhr, report } = await lighthouse(origin + page, {
      port: chrome.port,
      logLevel: "error",
      output: "html",
      onlyCategories: Object.keys(SCORES),
      ...QUIET,
    });
    const line = Object.keys(SCORES).map(
      (c) => `${c} ${Math.round(lhr.categories[c].score * 100)}`,
    );
    for (const [c, min] of Object.entries(SCORES))
      if (lhr.categories[c].score < min)
        failures.push(`${page}: ${c} ${lhr.categories[c].score} < ${min}`);
    for (const [id, [label, max]] of Object.entries(METRICS)) {
      const v = lhr.audits[id].numericValue;
      line.push(`${label} ${Math.round(v * 1000) / 1000}`);
      if (v > max) failures.push(`${page}: ${label} ${v} > ${max}`);
    }
    writeFileSync(
      join(
        REPORTS,
        `${
          page
            .replace(/^\/|\.html$/g, "")
            .replace(/\/$/, "")
            .replaceAll("/", "-") || "home"
        }.html`,
      ),
      report,
    );
    rows.push(
      `| ${page} | ${[...Object.keys(SCORES).map((c) => Math.round(lhr.categories[c].score * 100)), ...Object.keys(METRICS).map((id) => Math.round(lhr.audits[id].numericValue * 1000) / 1000)].join(" | ")} |`,
    );
    console.log(`${page.padEnd(16)} ${line.join(" | ")}`);
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
];
const budget = [
  "budget",
  ...Object.values(SCORES).map((v) => `≥ ${v * 100}`),
  ...Object.values(METRICS).map(([, max]) => `≤ ${max}`),
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
