/**
 * Checks for the GitHub Actions workflows in .github/workflows/ and the Rust
 * toolchain they build with.
 *
 *   node --test scripts/ci/check-workflows.test.mjs
 *
 * rust-toolchain.toml pins an exact Rust release, and CI builds with that
 * release: a job that runs cargo first installs it with `rustup toolchain
 * install`, which reads the file when given no toolchain name. A floating
 * `stable` would change the compiler and its lints under an unchanged tree.
 * A job runs cargo when a step calls it, the Tauri CLI or the sidecar build,
 * directly or through an npm script. Nothing may outrank the file either:
 * rustup puts a `+toolchain` argument, RUSTUP_TOOLCHAIN and `rustup override`
 * before it.
 *
 * The main ruleset requires checks by name, and a job reports its check under
 * its own name, so each required check must be exactly one job, in a workflow
 * that runs on every pull request. The PR title check also reruns when a
 * title is edited, and the Linux clippy job installs the packages that
 * CONTRIBUTING.md lists.
 *
 * Node has no YAML parser and the repo takes no dependency for a test, so the
 * workflows are parsed by Python's PyYAML, as in check-github-config.test.mjs.
 * Where `python3 -c "import yaml"` fails, the workflow checks skip and say
 * why; CI checks for PyYAML first, so they can't skip there. PyYAML reads
 * YAML 1.1, where a bare `on` is the boolean true, so a workflow's triggers
 * come back under the key "true".
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOWS = ".github/workflows";

/** The check pr-title.yml's one job reports. */
const PR_TITLE_CHECK = "Conventional PR title";

/**
 * The checks the main ruleset requires: a pull request merges once each has
 * passed on its head commit. A job reports its check under its name, so a
 * renamed job, or a changed matrix, leaves every pull request waiting for a
 * check that never comes. The clippy checks name their platform, not their
 * runner, so that moving to a newer runner image doesn't rename them; they
 * join the ruleset after their first green run on main.
 */
const REQUIRED = [
  PR_TITLE_CHECK,
  "Rust (fmt + clippy + test)",
  "Renderer (lint + test + types)",
  "DCO",
  "Rust clippy (linux)",
  "Rust clippy (macos)",
];

/** The pull request activity types a workflow runs on when it names none. */
const DEFAULT_PULL_REQUEST_TYPES = ["opened", "synchronize", "reopened"];

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

/**
 * The string value of `key` in the table `[table]` of the TOML file `rel`, or
 * undefined when either is missing. It reads only what rust-toolchain.toml
 * needs: table headers, `key = "string"` lines and comments.
 */
