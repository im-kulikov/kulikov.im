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
const raw = Object.fromEntries(ymls.map((f) => [relative(CONTENT, f), load(f)]));
// Same resolution as layouts/partials/i18n/resolve.html: {ru, en} pairs collapse to one language.
const isPair = (v) => v && typeof v === "object" && !Array.isArray(v) && "ru" in v;
const pick = (v, lang) =>
  Array.isArray(v) ? v.map((x) => pick(x, lang))
  : isPair(v) ? pick(v[lang] || v.ru, lang)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pick(x, lang)]))
  : v;
const DATA = { ru: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, pick(v, "ru")])), en: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, pick(v, "en")])) };
const str = (v) => typeof v === "string" && v.trim().length > 0;
const need = (o, keys, where) => keys.forEach((k) => assert.ok(str(o?.[k]), `${where}: "${k}" must be a non-empty string`));
const list = (v, where) => (assert.ok(Array.isArray(v) && v.length > 0, `${where}: non-empty list expected`), v);

function* deep(v, path = "") {
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { yield [k, x, `${path}/${k}`]; yield* deep(x, `${path}/${k}`); }
}

test("every YAML data file was found and parsed", () => {
  assert.deepEqual(Object.keys(raw).sort(), ["about/about.yml", "features.yml", "open-source/open-source.yml", "projects/projects.yml", "proof.yml", "resume/profile.yml", "services/help.yml", "services/how.yml", "services/services.yml"]);
});

test("every {ru, en} pair has both languages", () => {
  let n = 0;
  for (const [f, d] of Object.entries(raw)) for (const [, v, p] of deep(d)) if (isPair(v)) { n++; assert.ok(str(v.ru) && str(v.en), `${f}${p}: both ru and en are required`); }
  assert.ok(n > 300);
});

for (const lang of ["ru", "en"]) {
  const data = DATA[lang];
  describe(`data (${lang})`, () => {
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
      need(data["services/help.yml"], ["title", "icon", "description"], "help");
      list(data["services/help.yml"].items, "help.items").forEach((b) => assert.ok(str(b)));
    });
    test("open-source.yml", () => {
      for (const [i, g] of list(data["open-source/open-source.yml"], "open-source").entries()) {
        need(g, ["title", "icon", "type"], `hobbies[${i}]`);
        assert.ok(["projects", "books"].includes(g.type), `hobbies[${i}].type=${g.type}`);
        for (const [j, c] of list(g.items, `hobbies[${i}].items`).entries()) {
          need(c, ["category"], `hobbies[${i}].items[${j}]`);
          list(c.items, `hobbies[${i}].items[${j}].items`).forEach((x, k) => {
            need(x, ["title", "description"], `hobbies[${i}].items[${j}].items[${k}]`);
            if (x.skills !== undefined) list(x.skills, "skills").forEach((v) => assert.ok(str(v)));
          });
        }
      }
    });
    test("projects page does not contain hobby projects (they live on the open-source page)", () => {
      for (const x of data["projects/projects.yml"].projects) assert.ok(!(x.role ?? []).includes("Хобби"), x.title);
    });
    test("profile.yml and projects.yml", () => {
      for (const [i, g] of list(data["resume/profile.yml"], "profile").entries()) need(g, ["title", "icon"], `profile[${i}]`);
      const p = data["projects/projects.yml"];
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
  });
}
