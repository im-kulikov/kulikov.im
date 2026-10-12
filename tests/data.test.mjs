// Schema checks for the YAML content blocks that feed the partials in src/layouts/partials/blocks.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import { ROOT } from "./helpers/paths.mjs";

const CONTENT = join(ROOT, "src/content");
const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
const ymls = files(CONTENT).filter((f) => f.endsWith(".yml"));
const load = (f) => YAML.parse(readFileSync(f, "utf8").replace(/^---\s*\n/, ""));
const data = Object.fromEntries(ymls.map((f) => [relative(CONTENT, f), load(f)]));
const str = (v) => typeof v === "string" && v.trim().length > 0;
const need = (o, keys, where) => keys.forEach((k) => assert.ok(str(o?.[k]), `${where}: "${k}" must be a non-empty string`));
const list = (v, where) => (assert.ok(Array.isArray(v) && v.length > 0, `${where}: non-empty list expected`), v);

function* deep(v, path = "") {
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { yield [k, x, `${path}/${k}`]; yield* deep(x, `${path}/${k}`); }
}

test("every YAML data file was found and parsed", () => {
  assert.deepEqual(Object.keys(data).sort(), ["about/about.yml", "about/help.yml", "features.yml", "hobbies/hobbies.yml", "resume/profile.yml", "resume/projects.yml", "services/services.yml"]);
});

describe("references", () => {
  test("every `icon` has src/assets/svg/<icon>.svg", () => {
    let n = 0;
    for (const [f, d] of Object.entries(data)) for (const [k, v, p] of deep(d)) if (k === "icon") { n++; assert.ok(existsSync(join(ROOT, "src/assets/svg", `${v}.svg`)), `${f}${p}: ${v}`); }
    assert.ok(n > 0);
  });
  test("every `image` exists in src/assets", () => {
    let n = 0;
    for (const [f, d] of Object.entries(data)) for (const [k, v, p] of deep(d)) if (k === "image") { n++; assert.ok(existsSync(join(ROOT, "src/assets", v)), `${f}${p}: ${v}`); }
    assert.ok(n > 0);
  });
  test("external `url`/`link` values are https", () => {
    for (const [f, d] of Object.entries(data)) for (const [k, v, p] of deep(d)) if ((k === "url" || k === "link") && /^https?:/.test(v)) assert.match(v, /^https:\/\//, `${f}${p}`);
  });
  test("features: internal button links point to an existing page", () => {
    for (const [i, it] of data["features.yml"].entries()) if (it.button?.enable && !/^https?:/.test(it.button.link)) assert.ok(existsSync(join(CONTENT, it.button.link)), `features[${i}].button.link=${it.button.link}`);
  });
});

describe("block schemas", () => {
  test("features.yml", () => {
    for (const [i, it] of list(data["features.yml"], "features").entries()) {
      need(it, ["title", "image", "content"], `features[${i}]`);
      list(it.bullets, `features[${i}].bullets`).forEach((b) => assert.ok(str(b)));
    }
  });
  test("about.yml and help.yml", () => {
    need(data["about/about.yml"], ["title", "sub_title", "description", "image"], "about");
    need(data["about/help.yml"], ["title", "icon", "description"], "help");
    list(data["about/help.yml"].items, "help.items").forEach((b) => assert.ok(str(b)));
  });
  test("hobbies.yml", () => {
    for (const [i, g] of list(data["hobbies/hobbies.yml"], "hobbies").entries()) {
      need(g, ["title", "icon", "type"], `hobbies[${i}]`);
      assert.ok(["projects", "books"].includes(g.type), `hobbies[${i}].type=${g.type}`);
      for (const [j, c] of list(g.items, `hobbies[${i}].items`).entries()) {
        need(c, ["category"], `hobbies[${i}].items[${j}]`);
        list(c.items, `hobbies[${i}].items[${j}].items`).forEach((x, k) => need(x, ["title", "description"], `hobbies[${i}].items[${j}].items[${k}]`));
      }
    }
  });
  test("profile.yml and projects.yml", () => {
    for (const [i, g] of list(data["resume/profile.yml"], "profile").entries()) need(g, ["title", "icon"], `profile[${i}]`);
    const p = data["resume/projects.yml"];
    need(p, ["title", "description"], "projects");
    list(p.projects, "projects.projects").forEach((x, i) => {
      need(x, ["title", "type", "description"], `projects[${i}]`);
      for (const k of ["role", "skills"]) if (x[k] !== undefined) list(x[k], `projects[${i}].${k}`).forEach((v) => assert.ok(str(v)));
    });
  });
  test("services.yml", () => {
    const s = data["services/services.yml"];
    need(s, ["title", "description"], "services");
    list(s.abilities, "services.abilities").forEach((a, i) => need(a, ["title", "icon", "description"], `services.abilities[${i}]`));
  });
});
