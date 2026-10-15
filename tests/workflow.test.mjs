// Guards for the CI setup: PRs are tested, deploys only happen from trusted refs, actions are pinned.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ROOT } from "./helpers/paths.mjs";

const WF = join(ROOT, ".github/workflows");
const workflows = Object.fromEntries(readdirSync(WF).map((f) => [f, YAML.parse(readFileSync(join(WF, f), "utf8"))]));
const actionFiles = () => (existsSync(join(ROOT, ".github/actions")) ? readdirSync(join(ROOT, ".github/actions")).map((d) => join(ROOT, ".github/actions", d, "action.yml")) : []);
const ci = workflows["ci.yaml"];
const steps = (j) => j.steps ?? [];

test("a single CI workflow exists", () => assert.deepEqual(Object.keys(workflows), ["ci.yaml"]));

describe("triggers", () => {
  test("runs on pull_request, push to main, manual and scheduled runs", () => {
    const on = ci.on;
    assert.ok("pull_request" in on, "tests must run on PRs");
    assert.deepEqual(on.push.branches, ["main"]);
    assert.ok("workflow_dispatch" in on);
    assert.ok(on.schedule?.length, "scheduled rebuild keeps the footer year (rendered at build time) fresh");
  });
});

describe("jobs", () => {
  test("check job runs the tests and has read-only permissions", () => {
    assert.ok(steps(ci.jobs.check).some((s) => /\bnpm test\b/.test(s.run ?? "")));
    assert.deepEqual(ci.jobs.check.permissions, { contents: "read" });
  });
  test("deploy job never runs for pull requests and needs a green check", () => {
    const d = ci.jobs.deploy;
    assert.deepEqual([d.needs].flat(), ["check"]);
    assert.match(d.if, /github\.event_name != 'pull_request'/);
    assert.ok(d.permissions.pages === "write" && d.permissions["id-token"] === "write");
  });
  test("write permissions: deploy (Pages) and the Lighthouse job (pull request comment only); workflow default is least privilege", () => {
    assert.ok(ci.permissions === undefined || JSON.stringify(ci.permissions) === "{}");
    assert.deepEqual(ci.jobs.lighthouse.permissions, { contents: "read", "pull-requests": "write" });
    for (const [n, j] of Object.entries(ci.jobs)) if (n !== "deploy" && n !== "lighthouse") assert.ok(!Object.values(j.permissions ?? {}).includes("write"), n);
  });
  test("every job has a timeout", () => {
    for (const [n, j] of Object.entries(ci.jobs)) assert.ok(j["timeout-minutes"] > 0, n);
  });
  test("deploys are serialized and never cancelled mid-flight", () => {
    assert.deepEqual(ci.jobs.deploy.concurrency, { group: "pages", "cancel-in-progress": false });
  });
});

describe("supply chain", () => {
  const uses = () => [...Object.values(ci.jobs).flatMap(steps), ...actionFiles().flatMap((f) => steps(YAML.parse(readFileSync(f, "utf8")).runs))].map((s) => s.uses).filter(Boolean);
  test("every third-party action is pinned to a full commit SHA", () => {
    const u = uses();
    assert.ok(u.length > 5);
    for (const a of u.filter((x) => !x.startsWith("./"))) assert.match(a, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, a);
  });
  test("the deploy checks out the full history so .GitInfo (footer, sitemap lastmod) is per page", () => {
    const co = ci.jobs.deploy.steps.find((x) => x.uses?.startsWith("actions/checkout@"));
    assert.equal(co.with?.["fetch-depth"], 0);
  });
  test("the deploy build tells the footer which commit it was built from", () => {
    const b = ci.jobs.deploy.steps.find((x) => x.name === "Build");
    assert.equal(b.env.HUGO_BUILD_SHA, "${{ github.sha }}");
    assert.match(b.run, /HUGO_BUILD_DATE/);
  });
  test("coverage is generated in the check job and uploaded to Codecov with the repository secret (a failed upload does not block)", () => {
    const steps = ci.jobs.check.steps;
    assert.ok(steps.some((x) => x.run === "npm run test:coverage"));
    const up = steps.find((x) => x.uses?.startsWith("codecov/codecov-action@"));
    assert.equal(up.with.token, "${{ secrets.CODECOV_TOKEN }}");
    assert.equal(up.with.files, "build/coverage/lcov.info");
    assert.equal(up.with["fail_ci_if_error"], false);
  });
  test("Lighthouse runs in its own read-only job next to check and does not gate the deploy", () => {
    const l = ci.jobs.lighthouse;
    assert.ok(steps(l).some((x) => x.run === "npm run lighthouse"));
    const up = steps(l).find((x) => x.uses?.startsWith("actions/upload-artifact@"));
    assert.equal(up.with.path, "build/lighthouse", "the HTML reports are kept as an artifact");
    assert.ok(steps(l).some((x) => /lighthouse-summary/.test(x.run ?? "")), "the results comment is updated in place");
    assert.match(steps(l).find((x) => x.name === "Comment on the pull request").if, /head\.repo\.full_name == github\.repository/, "not for forks: their token cannot write");
    assert.equal(l.needs, undefined);
    assert.deepEqual([ci.jobs.deploy.needs].flat(), ["check"]);
  });
  test("runners are pinned to an OS version, not a moving *-latest label", () => {
    for (const [name, job] of Object.entries(ci.jobs)) assert.match(job["runs-on"], /^ubuntu-\d+\.\d+$/, name);
  });
  test("dependabot keeps actions and npm packages up to date", () => {
    const d = YAML.parse(readFileSync(join(ROOT, ".github/dependabot.yml"), "utf8"));
    assert.deepEqual(d.updates.map((u) => u["package-ecosystem"]).sort(), ["github-actions", "npm"]);
  });
  test("the Hugo download is verified against the published checksums", () => {
    const f = actionFiles().map((p) => readFileSync(p, "utf8")).join("\n");
    assert.match(f, /sha256sum -c/);
  });
});

describe("tool versions are pinned in one place each", () => {
  test(".hugo-version is a plain semver and CI reads it", () => {
    assert.match(readFileSync(join(ROOT, ".hugo-version"), "utf8").trim(), /^\d+\.\d+\.\d+$/);
    assert.match(actionFiles().map((p) => readFileSync(p, "utf8")).join("\n"), /\.hugo-version/);
  });
  test(".nvmrc major satisfies package.json engines", () => {
    const major = +readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
    const eng = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).engines.node;
    assert.equal(eng, `>=${major}`);
  });
  test("module.yml hugoVersion.min is not newer than .hugo-version", () => {
    const min = YAML.parse(readFileSync(join(ROOT, "config/_default/module.yml"), "utf8")).hugoVersion.min;
    const cur = readFileSync(join(ROOT, ".hugo-version"), "utf8").trim();
    const n = (v) => v.split(".").map(Number).reduce((a, x) => a * 1000 + x, 0);
    assert.ok(n(min) <= n(cur), `${min} > ${cur}`);
  });
});