function tomlString(rel, table, key) {
  let current;
  for (const line of read(rel).split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*([\w.-]+)\s*\]\s*(?:#.*)?$/);
    if (header) {
      current = header[1];
      continue;
    }
    const pair = line.match(/^\s*([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/);
    if (current === table && pair?.[1] === key) return pair[2] ?? pair[3];
  }
  return undefined;
}

let parsedWorkflows;

/** Every workflow, parsed, with its file; parsed once, as each parse starts python3. */
function workflows() {
  if (parsedWorkflows === undefined) {
    const dir = join(ROOT, WORKFLOWS);
    assert.ok(existsSync(dir), `${WORKFLOWS} is missing`);
    parsedWorkflows = readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => ({ rel: `${WORKFLOWS}/${name}`, workflow: load(`${WORKFLOWS}/${name}`) }));
  }
  return parsedWorkflows;
}

/** Every job of every workflow, with its file and its id. */
const workflowJobs = () =>
  workflows().flatMap(({ rel, workflow }) =>
    Object.entries(workflow.jobs ?? {}).map(([id, job]) => ({ rel, id, job })),
  );

/** A step's script; empty for a step that runs an action. */
const scriptOf = (step) => (typeof step.run === "string" ? step.run : "");

/** A step as a failure message names it: its name, else its action or its script's first line. */
const stepLabel = (step, i) => `step ${i + 1} (${step.name ?? step.uses ?? scriptOf(step).split("\n")[0]})`;

/**
 * Whether a line of shell runs cargo itself: it calls cargo or the Tauri CLI,
 * or a script of the repo's that calls them: the sidecar build
 * (build-sidecars.mjs, `npm run build:sidecars`), whose `--check` only reads
 * the config, and dev-tauri-wt.mjs, which starts `tauri dev`.
 */
const lineRunsCargo = (line) =>
  /(^|[\s;&|(])(cargo|tauri)(\s|$)/.test(line) ||
  (/(build-sidecars|dev-tauri-wt)\.mjs|build:sidecars/.test(line) && !line.includes("--check"));

let packageScripts;

/** package.json's scripts, which a step can run through npm. */
function npmScripts() {
  packageScripts ??= JSON.parse(read("package.json")).scripts ?? {};
  return packageScripts;
}

/**
 * The npm scripts a line of shell runs: `npm run <name>` (or `run-script`),
 * `npm test`, `npm start`, and the install scripts of `npm ci` and `npm
 * install`, each with the pre and post scripts npm runs around it.
 */
function npmScriptsRunBy(line) {
  const names = [];
  for (const command of line.split(/[;&|]+/)) {
    const words = command.trim().split(/\s+/);
    const npm = words.indexOf("npm");
    if (npm === -1) continue;
    // Flags such as --silent name neither the command nor the script.
    const [verb, name] = words.slice(npm + 1).filter((word) => !word.startsWith("-"));
    if (verb === "run" || verb === "run-script") names.push(name);
    else if (verb === "test" || verb === "start") names.push(verb);
    else if (verb === "ci" || verb === "install" || verb === "i") names.push("install", "prepare");
  }
  return names.filter(Boolean).flatMap((name) => [`pre${name}`, name, `post${name}`]);
}

/** Whether the npm scripts `names` run cargo, themselves or through further npm scripts. */
function npmScriptsRunCargo(names, seen) {
  const scripts = npmScripts();
  return names.some((name) => {
    if (seen.has(name) || typeof scripts[name] !== "string") return false;
    seen.add(name);
    return shellRunsCargo(scripts[name], seen);
  });
}

/** Whether shell text runs cargo, on one of its lines or in an npm script a line runs. */
const shellRunsCargo = (text, seen = new Set()) =>
  text.split("\n").some((line) => lineRunsCargo(line) || npmScriptsRunCargo(npmScriptsRunBy(line), seen));

/** Whether a step runs cargo. */
const runsCargo = (step) => shellRunsCargo(scriptOf(step));

/**
 * Whether a step installs the toolchain rust-toolchain.toml pins: a line of
 * its script is `rustup toolchain install` with no toolchain named, so that
 * rustup reads the file.
 */
const installsPinnedToolchain = (step) =>
  /^\s*rustup\s+toolchain\s+install\s*(?:#.*)?$/m.test(scriptOf(step));

/**
 * What a script can do that outranks rust-toolchain.toml in rustup's order of
 * precedence: pass a `+toolchain` argument to cargo or another rustup proxy,
 * set RUSTUP_TOOLCHAIN, or run `rustup run` (which sets it for its command) or
 * `rustup override` (a directory override). A step that does builds with a
 * compiler the pin didn't choose.
 */
const OVERRIDES = [
  {
    what: "passes a `+toolchain` argument",
    pattern: /(^|[\s;&|(])(cargo|rustc|rustdoc|rustfmt|cargo-clippy|cargo-fmt|clippy-driver)\s+\+/,
  },
  { what: "runs `rustup run` or `rustup override`", pattern: /(^|[\s;&|(])rustup\s+(run|override)(\s|$)/ },
  { what: "sets RUSTUP_TOOLCHAIN", pattern: /RUSTUP_TOOLCHAIN\s*=/ },
];

/** Whether an `env` mapping (of a workflow, a job or a step) sets RUSTUP_TOOLCHAIN. */
const setsToolchainVariable = (env) =>
  env !== null && typeof env === "object" && Object.hasOwn(env, "RUSTUP_TOOLCHAIN");

/** A workflow's triggers, as a mapping from each event to its settings (null when it has none). */
function triggersOf(workflow) {
  const on = workflow.true ?? workflow.on;
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((event) => [event, null]));
  return on ?? {};
}

/**
 * Why a workflow's jobs might not report on a pull request's head commit, or
 * undefined when they always do. That takes the pull_request trigger, with no
 * path filter and with the default activity types among its own.
 */
function pullRequestGap(workflow) {
  const on = triggersOf(workflow);
  if (!Object.hasOwn(on, "pull_request")) return "doesn't run on pull_request";
  const settings = on.pull_request ?? {};
  const filters = ["paths", "paths-ignore"].filter((key) => Object.hasOwn(settings, key));
  if (filters.length > 0) return `filters pull requests by ${filters.join(" and ")}`;
  if (settings.types === undefined) return undefined;
  const missing = DEFAULT_PULL_REQUEST_TYPES.filter((type) => ![settings.types].flat().includes(type));
  return missing.length > 0 ? `doesn't run on ${missing.join(", ")}` : undefined;
}

/**
 * A job's matrix combinations, as GitHub expands them: every mix of the values
 * its lists give, less those an `exclude` entry matches, then the `include`
 * entries. An include entry joins each combination whose original values it
 * doesn't change, and becomes a combination of its own when it joins none. A
 * job without a matrix has one, empty, combination, as does a matrix given as
 * an expression, which only a run can expand.
 */
function matrixCombinations(matrix) {
  if (matrix === null || typeof matrix !== "object") return [{}];
  const { include = [], exclude = [], ...lists } = matrix;
  let base = Object.keys(lists).length > 0 ? [{}] : [];
  for (const [key, values] of Object.entries(lists)) {
    base = base.flatMap((combo) => [values].flat().map((value) => ({ ...combo, [key]: value })));
  }
  const hasAll = (combo, entry) =>
    Object.entries(entry).every(([key, value]) => key in combo && isDeepStrictEqual(combo[key], value));
  const keeps = (combo, entry) =>
    Object.entries(entry).every(([key, value]) => !(key in combo) || isDeepStrictEqual(combo[key], value));
  base = base.filter((combo) => !exclude.some((entry) => hasAll(combo, entry)));
  const combos = base.map((combo) => ({ ...combo }));
  for (const entry of include) {
    const joins = base.flatMap((combo, i) => (keeps(combo, entry) ? [i] : []));
    for (const i of joins) Object.assign(combos[i], entry);
    if (joins.length === 0) combos.push({ ...entry });
  }
  return combos.length > 0 ? combos : [{}];
}

/**
 * The names a job's checks report under: its `name`, or its id when it has
 * none, once per matrix combination. A `${{ matrix.<key> }}` in the name
 * becomes the combination's value; a name with no expression gets the
 * combination's values appended, as GitHub does: "Build (linux)".
 */
function checkNames(id, job) {
  const name = typeof job.name === "string" ? job.name : id;
  return matrixCombinations(job.strategy?.matrix).map((combo) => {
    const values = Object.values(combo);
    if (values.length === 0) return name;
    if (!name.includes("${{")) return `${name} (${values.join(", ")})`;
    return name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (expression, key) =>
      key in combo ? String(combo[key]) : expression,
    );
  });
}

/** The first fenced code block in the section under a Markdown heading, such as "### Linux". */
function codeBlockUnder(rel, heading) {
  const text = read(rel).replace(/\r\n/g, "\n");
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start !== -1, `${rel} has no "${heading}" heading`);
  const rest = text.slice(start + heading.length + 2);
  const block = rest.match(/^```[\w-]*\n([\s\S]*?)^```/m);
  assert.ok(block && !/^#{1,6} /m.test(rest.slice(0, block.index)), `${rel} has no code block under "${heading}"`);
  return block[1];
}

/** The packages that the `apt install` and `apt-get install` commands in shell text install, sorted. */
function aptPackages(text) {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/&&|;|\n/)
    .flatMap((command) => {
      const words = command.trim().split(/\s+/);
      const apt = words.findIndex((word) => word === "apt" || word === "apt-get");
      const install = words.indexOf("install", apt + 1);
      return apt === -1 || install === -1 ? [] : words.slice(install + 1).filter((word) => !word.startsWith("-"));
    })
    .sort();
}

describe("Rust toolchain", () => {
  test("rust-toolchain.toml pins an exact release", () => {
    const channel = tomlString("rust-toolchain.toml", "toolchain", "channel");
    const found = channel === undefined ? "missing" : `"${channel}"`;
    assert.match(
      channel ?? "",
      /^\d+\.\d+\.\d+$/,
      `rust-toolchain.toml's [toolchain] channel is ${found}, not an exact release such as "1.100.0"`,
    );
    // Where both files exist, rustup takes rust-toolchain and ignores the pin.
    assert.ok(!existsSync(join(ROOT, "rust-toolchain")), "a rust-toolchain file overrides rust-toolchain.toml");
  });

  yamlTest("no workflow installs a floating Rust toolchain", () => {
    let cargoJobs = 0;
    for (const { rel, id, job } of workflowJobs()) {
      const steps = job.steps ?? [];
      for (const [i, step] of steps.entries()) {
        // It installs the toolchain its ref or input names, whatever rust-toolchain.toml pins.
        assert.ok(
          !String(step.uses ?? "").toLowerCase().startsWith("dtolnay/rust-toolchain"),
          `${rel}, job ${id}, ${stepLabel(step, i)} uses dtolnay/rust-toolchain: install the pinned toolchain with \`rustup toolchain install\``,
        );
      }
      const cargo = steps.findIndex(runsCargo);
      if (cargo === -1) continue;
      cargoJobs += 1;
      const install = steps.findIndex(installsPinnedToolchain);
      assert.ok(
        install !== -1 && install < cargo,
        `${rel}, job ${id}, runs cargo in ${stepLabel(steps[cargo], cargo)} with no earlier step that runs \`rustup toolchain install\`, which installs the toolchain rust-toolchain.toml pins`,
      );
    }
    assert.ok(cargoJobs > 0, "no workflow job runs cargo, so there was nothing to check");
  });

  yamlTest("nothing in a workflow outranks rust-toolchain.toml", () => {
    const problems = [];
    for (const { rel, workflow } of workflows()) {
      if (setsToolchainVariable(workflow.env)) problems.push(`${rel} sets RUSTUP_TOOLCHAIN in its env`);
      for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
        if (setsToolchainVariable(job.env)) problems.push(`${rel}, job ${id}, sets RUSTUP_TOOLCHAIN in its env`);
        for (const [i, step] of (job.steps ?? []).entries()) {
          const where = `${rel}, job ${id}, ${stepLabel(step, i)}`;
          if (setsToolchainVariable(step.env)) problems.push(`${where} sets RUSTUP_TOOLCHAIN in its env`);
          const lines = scriptOf(step).split("\n");
          for (const { what, pattern } of OVERRIDES) {
            if (lines.some((line) => pattern.test(line))) problems.push(`${where} ${what}`);
          }
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      `${problems.join("\n")}\nEach outranks rust-toolchain.toml, so cargo would build with a toolchain the pin didn't choose.`,
    );
  });
});

describe("Linux packages", () => {
  yamlTest("the Linux clippy job installs CONTRIBUTING's Linux packages", () => {
    const documented = aptPackages(codeBlockUnder("CONTRIBUTING.md", "### Linux"));
    assert.ok(documented.length > 0, "CONTRIBUTING.md's Linux section installs no packages with apt");
    const job = load(`${WORKFLOWS}/ci.yml`).jobs?.["rust-unix"];
    assert.ok(job, "ci.yml has no rust-unix job");
    const installed = (job.steps ?? []).flatMap((step) => aptPackages(scriptOf(step))).sort();
    // The job shows the documented list is enough to compile the workspace on the runner image.
    assert.deepEqual(
      installed,
      documented,
      "ci.yml's rust-unix job and CONTRIBUTING.md's Linux section must install the same packages",
    );
  });
});

describe("required checks", () => {
  yamlTest("every required check is a job", () => {
    const reporters = new Map();
    for (const { rel, id, job } of workflowJobs()) {
      for (const name of checkNames(id, job)) {
        reporters.set(name, [...(reporters.get(name) ?? []), `${rel} job ${id}`]);
      }
    }
    const problems = REQUIRED.flatMap((check) => {
      const jobs = reporters.get(check) ?? [];
      if (jobs.length === 0) return [`no job reports "${check}"`];
      return jobs.length > 1 ? [`"${check}" is reported ${jobs.length} times, by ${jobs.join(", ")}`] : [];
    });
    assert.deepEqual(problems, [], `${problems.join("\n")}\nThe main ruleset requires each of these checks by name.`);
  });

  yamlTest("the required checks run on every pull request", () => {
    const problems = [];
    for (const { rel, workflow } of workflows()) {
      const checks = Object.entries(workflow.jobs ?? {})
        .flatMap(([id, job]) => checkNames(id, job))
        .filter((name) => REQUIRED.includes(name));
      const gap = checks.length > 0 ? pullRequestGap(workflow) : undefined;
      if (gap) problems.push(`${rel}, which reports ${checks.map((c) => `"${c}"`).join(", ")}, ${gap}`);
    }
    assert.deepEqual(
      problems,
      [],
      `${problems.join("\n")}\nA pull request waits for a required check until it reports on the head commit.`,
    );
  });

  // An edited title fires `edited`, which ci.yml doesn't run on, so the check
  // lives in a workflow of its own; `synchronize` makes it report on each new
  // head commit too, which is where the ruleset looks for it.
  yamlTest("the PR title check reruns when a title is edited", () => {
    const rel = `${WORKFLOWS}/pr-title.yml`;
    const workflow = load(rel);
    const on = triggersOf(workflow);
    // pull_request_target would run on a fork's pull request with the base repository's token.
    assert.ok(!Object.hasOwn(on, "pull_request_target"), `${rel} runs on pull_request_target; use pull_request`);
    const types = [on.pull_request?.types ?? []].flat();
    assert.deepEqual(
      [...types].sort(),
      ["edited", "opened", "reopened", "synchronize"],
      `${rel} must run on the pull request types opened, edited, synchronize and reopened, and only ` +
        `those; it runs on ${types.join(", ") || "none"}`,
    );
    const names = Object.values(workflow.jobs ?? {}).map((job) => job.name);
    assert.deepEqual(names, [PR_TITLE_CHECK], `${rel} must have one job, named "${PR_TITLE_CHECK}"`);
    const inCi = Object.entries(load(`${WORKFLOWS}/ci.yml`).jobs ?? {})
      .filter(([, job]) => job.name === PR_TITLE_CHECK)
      .map(([id]) => id);
    assert.deepEqual(
      inCi,
      [],
      `ci.yml's job ${inCi.join(", ")} is named "${PR_TITLE_CHECK}" too, and an edited title doesn't rerun it`,
    );
  });
});
