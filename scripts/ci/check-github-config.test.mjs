/**
 * Checks for the repository's GitHub configuration: the issue forms and the
 * issue chooser in .github/ISSUE_TEMPLATE/, Dependabot, CODEOWNERS and the
 * pull request template.
 *
 *   node --test scripts/ci/check-github-config.test.mjs
 *
 * Node has no YAML parser and the repo takes no dependency for a test, so the
 * YAML files are parsed by Python's PyYAML, which GitHub's ubuntu-latest
 * runners ship. Where `python3 -c "import yaml"` fails, the YAML checks skip
 * and say why; the CODEOWNERS and pull request template checks still run.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ISSUE_TEMPLATE = ".github/ISSUE_TEMPLATE";

const MAINTAINERS = ["@dorukozgen", "@CryonicsX"];

/** The issue chooser's links, by name. */
const CONTACT_LINKS = [
  { name: "Questions and ideas", url: "https://github.com/fleetifydev/fleetify/discussions" },
  {
    name: "Report a security vulnerability",
    url: "https://github.com/fleetifydev/fleetify/security/advisories/new",
  },
];

/** The issue forms: the label each applies, and its required and optional field ids. */
const FORMS = {
  "bug_report.yml": {
    label: "bug",
    required: ["what-happened", "expected", "steps", "version", "os", "agents"],
    optional: ["logs"],
  },
  "feature_request.yml": {
    label: "enhancement",
    required: ["problem", "proposal"],
    optional: ["alternatives"],
  },
};

/** Each Dependabot ecosystem, and the update types its one group collects. */
const ECOSYSTEMS = {
  // A 0.x minor bump can break a Rust build, so Cargo groups patches only.
  cargo: ["patch"],
  npm: ["minor", "patch"],
  "github-actions": ["minor", "patch"],
};

/**
 * Crates Dependabot must leave alone. The workspace patches tauri-runtime-wry
 * from vendor/, so a Tauri upgrade means reapplying the patches by hand.
 */
const CARGO_IGNORED = ["tauri", "tauri-*", "wry", "tao"];

/** The field types GitHub's form schema allows. */
const FIELD_TYPES = ["markdown", "textarea", "input", "dropdown", "checkboxes", "upload"];

const PARSE_YAML =
  "import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding='utf-8'))))";

const YAML_SKIP =
  spawnSync("python3", ["-c", "import yaml"], { stdio: "ignore" }).status === 0
    ? false
    : 'python3 with PyYAML is needed to parse YAML, and `python3 -c "import yaml"` failed here';

/** A test that parses YAML, skipped (with the reason) where PyYAML is missing. */
const yamlTest = (name, fn) => test(name, { skip: YAML_SKIP }, fn);

/** The text of `rel` (relative to the repo root), failing clearly when it's missing. */
function read(rel) {
  const file = join(ROOT, rel);
  assert.ok(existsSync(file), `${rel} is missing`);
  return readFileSync(file, "utf8");
}

/** `rel` parsed as YAML into plain JSON values. */
function load(rel) {
  const file = join(ROOT, rel);
  assert.ok(existsSync(file), `${rel} is missing`);
  const result = spawnSync("python3", ["-c", PARSE_YAML, file], { encoding: "utf8" });
  assert.equal(result.status, 0, `${rel} is not valid YAML:\n${result.stderr}`);
  const value = JSON.parse(result.stdout);
  assert.ok(value !== null && typeof value === "object", `${rel} holds no YAML mapping`);
  return value;
}

/** The YAML files in ISSUE_TEMPLATE, by name; none when the folder is missing. */
function yamlFilesInIssueTemplate() {
  const dir = join(ROOT, ISSUE_TEMPLATE);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
}

/** A form's labels, which GitHub takes as a list or a comma-separated string. */
function labelsOf(form) {
  if (Array.isArray(form.labels)) return form.labels;
  if (typeof form.labels === "string") return form.labels.split(",").map((l) => l.trim());
  return [];
}

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

describe("issue forms", () => {
  // Every form in the folder, plus the ones that must be there even before they are.
  const forms = new Set([
    ...Object.keys(FORMS),
    ...yamlFilesInIssueTemplate().filter((name) => name !== "config.yml"),
  ]);

  for (const name of forms) {
    const rel = `${ISSUE_TEMPLATE}/${name}`;

    yamlTest(`${name} is a well-formed issue form`, () => {
      const form = load(rel);
      for (const key of ["name", "description"]) {
        assert.ok(isNonEmptyString(form[key]), `${name} needs a top-level ${key}`);
      }
      assert.ok(Array.isArray(form.body) && form.body.length > 0, `${name} needs a body`);

      const ids = new Set();
      const labels = new Set();
      for (const [i, field] of form.body.entries()) {
        const where = `${name} body[${i}]`;
        assert.ok(FIELD_TYPES.includes(field.type), `${where} has an unknown type: ${field.type}`);
        if (field.type === "markdown") {
          assert.ok(isNonEmptyString(field.attributes?.value), `${where} needs attributes.value`);
          continue;
        }
        const label = field.attributes?.label;
        assert.ok(isNonEmptyString(label), `${where} needs attributes.label`);
        assert.ok(!labels.has(label), `${where} repeats the label "${label}"`);
        labels.add(label);
        if (field.id !== undefined) {
          assert.match(String(field.id), /^[A-Za-z0-9_-]+$/, `${where} has an invalid id`);
          assert.ok(!ids.has(field.id), `${where} repeats the id "${field.id}"`);
          ids.add(field.id);
        }
        if (field.validations?.required !== undefined) {
          assert.equal(typeof field.validations.required, "boolean", `${where}: required must be a boolean`);
        }
      }
      assert.ok(labels.size > 0, `${name} needs at least one field besides markdown`);
    });

    const spec = FORMS[name];
    if (!spec) continue;

    yamlTest(`${name} applies the ${spec.label} label`, () => {
      assert.ok(labelsOf(load(rel)).includes(spec.label), `${name} doesn't apply ${spec.label}`);
    });

    yamlTest(`${name} requires ${spec.required.join(", ")} and nothing else`, () => {
      const body = load(rel).body ?? [];
      const ids = new Set(body.map((f) => f.id).filter((id) => id !== undefined));
      for (const id of [...spec.required, ...spec.optional]) {
        assert.ok(ids.has(id), `${name} has no field with id "${id}"`);
      }
      // A required field without an id shows up by its label.
      const required = body
        .filter((f) => f.validations?.required === true)
        .map((f) => f.id ?? f.attributes?.label);
      assert.deepEqual(required.sort(), [...spec.required].sort(), `${name} requires the wrong fields`);
    });
  }
});

