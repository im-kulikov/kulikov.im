// Lighthouse on the built site (build/test-site, run `npm test` or `node tests/build.mjs` first).
// One Chrome serves all runs, the site is served gzipped from a local server, throttling is Lighthouse's default simulation.
// Fails when a score or a metric crosses its budget. Local numbers differ from the live site (no CDN, no HTTP/2), so the budgets keep a margin.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";
import { SITE } from "./helpers/paths.mjs";

const PAGES = ["/", "/en/", "/services.html", "/projects.html"];
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
try {
  for (const page of PAGES) {
    const { lhr } = await lighthouse(origin + page, {
      port: chrome.port,
      logLevel: "error",
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
    console.log(`${page.padEnd(16)} ${line.join(" | ")}`);
  }
} finally {
  await chrome.kill();
  server.close();
}
console.log(
  `${PAGES.length} pages in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
if (failures.length) {
  console.error(`\nLighthouse budgets exceeded:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
