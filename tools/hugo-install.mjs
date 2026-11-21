// Installs the Hugo binary pinned in .hugo-version into tmp/bin/hugo, verified
// against the release checksums — the same artifact CI installs (see
// .github/actions/setup). One command after a version bump:
//   npm run hugo:install
// Re-download even when the version already matches: npm run hugo:install -- --force
// Tests and scripts resolve this binary automatically (tests/helpers/hugo.mjs).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = readFileSync(join(ROOT, ".hugo-version"), "utf8").trim();
const bin = join(ROOT, "tmp", "bin", "hugo");

// Staging area for download + extraction; fail() wipes it so an aborted run
// never leaves a half-installed binary or stray temp dirs behind.
const stage = join(ROOT, "tmp", "bin", `.hugo-${process.pid}`);
const fail = (msg) => {
  rmSync(stage, { recursive: true, force: true });
  console.error(msg);
  process.exit(1);
};

const os = { darwin: "darwin", linux: "linux" }[process.platform];
const cpu = { arm64: "arm64", x64: "amd64" }[process.arch];
if (!os || !cpu) fail(`unsupported platform: ${process.platform}-${process.arch}`);
// macOS ships a single universal installer, no per-arch archives.
const archive =
  os === "darwin"
    ? `hugo_${version}_darwin-universal.pkg`
    : `hugo_${version}_${os}-${cpu}.tar.gz`;

// Already the pinned version? — skip the download.
if (!process.argv.includes("--force")) {
  const out = spawnSync(bin, ["version"], { encoding: "utf8" });
  if (out.status === 0 && out.stdout.includes(`hugo v${version}`)) {
    console.log(`tmp/bin/hugo is already Hugo ${version} — nothing to do.`);
    process.exit(0);
  }
}

const base = `https://github.com/gohugoio/hugo/releases/download/v${version}`;
console.log(`downloading ${archive} …`);

try {
  const [installer, checksums] = await Promise.all([
    fetch(`${base}/${archive}`),
    fetch(`${base}/hugo_${version}_checksums.txt`),
  ]);
  for (const r of [installer, checksums]) if (!r.ok) fail(`${r.status} ${r.url}`);
  const [pkgBuf, list] = await Promise.all([
    installer.arrayBuffer(),
    checksums.text(),
  ]);

  const digest = createHash("sha256").update(new Uint8Array(pkgBuf)).digest("hex");
  const expected = list
    .split("\n")
    .find((l) => l.trimEnd().endsWith(` ${archive}`));
  if (!expected || !expected.startsWith(digest))
    fail(`checksum mismatch for ${archive} (got ${digest})`);

  // Stage in tmp/, then move into place — a failed run never leaves a
  // half-installed binary.
  mkdirSync(stage, { recursive: true });
  const tmpPkg = join(stage, archive);
  writeFileSync(tmpPkg, new Uint8Array(pkgBuf));

  // The darwin .pkg is an xar archive with an inner Payload; pkgutil unpacks
  // both (and requires a fresh destination). Linux tar.gz archives simply
  // contain the hugo binary.
  const extract =
    os === "darwin"
      ? spawnSync("pkgutil", ["--expand-full", tmpPkg, join(stage, "expanded")], {
          encoding: "utf8",
        })
      : spawnSync("tar", ["-xzf", tmpPkg, "-C", stage, "hugo"], {
          encoding: "utf8",
        });
  if (extract.status !== 0) fail(`extract failed: ${extract.stderr}`);

  let binary = join(stage, "hugo");
  if (os === "darwin") {
    const found = spawnSync(
      "find",
      [stage, "-type", "f", "-name", "hugo", "-path", "*Payload*"],
      { encoding: "utf8" },
    );
    const candidates = found.stdout.trim().split("\n").filter(Boolean);
    if (candidates.length === 0)
      fail(`no hugo binary in ${archive} payload`);
    binary = candidates[0];
  }
  chmodSync(binary, 0o755);
  renameSync(binary, bin);
  rmSync(stage, { recursive: true, force: true });
} catch (e) {
  fail(e.message ?? e);
}

console.log(spawnSync(bin, ["version"], { encoding: "utf8" }).stdout.trim());