describe("issue chooser", () => {
  const rel = `${ISSUE_TEMPLATE}/config.yml`;

  yamlTest("config.yml turns off blank issues", () => {
    assert.equal(load(rel).blank_issues_enabled, false);
  });

  yamlTest("config.yml links Discussions and private vulnerability reporting", () => {
    const links = load(rel).contact_links;
    assert.ok(Array.isArray(links), "config.yml needs contact_links");
    for (const [i, link] of links.entries()) {
      for (const key of ["name", "url", "about"]) {
        assert.ok(isNonEmptyString(link[key]), `contact_links[${i}] has no ${key}`);
      }
    }
    for (const expected of CONTACT_LINKS) {
      assert.ok(
        links.some((link) => link.name === expected.name && link.url === expected.url),
        `config.yml has no "${expected.name}" link to ${expected.url}`,
      );
    }
  });
});

describe("dependabot.yml", () => {
  const rel = ".github/dependabot.yml";

  yamlTest("uses version 2 of the config format", () => {
    assert.equal(load(rel).version, 2);
  });

  /** The ecosystem's entry for directory /. */
  function entryFor(ecosystem) {
    const updates = load(rel).updates ?? [];
    const entry = updates.find((u) => u["package-ecosystem"] === ecosystem && u.directory === "/");
    assert.ok(entry, `no ${ecosystem} entry for directory /`);
    return entry;
  }

  for (const [ecosystem, updateTypes] of Object.entries(ECOSYSTEMS)) {
    const grouped = updateTypes.join(" and ");
    yamlTest(`updates ${ecosystem} weekly, at most 5 PRs, prefixed deps, ${grouped} grouped`, () => {
      const entry = entryFor(ecosystem);
      assert.equal(entry.schedule?.interval, "weekly");
      assert.equal(entry["open-pull-requests-limit"], 5);
      assert.equal(entry["commit-message"]?.prefix, "deps");

      const groups = Object.values(entry.groups ?? {});
      assert.equal(groups.length, 1, `${ecosystem} needs exactly one group`);
      const [group] = groups;
      assert.deepEqual(
        [...(group["update-types"] ?? [])].sort(),
        [...updateTypes].sort(),
        `the ${ecosystem} group must collect exactly the ${grouped} updates`,
      );
      // Without patterns a group covers every dependency; with them, "*" must be one.
      assert.ok((group.patterns ?? ["*"]).includes("*"), `the ${ecosystem} group must cover every dependency`);
    });
  }

  yamlTest(`leaves ${CARGO_IGNORED.join(", ")} to manual upgrades`, () => {
    const ignore = entryFor("cargo").ignore ?? [];
    for (const name of CARGO_IGNORED) {
      const rule = ignore.find((r) => r["dependency-name"] === name);
      assert.ok(rule, `cargo doesn't ignore ${name}`);
      // Narrowed to some versions or update types, the rule would let the rest through.
      assert.equal(rule.versions, undefined, `the ${name} rule must ignore every version`);
      assert.equal(rule["update-types"], undefined, `the ${name} rule must ignore every update type`);
    }
  });
});

describe("CODEOWNERS", () => {
  test("names both maintainers as owners of everything", () => {
    const rules = read(".github/CODEOWNERS")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split(/\s+/));
    const everything = rules.find(([pattern]) => pattern === "*");
    assert.ok(everything, "CODEOWNERS has no rule for *");
    for (const maintainer of MAINTAINERS) {
      assert.ok(everything.slice(1).includes(maintainer), `the * rule doesn't name ${maintainer}`);
    }
  });
});

describe("pull request template", () => {
  test("its checklist covers the title, tests, gates, sign-off, secrets and screenshots", () => {
    const checklist = read(".github/pull_request_template.md")
      .split(/\r?\n/)
      .filter((line) => /^\s*- \[ \] /.test(line))
      .join("\n");
    for (const [what, pattern] of [
      ["a conventional-commit title", /conventional commit/i],
      ["tests", /\btests?\b/i],
      ["the gates", /\bgates\b/i],
      ["a Signed-off-by line", /Signed-off-by/],
      ["git commit -s", /git commit -s\b/],
      ["no secrets", /\bsecrets\b/i],
      ["a screenshot of UI changes", /\bscreenshot\b/i],
    ]) {
      assert.match(checklist, pattern, `the checklist doesn't ask for ${what}`);
    }
  });
});
