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
 * The workflows that make a release (build.yml, smoke.yml, release-dry-run.yml
 * and release.yml) pin each action to a commit and grant only `contents:
 * read` at the top. build.yml builds release-assets.mjs's TARGETS, and a
 * release build gets nothing of a dry run's: no cache, none of the keys a dry
 * run makes, no updater overlay. The dry run assembles with each build's own
 * key, and its smoke runs the bundles without the source tree. Where a step's
 * script decides something, such as the environment or the arguments the
 * smoke gets, the check runs that script with bash, as the runner does.
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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { dryRunConfig } from "../release/dry-run-config.mjs";
import { TARGETS, UPDATER_KEY_ID } from "../release/release-assets.mjs";

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
  // An assignment, not a read: in a shell the name starts a word (`export X=…`,
  // `X=… cargo`, `echo "X=…" >> "$GITHUB_ENV"`), and in PowerShell it follows
  // `$env:`. A read such as `[ "$X" = … ]` has `$` or `${` before the name.
  // Windows reads variable names in any case, so the match does too.
  {
    what: "sets RUSTUP_TOOLCHAIN",
    pattern: /(^|[\s;&|("'])RUSTUP_TOOLCHAIN=|\$env:RUSTUP_TOOLCHAIN\s*=(?!=)/i,
  },
];

/** What a script does, line by line, that OVERRIDES lists. */
const overridesIn = (script) =>
  OVERRIDES.filter(({ pattern }) => script.split("\n").some((line) => pattern.test(line))).map(({ what }) => what);

/** Whether an `env` mapping (of a workflow, a job or a step) sets RUSTUP_TOOLCHAIN, in any case. */
const setsToolchainVariable = (env) =>
  env !== null &&
  typeof env === "object" &&
  Object.keys(env).some((name) => name.toUpperCase() === "RUSTUP_TOOLCHAIN");

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
          for (const what of overridesIn(scriptOf(step))) problems.push(`${where} ${what}`);
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      `${problems.join("\n")}\nEach outranks rust-toolchain.toml, so cargo would build with a toolchain the pin didn't choose.`,
    );
  });

  test("the override check flags what outranks the pin, and not a read of RUSTUP_TOOLCHAIN", () => {
    const flagged = [
      "cargo +nightly clippy --workspace",
      "rustc +1.99.0 --version",
      "rustup override set nightly",
      "rustup run nightly cargo build",
      "export RUSTUP_TOOLCHAIN=nightly",
      "RUSTUP_TOOLCHAIN=nightly cargo build",
      "env RUSTUP_TOOLCHAIN=nightly cargo build",
      'echo "RUSTUP_TOOLCHAIN=nightly" >> "$GITHUB_ENV"',
      '"RUSTUP_TOOLCHAIN=nightly" >> $env:GITHUB_ENV',
      "$env:RUSTUP_TOOLCHAIN = 'nightly'",
      "$env:rustup_toolchain='nightly'",
    ];
    const passed = [
      "rustup toolchain install",
      "rustup show active-toolchain",
      "rustup default nightly",
      "cargo clippy --workspace --all-targets -- -D warnings",
      'echo "$RUSTUP_TOOLCHAIN"',
      '[ "$RUSTUP_TOOLCHAIN" = nightly ]',
      "[ $RUSTUP_TOOLCHAIN = nightly ]",
      "[[ $RUSTUP_TOOLCHAIN == nightly ]]",
      '[ "${RUSTUP_TOOLCHAIN:-}" = "" ]',
      "if ($env:RUSTUP_TOOLCHAIN -eq 'nightly') { exit 1 }",
      "unset RUSTUP_TOOLCHAIN",
    ];
    const missed = flagged.filter((line) => overridesIn(line).length === 0);
    assert.deepEqual(missed, [], "these lines outrank the pin, and the check misses them");
    const wrong = passed.filter((line) => overridesIn(line).length > 0);
    assert.deepEqual(wrong, [], "these lines don't outrank the pin, and the check flags them");
    assert.ok(setsToolchainVariable({ rustup_toolchain: "nightly" }), "an env key sets the variable in any case");
    assert.ok(!setsToolchainVariable({ RUSTUP_HOME: "/opt/rustup" }), "RUSTUP_HOME doesn't choose a toolchain");
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

// ── The release workflows ───────────────────────────────────────────────────

const BUILD = `${WORKFLOWS}/build.yml`;
const DRY_RUN = `${WORKFLOWS}/release-dry-run.yml`;

/**
 * The workflows a release is made by. Their actions run next to the signing
 * keys, so each is pinned to a commit: a tag can be moved to other code.
 */
const RELEASE_PATH = ["pr-title.yml", "build.yml", "smoke.yml", "release-dry-run.yml", "release.yml"];

/** The pull request paths that run the dry run: what a release build reads. */
const DRY_RUN_PATHS = [
  "src-tauri/tauri*.conf.json",
  "src-tauri/Entitlements.plist",
  "src-tauri/build.rs",
  "src-tauri/capabilities/**",
  "src-tauri/Cargo.toml",
  "config/**",
  "scripts/build-sidecars.mjs",
  "scripts/release/**",
  ".github/workflows/build.yml",
  ".github/workflows/smoke.yml",
  ".github/workflows/release-dry-run.yml",
  ".github/workflows/release.yml",
  "Cargo.lock",
  "package-lock.json",
  "rust-toolchain.toml",
  "vendor/**",
];

/** A reference to a secret: `secrets.` inside a `${{ }}` expression. */
const SECRET_REF = /\$\{\{[^}]*\bsecrets\./;

/** build.yml's conditions for a step that runs only in a dry run, or only in a release build. */
const DRY_RUN_ONLY = "inputs.environment == 'dry-run'";
const RELEASE_ONLY = "inputs.environment == 'release'";

/**
 * What only a dry run may do in build.yml, each found by a string in the
 * step: make keys of its own and build with the updater overlay, which
 * points the updater at the smoke's server over plain http. A release build
 * that did would ship them; nothing after the build would notice, as a
 * release build's signatures are made with the release key either way.
 */
const DRY_RUN_MARKERS = [
  { marker: "signer generate", what: "makes the run's own updater key" },
  { marker: "updater.key", what: "uses the run's updater key" },
  { marker: "updater-key-", what: "hands the run's updater key from job to job" },
  { marker: "dry-run-config.mjs", what: "writes the updater overlay (dangerousInsecureTransportProtocol)" },
  { marker: "dry-run.json", what: "builds with the updater overlay" },
  { marker: "updater-pubkey.txt", what: "adds the run's updater public key to the artifact" },
  { marker: "openssl req", what: "makes the run's own code-signing identity" },
];

const BASH_SKIP =
  spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0 ? false : "bash is needed to run a step's script";

/** A test that parses YAML and runs a step's script, skipped (with the reason) where either can't run. */
const scriptTest = (name, fn) => test(name, { skip: YAML_SKIP || BASH_SKIP }, fn);

/** A workflow, parsed, failing clearly when it's missing. */
function workflow(rel) {
  const found = workflows().find((entry) => entry.rel === rel);
  assert.ok(found, `${rel} is missing`);
  return found.workflow;
}

/** A job of a workflow, failing clearly when it's missing. */
function jobOf(rel, id) {
  const job = workflow(rel).jobs?.[id];
  assert.ok(job, `${rel} has no job ${id}`);
  return job;
}

/** What a step hands on, as one string to search: its script, its env and its action's inputs. */
const textOf = (step) => JSON.stringify([step.run ?? "", step.env ?? {}, step.with ?? {}]);

/** Whether a step runs `tauri build`. */
const isTauriBuild = (step) => /(^|\s)tauri build(\s|$)/m.test(scriptOf(step));

/** Whether a step runs `tauri bundle`, which bundles and signs what `tauri build --no-bundle` built. */
const isTauriBundle = (step) => /(^|\s)tauri bundle(\s|$)/m.test(scriptOf(step));

/** Whether a step runs the action `name` (owner/repo), at any version. */
const usesAction = (step, name) => String(step.uses ?? "").startsWith(`${name}@`);

/**
 * The clauses an `if:` condition joins with `&&`, each with its spaces
 * collapsed; none for a step without a condition. null when the condition
 * has `||` or a `!` that negates, where no single clause decides whether the
 * step runs.
 */
function clauses(condition) {
  if (condition === undefined || condition === null) return [];
  const text = String(condition)
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  if (/\|\||!(?!=)/.test(text)) return null;
  return text.split("&&").map((part) => part.trim().replace(/\s+/g, " "));
}

/** Whether a condition runs its step only when `clause` holds: one of its `&&` clauses is `clause`. */
const requires = (condition, clause) => clauses(condition)?.includes(clause) === true;

/**
 * Run a step's script as the runner runs a bash step on Linux and macOS
 * (bash --noprofile --norc -eo pipefail), in `cwd`, with PATH, HOME and `env`.
 */
function runScript(script, { cwd, env = {} }) {
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
  });
}

/** Call fn with a fresh temporary folder, removed afterwards. */
function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "check-workflows-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("release workflows", () => {
  yamlTest("the release workflows pin each action to a commit, with its release beside it", () => {
    const problems = [];
    let pinned = 0;
    for (const { rel, workflow: flow } of workflows().filter(({ rel }) => RELEASE_PATH.includes(basename(rel)))) {
      const jobs = Object.values(flow.jobs ?? {});
      const refs = [...jobs.map((job) => job.uses), ...jobs.flatMap((job) => (job.steps ?? []).map((step) => step.uses))];
      for (const ref of refs.filter((uses) => typeof uses === "string" && !uses.startsWith("./"))) {
        pinned += 1;
        if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) problems.push(`${rel}: ${ref} is not pinned to a full commit SHA`);
      }
      // The comment says which release the SHA is; YAML drops comments, so the text is read.
      for (const [i, line] of read(rel).split(/\r?\n/).entries()) {
        const uses = line.match(/^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)["']?\s*(#.*)?$/);
        if (!uses || uses[1].startsWith("./")) continue;
        if (!/^#\s*v\d+\.\d+\.\d+\s*$/.test(uses[2] ?? "")) {
          problems.push(`${rel}:${i + 1}: ${uses[1]} has no "# vX.Y.Z" comment naming its release`);
        }
      }
    }
    assert.ok(pinned > 0, "no release workflow uses an action, so there was nothing to check");
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  yamlTest("no workflow runs on pull_request_target", () => {
    // It would run with the base repository's token and secrets on a fork's code.
    const found = workflows()
      .filter(({ workflow: flow }) => Object.hasOwn(triggersOf(flow), "pull_request_target"))
      .map(({ rel }) => rel);
    assert.deepEqual(found, [], `these workflows run on pull_request_target; use pull_request: ${found.join(", ")}`);
  });

  yamlTest("the release workflows grant only contents: read at the top, and more per job only", () => {
    const problems = workflows()
      .filter(({ rel }) => RELEASE_PATH.includes(basename(rel)))
      .filter(({ workflow: flow }) => !isDeepStrictEqual(flow.permissions, { contents: "read" }))
      .map(({ rel, workflow: flow }) => `${rel}: ${JSON.stringify(flow.permissions ?? "(none: the repository default)")}`);
    assert.deepEqual(problems, [], `top-level permissions must be exactly { contents: read }:\n${problems.join("\n")}`);
  });

  test("no workflow mentions NOTDIAMOND", () => {
    // A workflow never sets that key, nor any other key that isn't public.
    const found = readdirSync(join(ROOT, WORKFLOWS))
      .filter((name) => /\.ya?ml$/.test(name))
      .filter((name) => /notdiamond/i.test(read(`${WORKFLOWS}/${name}`)));
    assert.deepEqual(found, [], `these workflows mention NOTDIAMOND: ${found.join(", ")}`);
  });
});

describe("build.yml", () => {
  yamlTest("it compiles in no environment, then bundles in the one the caller names", () => {
    const call = triggersOf(workflow(BUILD)).workflow_call;
    assert.deepEqual(Object.keys(call?.inputs ?? {}).sort(), ["environment", "ref", "version"]);
    for (const [name, input] of Object.entries(call.inputs)) {
      assert.deepEqual([input.type, input.required], ["string", true], `input ${name} must be a required string`);
    }
    const compile = jobOf(BUILD, "compile");
    assert.equal(compile.environment, undefined, "the compile job must run in no environment");
    assert.deepEqual([[compile.needs].flat(), compile["timeout-minutes"]], [["notices"], 120], "the compile job");
    const bundle = jobOf(BUILD, "bundle");
    assert.equal(bundle.environment, "${{ inputs.environment }}");
    assert.deepEqual([[bundle.needs].flat(), bundle["timeout-minutes"]], [["compile"], 60], "the bundle job");
  });

  yamlTest("both build jobs run release-assets.mjs's TARGETS", () => {
    const targets = TARGETS.map(({ triple, runner, bundles }) => ({ triple, runner, bundles: [...bundles] }));
    for (const id of ["compile", "bundle"]) {
      assert.deepEqual(jobOf(BUILD, id).strategy?.matrix, { include: targets }, `job ${id}'s matrix`);
    }
  });

  yamlTest("no build uses a cache, so a dry run rehearses the release build", () => {
    // Release artifacts come from a clean target folder, with no cache to
    // trust, and a dry run builds the same way.
    const problems = [];
    for (const [id, job] of Object.entries(workflow(BUILD).jobs ?? {})) {
      for (const [i, step] of (job.steps ?? []).entries()) {
        const where = `${BUILD}, job ${id}, ${stepLabel(step, i)}`;
        if (usesAction(step, "Swatinem/rust-cache")) problems.push(`${where} restores the Rust cache`);
        if (/^actions\/cache(@|\/)/.test(String(step.uses ?? ""))) problems.push(`${where} uses actions/cache`);
        if (usesAction(step, "actions/setup-node") && (step.with?.cache !== undefined || step.with?.["package-manager-cache"] !== false)) {
          problems.push(`${where} lets setup-node cache npm's downloads; give it package-manager-cache: false and no cache`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  yamlTest("every npm ci skips the packages' install scripts", () => {
    // An install script is dependency code; none of the build needs one.
    const problems = [];
    for (const [id, job] of Object.entries(workflow(BUILD).jobs ?? {})) {
      for (const [i, step] of (job.steps ?? []).entries()) {
        for (const line of scriptOf(step).split("\n")) {
          if (/(^|[\s;&|(])npm\s+(ci|install|i)(\s|$)/.test(line) && !/\s--ignore-scripts(\s|$)/.test(line)) {
            problems.push(`${BUILD}, job ${id}, ${stepLabel(step, i)}: ${line.trim()}`);
          }
        }
      }
    }
    assert.deepEqual(problems, [], `these run npm's install scripts; add --ignore-scripts:\n${problems.join("\n")}`);
  });

  yamlTest("the compile job, which runs the dependencies' code, has no environment and no secret", () => {
    const compile = jobOf(BUILD, "compile");
    assert.equal(compile.environment, undefined, "the compile job runs in an environment");
    assert.doesNotMatch(JSON.stringify(compile), SECRET_REF, "the compile job references a secret");
  });

  yamlTest("the bundle job compiles nothing: no cargo, tauri build, npm script or sidecar build", () => {
    // While the keys are there, only the Tauri CLI's bundler runs.
    const banned = [
      { what: "runs cargo", pattern: /(^|[\s;&|(])cargo(\s|$)/ },
      { what: "runs tauri build", pattern: /(^|\s)tauri build(\s|$)/ },
      { what: "runs an npm script", pattern: /(^|[\s;&|(])npm\s+(run|run-script|test|start)(\s|$)/ },
      { what: "builds the sidecars", pattern: /build-sidecars|build:sidecars/ },
    ];
    const steps = jobOf(BUILD, "bundle").steps ?? [];
    const problems = steps.flatMap((step, i) =>
      banned
        .filter(({ pattern }) => scriptOf(step).split("\n").some((line) => pattern.test(line)))
        .map(({ what }) => `${stepLabel(step, i)} ${what}`),
    );
    assert.deepEqual(problems, [], problems.join("\n"));
    assert.ok(steps.some(isTauriBundle), "the bundle job doesn't run tauri bundle");
  });

  yamlTest("every secret is in the env of a step that runs only in a release build", () => {
    const flow = workflow(BUILD);
    const problems = [];
    if (SECRET_REF.test(JSON.stringify(flow.env ?? {}))) problems.push("the workflow's env references a secret");
    for (const [id, job] of Object.entries(flow.jobs ?? {})) {
      const { steps = [], ...settings } = job;
      if (SECRET_REF.test(JSON.stringify(settings))) problems.push(`job ${id} references a secret outside its steps`);
      for (const [i, step] of steps.entries()) {
        const { env = {}, ...rest } = step;
        const where = `job ${id}, ${stepLabel(step, i)}`;
        if (SECRET_REF.test(JSON.stringify(rest))) problems.push(`${where} references a secret outside its env`);
        if (SECRET_REF.test(JSON.stringify(env)) && !requires(step.if, RELEASE_ONLY)) {
          problems.push(`${where} gets a secret, but its condition isn't "${RELEASE_ONLY}" (and more): ${step.if ?? "none"}`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  yamlTest("only a dry run makes keys of its own, writes the updater overlay or adds updater-pubkey.txt", () => {
    const problems = [];
    const found = new Set();
    for (const [id, job] of Object.entries(workflow(BUILD).jobs ?? {})) {
      for (const [i, step] of (job.steps ?? []).entries()) {
        for (const { marker, what } of DRY_RUN_MARKERS.filter(({ marker }) => textOf(step).includes(marker))) {
          found.add(marker);
          if (!requires(step.if, DRY_RUN_ONLY)) {
            problems.push(`${BUILD}, job ${id}, ${stepLabel(step, i)} ${what}, but its condition isn't "${DRY_RUN_ONLY}" (and more): ${step.if ?? "none"}`);
          }
        }
      }
    }
    const missing = DRY_RUN_MARKERS.filter(({ marker }) => !found.has(marker)).map(({ marker }) => marker);
    assert.deepEqual(missing, [], `no step of ${BUILD} mentions these, so the dry run lacks them`);
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  yamlTest("the dry run's updater key goes from the compile job to the bundle job, kept a day", () => {
    // Only this run's dry-run builds trust the key.
    const keyArtifact = (id, action) =>
      (jobOf(BUILD, id).steps ?? []).filter((step) => usesAction(step, action) && String(step.with?.name).startsWith("updater-key-"));
    const uploads = keyArtifact("compile", "actions/upload-artifact");
    assert.equal(uploads.length, 1, "the compile job must upload the dry run's updater key once");
    assert.deepEqual(
      [uploads[0].with.name, uploads[0].with.path, uploads[0].with["retention-days"]],
      ["updater-key-${{ matrix.triple }}", "${{ runner.temp }}/dry-run", 1],
    );
    const downloads = keyArtifact("bundle", "actions/download-artifact");
    assert.equal(downloads.length, 1, "the bundle job must download the dry run's updater key once");
    assert.deepEqual([downloads[0].with.name, downloads[0].with.path], ["updater-key-${{ matrix.triple }}", "${{ runner.temp }}/dry-run"]);
  });

  yamlTest("a release build compiles and bundles with the release config alone, and a dry run adds the overlay", () => {
    const pair = (id, isCommand) => {
      const steps = (jobOf(BUILD, id).steps ?? []).filter(isCommand);
      const release = steps.filter((step) => requires(step.if, RELEASE_ONLY));
      const dryRun = steps.filter((step) => requires(step.if, DRY_RUN_ONLY));
      assert.deepEqual([steps.length, release.length, dryRun.length], [2, 1, 1], `job ${id} must run it once if "${RELEASE_ONLY}" and once if "${DRY_RUN_ONLY}"`);
      return { release: release[0], dryRun: dryRun[0] };
    };
    const overlay = /--config "\$RUNNER_TEMP\/dry-run\/dry-run\.json"/;
    const compile = pair("compile", isTauriBuild);
    for (const step of [compile.release, compile.dryRun]) assert.match(scriptOf(step), /\s--no-bundle(\s|$)/, "the compile job must not bundle");
    assert.doesNotMatch(textOf(compile.release), /dry-run/, "the release compile mentions the dry run");
    // The overlay's key and endpoint are compiled into the app.
    assert.match(scriptOf(compile.dryRun), overlay, "the dry run doesn't compile the overlay in");
    const bundle = pair("bundle", isTauriBundle);
    assert.doesNotMatch(textOf(bundle.release), /dry-run/, "the release bundle mentions the dry run");
    assert.deepEqual(
      Object.fromEntries(["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "APPLE_SIGNING_IDENTITY"].map((name) => [name, bundle.release.env?.[name]])),
      {
        TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
        APPLE_SIGNING_IDENTITY: "${{ vars.APPLE_SIGNING_IDENTITY }}",
      },
    );
    assert.match(scriptOf(bundle.dryRun), overlay, "the dry run doesn't bundle with the overlay");
    assert.equal(bundle.dryRun.env?.TAURI_SIGNING_PRIVATE_KEY, "${{ runner.temp }}/dry-run/updater.key");
  });

  yamlTest("every tauri build and bundle names the target and adds src-tauri/tauri.release.conf.json", () => {
    for (const id of ["compile", "bundle"]) {
      const commands = (jobOf(BUILD, id).steps ?? []).filter((step) => isTauriBuild(step) || isTauriBundle(step));
      assert.ok(commands.length > 0, `job ${id} runs neither tauri build nor tauri bundle`);
      for (const step of commands) {
        assert.match(scriptOf(step), /\s--target "\$TRIPLE"\s/, `${step.name ?? "a tauri command"} doesn't name the target`);
        assert.match(scriptOf(step), /--config src-tauri\/tauri\.release\.conf\.json(\s|$)/, `${step.name ?? "a tauri command"} misses the release config`);
      }
    }
  });

  yamlTest("the bundle job bundles the files the compile job built", () => {
    const compile = jobOf(BUILD, "compile").steps ?? [];
    const pack = compile.findIndex((step) => /(^|\s)tar -cf compiled\.tar\s/m.test(scriptOf(step)));
    assert.ok(pack > compile.findLastIndex(isTauriBuild), "the compile job must pack compiled.tar after it builds");
    for (const path of [/release\/fleetify-app/, /release\/fleet-\*-mcp/, /\ssrc-tauri\/binaries(\s|$)/, /\sdist(\s|$)/]) {
      assert.match(scriptOf(compile[pack]), path, `compiled.tar misses ${path}`);
    }
    const upload = compile.find((step) => usesAction(step, "actions/upload-artifact") && step.with?.name === "compiled-${{ matrix.triple }}");
    assert.deepEqual([upload?.with?.path, upload?.with?.["if-no-files-found"], upload?.with?.["retention-days"]], ["compiled.tar", "error", 1]);
    const bundle = jobOf(BUILD, "bundle").steps ?? [];
    const download = bundle.findIndex((step) => usesAction(step, "actions/download-artifact") && step.with?.name === "compiled-${{ matrix.triple }}");
    const unpack = bundle.findIndex((step) => /(^|\s)tar -xf compiled\.tar(\s|$)/m.test(scriptOf(step)));
    assert.ok(download !== -1 && download < unpack && unpack < bundle.findIndex(isTauriBundle), "the bundle job must unpack compiled.tar before it bundles");
  });

  yamlTest("Tauri signs the macOS app with APPLE_SIGNING_IDENTITY alone, from a keychain the job makes", () => {
    // tauri-macos-sign's own import (APPLE_CERTIFICATE) finds only identities
    // named like Apple's, never a self-signed one, and fails the build.
    const steps = jobOf(BUILD, "bundle").steps ?? [];
    const problems = steps
      .filter((step) => Object.keys(step.env ?? {}).some((name) => name.startsWith("APPLE_CERTIFICATE")) && isTauriBundle(step))
      .map((step) => `${step.name ?? "a tauri bundle"} gets APPLE_CERTIFICATE`);
    problems.push(...steps.filter((step) => /APPLE_CERTIFICATE[A-Z_]*=/.test(scriptOf(step))).map((step) => `${step.name ?? "a step"} sets APPLE_CERTIFICATE for later steps`));
    assert.deepEqual(problems, [], problems.join("\n"));
    const keychains = steps.filter((step) => /security create-keychain/.test(scriptOf(step)));
    assert.deepEqual(
      keychains.map((step) => [requires(step.if, "runner.os == 'macOS'"), requires(step.if, RELEASE_ONLY) || requires(step.if, DRY_RUN_ONLY)]),
      [
        [true, true],
        [true, true],
      ],
      "a macOS keychain is made once in each environment, on macOS only",
    );
    const cleanup = steps.find((step) => /security delete-keychain/.test(scriptOf(step)));
    assert.ok(cleanup && requires(cleanup.if, "always()"), "the keychain isn't deleted whatever happened");
  });

  yamlTest("scan-secrets.mjs scans the UI and the binaries after the bundling", () => {
    const steps = jobOf(BUILD, "bundle").steps ?? [];
    const scan = steps.findIndex((step) => scriptOf(step).includes("scan-secrets.mjs"));
    assert.ok(scan !== -1, "the bundle job doesn't run scan-secrets.mjs");
    assert.ok(scan > steps.findLastIndex(isTauriBundle), "scan-secrets.mjs runs before a tauri bundle");
    assert.equal(steps[scan].if, undefined, "the secret scan must run in every build");
    const script = scriptOf(steps[scan]);
    for (const path of [/\sdist\s/, /release\/fleetify-app/, /release\/fleet-\*-mcp/]) {
      assert.match(script, path, `the secret scan misses ${path}`);
    }
  });

  scriptTest("the updater check fails a release build with the dry run's overlay, and a dry run without it", () => {
    const steps = jobOf(BUILD, "bundle").steps ?? [];
    const step = steps.find((candidate) => scriptOf(candidate).includes("127.0.0.1:18080/update"));
    assert.ok(step, "the bundle job doesn't check the updater settings compiled into the app");
    assert.equal(step.if, undefined, "the check must run in release builds and dry runs alike");
    assert.ok(steps.indexOf(step) > steps.findLastIndex(isTauriBundle), "the check runs before a tauri bundle");
    const shipped = JSON.parse(read("src-tauri/tauri.conf.json")).plugins.updater;
    const [overlay] = dryRunConfig({ pubkey: shipped.pubkey }).plugins.updater.endpoints;
    const triple = "x86_64-unknown-linux-gnu";
    inTempDir((dir) => {
      mkdirSync(join(dir, "src-tauri"));
      copyFileSync(join(ROOT, "src-tauri/tauri.conf.json"), join(dir, "src-tauri/tauri.conf.json"));
      mkdirSync(join(dir, "target", triple, "release"), { recursive: true });
      const check = (environment, strings) => {
        // A stand-in binary: the strings among bytes that aren't text.
        const bytes = [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00]), ...strings.map((s) => Buffer.from(`${s}\0\x01`))];
        writeFileSync(join(dir, "target", triple, "release", "fleetify-app"), Buffer.concat(bytes));
        const result = runScript(step.run, { cwd: dir, env: { ENVIRONMENT: environment, TRIPLE: triple, RUNNER_OS: "Linux" } });
        return { status: result.status, output: `${result.stdout}${result.stderr}` };
      };
      const shippedStrings = [shipped.pubkey, ...shipped.endpoints];
      const cases = [
        { why: "a release build with the shipped settings", environment: "release", strings: shippedStrings, status: 0 },
        { why: "a release build with the overlay's endpoint", environment: "release", strings: [...shippedStrings, overlay], status: 1 },
        { why: "a release build without a shipped endpoint", environment: "release", strings: shippedStrings.slice(0, -1), status: 1 },
        { why: "a release build without the shipped key", environment: "release", strings: shipped.endpoints, status: 1 },
        { why: "a dry run with the overlay", environment: "dry-run", strings: [overlay], status: 0 },
        { why: "a dry run without the overlay", environment: "dry-run", strings: shippedStrings, status: 1 },
      ];
      for (const { why, environment, strings, status } of cases) {
        const result = check(environment, strings);
        assert.equal(result.status, status, `${why}: exit ${result.status}, expected ${status}\n${result.output}`);
      }
    });
  });

  yamlTest("collect-bundles.mjs fills an empty folder before anything else goes in", () => {
    // collect refuses a folder that holds anything, so the artifact holds only this build's files.
    const steps = jobOf(BUILD, "bundle").steps ?? [];
    const collect = steps.findIndex((step) => scriptOf(step).includes("collect-bundles.mjs"));
    assert.ok(collect !== -1, "the bundle job doesn't run collect-bundles.mjs");
    assert.match(scriptOf(steps[collect]), /--out "\$RUNNER_TEMP\/bundles"/);
    const earlier = steps
      .slice(0, collect)
      .filter((step) => /RUNNER_TEMP\/bundles|runner\.temp \}\}\/bundles/.test(textOf(step)))
      .map(stepLabel);
    assert.deepEqual(earlier, [], "these steps use the bundles folder before collect-bundles.mjs fills it");
    const upload = steps.findIndex((step) => usesAction(step, "actions/upload-artifact") && step.with?.name === "bundles-${{ matrix.triple }}");
    assert.ok(upload !== -1, "the bundle job doesn't upload bundles-<triple>");
    assert.deepEqual([steps[upload].with?.path, steps[upload].with?.["if-no-files-found"], steps[upload].with?.["retention-days"]], ["${{ runner.temp }}/bundles", "error", 7]);
    for (const file of ["updater-pubkey.txt", "LINUX-APPIMAGE-LIBRARIES.txt"]) {
      const at = steps.findIndex((step) => textOf(step).includes(file));
      assert.ok(at > collect && at < upload, `${file} isn't added after collect-bundles.mjs and before the upload`);
    }
  });

  yamlTest("both build jobs install CONTRIBUTING's Linux packages", () => {
    // compile builds against them; bundle's AppImage carries the libraries,
    // which linuxdeploy copies from the system.
    const documented = aptPackages(codeBlockUnder("CONTRIBUTING.md", "### Linux"));
    for (const id of ["compile", "bundle"]) {
      const installed = new Set((jobOf(BUILD, id).steps ?? []).flatMap((step) => aptPackages(scriptOf(step))));
      assert.deepEqual(documented.filter((name) => !installed.has(name)), [], `job ${id} misses these packages that CONTRIBUTING.md lists`);
    }
  });

  yamlTest("a macOS dry run keeps codesign's own output, whatever the checks say", () => {
    // So the codesign fixtures of macos-signature.test.mjs can be replaced with real output.
    const steps = jobOf(BUILD, "bundle").steps ?? [];
    const when = ["always()", DRY_RUN_ONLY, "runner.os == 'macOS'"];
    const capture = steps.find((step) => /\bcodesign\b/.test(scriptOf(step)) && ["--verify", "-r-", "-vvv", "--entitlements"].every((arg) => scriptOf(step).includes(arg)) && !scriptOf(step).includes("macos-signature.mjs"));
    assert.ok(capture, "no step keeps the output of the four codesign commands");
    assert.deepEqual(when.filter((clause) => !requires(capture.if, clause)), [], `the capture's condition must hold ${when.join(" && ")}`);
    const upload = steps.find((step) => usesAction(step, "actions/upload-artifact") && String(step.with?.name).startsWith("codesign-output-"));
    assert.ok(upload, "codesign's output isn't uploaded");
    assert.deepEqual([upload.with.name, upload.with["retention-days"]], ["codesign-output-${{ matrix.triple }}", 7]);
    assert.deepEqual(when.filter((clause) => !requires(upload.if, clause)), [], `the upload's condition must hold ${when.join(" && ")}`);
  });
});

describe("release-dry-run.yml", () => {
  yamlTest("it runs on dispatch, on pushes to main, on Mondays and on pull requests that touch a release path", () => {
    const flow = workflow(DRY_RUN);
    const on = triggersOf(flow);
    assert.deepEqual(Object.keys(on).sort(), ["pull_request", "push", "schedule", "workflow_dispatch"]);
    assert.deepEqual(on.push, { branches: ["main"] });
    assert.deepEqual(on.schedule, [{ cron: "0 5 * * 1" }]);
    assert.deepEqual(Object.keys(on.pull_request ?? {}), ["paths"], "pull requests are filtered by paths alone");
    assert.deepEqual([...on.pull_request.paths].sort(), [...DRY_RUN_PATHS].sort());
    assert.deepEqual(Object.keys(on.workflow_dispatch?.inputs ?? {}), ["signing"], "dispatch takes one input, signing");
    const { description, ...signing } = on.workflow_dispatch.inputs.signing;
    assert.ok(typeof description === "string" && description !== "", "signing has no description");
    assert.deepEqual(signing, { required: true, type: "choice", options: ["ephemeral", "release"], default: "ephemeral" });
    assert.deepEqual(flow.concurrency, {
      group: "release-dry-run-${{ github.event_name }}-${{ github.ref }}-${{ inputs.signing }}",
      "cancel-in-progress": "${{ github.event_name != 'workflow_dispatch' }}",
    });
  });

  scriptTest("meta skips release commits, picks the environment and signs with the release keys only from main", () => {
    const meta = jobOf(DRY_RUN, "meta");
    assert.equal(
      String(meta.if).replace(/\s+/g, " ").trim(),
      "github.event_name != 'push' || !startsWith(github.event.head_commit.message, 'chore(main): release')",
    );
    const step = (meta.steps ?? []).find((candidate) => candidate.id === "meta");
    assert.ok(step, "meta has no step with id meta");
    assert.equal(step.env?.SIGNING, "${{ inputs.signing }}");
    assert.deepEqual(meta.outputs, { version: "${{ steps.meta.outputs.version }}", environment: "${{ steps.meta.outputs.environment }}" });
    inTempDir((dir) => {
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ version: "1.2.3" })}\n`);
      const run = (signing, ref) => {
        const output = join(dir, "github-output");
        writeFileSync(output, "");
        const result = runScript(step.run, { cwd: dir, env: { SIGNING: signing, GITHUB_REF: ref, GITHUB_OUTPUT: output } });
        return { status: result.status, output: readFileSync(output, "utf8"), log: `${result.stdout}${result.stderr}` };
      };
      for (const [signing, ref, environment] of [
        ["", "refs/heads/main", "dry-run"],
        ["ephemeral", "refs/pull/7/merge", "dry-run"],
        ["release", "refs/heads/main", "release"],
      ]) {
        const result = run(signing, ref);
        assert.equal(result.status, 0, `signing "${signing}" on ${ref}:\n${result.log}`);
        assert.equal(result.output, `version=1.2.3\nenvironment=${environment}\n`, `signing "${signing}" on ${ref}`);
      }
      const offMain = run("release", "refs/heads/feature");
      assert.notEqual(offMain.status, 0, "signing: release off main must fail");
      assert.equal(offMain.output, "", "signing: release off main wrote outputs");
    });
  });

  yamlTest("it builds the commit it runs on, in the environment meta picks", () => {
    const build = jobOf(DRY_RUN, "build");
    assert.equal(build.uses, "./.github/workflows/build.yml");
    assert.deepEqual([build.needs].flat(), ["meta"]);
    assert.deepEqual(build.with, {
      ref: "${{ github.sha }}",
      environment: "${{ needs.meta.outputs.environment }}",
      version: "${{ needs.meta.outputs.version }}",
    });
  });

  yamlTest("assemble checks a dry run against each build's own key, and release signing against the shipped one", () => {
    const runs = (jobOf(DRY_RUN, "assemble").steps ?? []).filter((step) => scriptOf(step).includes("assemble.mjs"));
    const dryRun = runs.filter((step) => requires(step.if, "needs.meta.outputs.environment == 'dry-run'"));
    const release = runs.filter((step) => requires(step.if, "needs.meta.outputs.environment == 'release'"));
    assert.deepEqual([runs.length, dryRun.length, release.length], [2, 1, 1], "assemble must run once per environment");
    assert.match(scriptOf(dryRun[0]), /\s--per-target-pubkeys(\s|$)/);
    assert.doesNotMatch(scriptOf(dryRun[0]), /--pubkey-config|--expect-key-id/);
    assert.match(scriptOf(release[0]), new RegExp(`\\s--pubkey-config src-tauri/tauri\\.conf\\.json --expect-key-id ${UPDATER_KEY_ID}(\\s|$)`));
    assert.doesNotMatch(scriptOf(release[0]), /--per-target-pubkeys/);
  });

  yamlTest("assemble downloads only the bundles and the notices", () => {
    // assemble.mjs refuses any other folder in --in.
    const steps = jobOf(DRY_RUN, "assemble").steps ?? [];
    const downloads = steps
      .filter((step) => usesAction(step, "actions/download-artifact"))
      .map((step) => ({ what: step.with?.name ?? step.with?.pattern ?? "every artifact", path: step.with?.path, merge: step.with?.["merge-multiple"] ?? false }));
    assert.deepEqual(downloads.sort((a, b) => (a.what < b.what ? -1 : 1)), [
      { what: "bundles-*", path: "artifacts", merge: false },
      { what: "third-party-notices", path: "artifacts/third-party-notices", merge: false },
    ]);
    const upload = steps.find((step) => usesAction(step, "actions/upload-artifact"));
    assert.deepEqual(
      [upload?.with?.name, upload?.with?.path, upload?.with?.["if-no-files-found"], upload?.with?.["retention-days"]],
      ["release", "release", "error", 14],
    );
  });
});

const SMOKE = `${WORKFLOWS}/smoke.yml`;

/** What `dpkg -L fleetify` lists for an installed .deb, in part. */
const DPKG_LIST = [
  "/.",
  "/usr",
  "/usr/bin",
  "/usr/bin/fleet-browser-mcp",
  "/usr/bin/fleet-dispatch-mcp",
  "/usr/bin/fleet-memory-mcp",
  "/usr/bin/fleet-reveng-mcp",
  "/usr/bin/fleetify-app",
  "/usr/lib",
  "/usr/lib/Fleetify",
  "/usr/lib/Fleetify/legal",
  "/usr/lib/Fleetify/legal/LICENSE",
  "/usr/lib/Fleetify/legal/NOTICE",
  "/usr/lib/Fleetify/legal/THIRD-PARTY-NOTICES",
  "/usr/share/applications/Fleetify.desktop",
];

/**
 * Run a smoke step's script with stand-ins for what it calls, and return
 * each call of node: { args, wrappers }. node records its arguments;
 * xvfb-run and dbus-run-session record that they wrapped it, with their
 * flags; sudo does nothing; dpkg and plutil answer as for an installed
 * Fleetify. The script runs in a folder whose release/ holds a stand-in
 * AppImage and .deb of version 1.2.3, with RUNNER_TEMP inside it.
 */
function runSmokeStep(script, env) {
  return inTempDir((dir) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "release"));
    mkdirSync(join(dir, "runner-temp"));
    for (const name of ["Fleetify_1.2.3_amd64.AppImage", "Fleetify_1.2.3_amd64.deb"]) writeFileSync(join(dir, "release", name), "");
    const log = join(dir, "node-calls.jsonl");
    writeFileSync(
      join(dir, "record.mjs"),
      'import { appendFileSync } from "node:fs";\n' +
        "appendFileSync(process.env.STUB_LOG, `${JSON.stringify({ args: process.argv.slice(2), wrappers: process.env.SMOKE_WRAPPERS ?? \"\" })}\\n`);\n",
    );
    const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("node", `exec "${process.execPath}" "${join(dir, "record.mjs")}" "$@"`);
    stub("xvfb-run", 'flags=""\nif [ "$1" = -a ]; then flags=" -a"; shift; fi\nSMOKE_WRAPPERS="${SMOKE_WRAPPERS}xvfb-run$flags > " exec "$@"');
    stub("dbus-run-session", 'flags=""\nif [ "$1" = -- ]; then flags=" --"; shift; fi\nSMOKE_WRAPPERS="${SMOKE_WRAPPERS}dbus-run-session$flags > " exec "$@"');
    stub("sudo", "exit 0");
    stub("dpkg", `[ "$1" = -L ] && [ "$2" = fleetify ] || exit 1\ncat <<'LIST'\n${DPKG_LIST.join("\n")}\nLIST`);
    stub("plutil", "echo fleetify-app");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, RUNNER_TEMP: join(dir, "runner-temp"), STUB_LOG: log, ...env },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `the step's script failed:\n${result.stdout}${result.stderr}`);
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    // Paths under the temporary folder, made relative so the checks can name them.
    const relative = (text) => text.split(dir).join("<dir>");
    return calls.map(({ args, wrappers }) => ({ args: args.map(relative), wrappers }));
  });
}

/** The value after `flag` in `args`, or undefined; each flag appears once at most. */
function argValue(args, flag) {
  const at = args.indexOf(flag);
  assert.ok(args.indexOf(flag, at + 1) === -1 || at === -1, `${flag} is given twice: ${args.join(" ")}`);
  return at === -1 ? undefined : args[at + 1];
}

/** The two variable settings each launch step runs with: none set, and all set. */
const SMOKE_SETTINGS = [
  { CSP_ORIGIN: "", EXPECT_POSTHOG_SINK: "false", REHEARSE: "false" },
  { CSP_ORIGIN: "https://eu.i.posthog.com", EXPECT_POSTHOG_SINK: "true", REHEARSE: "true" },
];

let smokeLaunches;

/**
 * Every launch step of smoke.yml, run under each of SMOKE_SETTINGS:
 * { job, step, runs: [{ settings, calls }] }. Run once, as each run starts
 * bash and node.
 */
function launches() {
  smokeLaunches ??= Object.entries(workflow(SMOKE).jobs ?? {}).flatMap(([job, { steps = [] }]) =>
    steps
      .filter((step) => scriptOf(step).includes("launch-smoke.mjs"))
      .map((step) => ({
        job,
        step,
        runs: SMOKE_SETTINGS.map((settings) => ({
          settings,
          calls: runSmokeStep(step.run, {
            VERSION: "1.2.3",
            APP_EXE: "C:\\Users\\runner\\AppData\\Local\\Fleetify\\fleetify-app.exe",
            LEGAL_DIR: "C:\\Users\\runner\\AppData\\Local\\Fleetify\\legal",
            ...settings,
          }),
        })),
      })),
  );
  return smokeLaunches;
}

/** A launch step's bundle type: the one it rehearses with when asked to. */
const bundleTypeOf = ({ runs }) => argValue(runs[1].calls[0]?.args ?? [], "--bundle-type");

describe("smoke.yml", () => {
  yamlTest("it takes the version, whether to rehearse an update, and a pinned designated requirement", () => {
    const inputs = triggersOf(workflow(SMOKE)).workflow_call?.inputs ?? {};
    assert.deepEqual(Object.keys(inputs).sort(), ["expected-dr", "rehearse", "version"]);
    const shape = ({ type, required, default: fallback }) => ({ type, required, default: fallback });
    assert.deepEqual(shape(inputs.version), { type: "string", required: true, default: undefined });
    assert.deepEqual(shape(inputs.rehearse), { type: "boolean", required: true, default: undefined });
    assert.deepEqual(shape(inputs["expected-dr"]), { type: "string", required: false, default: "" });
    assert.deepEqual(
      Object.fromEntries(["VERSION", "REHEARSE", "EXPECTED_DR", "CSP_ORIGIN", "EXPECT_POSTHOG_SINK"].map((name) => [name, workflow(SMOKE).env?.[name]])),
      {
        VERSION: "${{ inputs.version }}",
        REHEARSE: "${{ inputs.rehearse }}",
        EXPECTED_DR: "${{ inputs.expected-dr }}",
        CSP_ORIGIN: "${{ vars.VITE_POSTHOG_HOST }}",
        EXPECT_POSTHOG_SINK: "${{ vars.POSTHOG_API_KEY != '' }}",
      },
    );
  });

  yamlTest("each job checks out only scripts/release, into tools/, and runs the scripts from there", () => {
    // Without the source tree at the workspace's root, nothing the bundles
    // do can lean on it, as nothing a user runs can.
    const nvmrc = read(".nvmrc").trim();
    for (const [id, job] of Object.entries(workflow(SMOKE).jobs ?? {})) {
      const steps = job.steps ?? [];
      const checkouts = steps.filter((step) => usesAction(step, "actions/checkout"));
      assert.equal(checkouts.length, 1, `job ${id} must check out once`);
      assert.deepEqual(checkouts[0].with, { path: "tools", "sparse-checkout": "scripts/release", "sparse-checkout-cone-mode": false, "persist-credentials": false }, `job ${id}'s checkout`);
      const node = steps.find((step) => usesAction(step, "actions/setup-node"));
      assert.equal(String(node?.with?.["node-version"]), nvmrc, `job ${id} must set up Node ${nvmrc}, as .nvmrc says (it isn't checked out)`);
      const download = steps.find((step) => usesAction(step, "actions/download-artifact"));
      assert.deepEqual(download?.with, { name: "release", path: "release" }, `job ${id} must download the release into release/`);
      const stray = steps.flatMap((step) => scriptOf(step).split("\n")).filter((line) => /(?<!tools\/)\bscripts\//.test(line));
      assert.deepEqual(stray, [], `job ${id} runs scripts from outside tools/`);
    }
  });

  scriptTest("each launch passes the CSP origin as given, empty or not, and expects the PostHog sink only when the key is set", () => {
    assert.equal(launches().length, 4, "smoke.yml must launch the AppImage, the .deb, the NSIS install and the macOS app");
    for (const { job, step, runs } of launches()) {
      for (const { settings, calls } of runs) {
        const where = `job ${job}, ${step.name ?? "a launch"}, with ${JSON.stringify(settings)}`;
        assert.equal(calls.length, 1, `${where}: launch-smoke.mjs must run once`);
        const [{ args }] = calls;
        assert.deepEqual(args.slice(0, 2), ["tools/scripts/release/launch-smoke.mjs", "run"], where);
        assert.equal(argValue(args, "--csp-origin"), settings.CSP_ORIGIN, `${where}: the CSP origin must be passed quoted`);
        assert.equal(args.includes("--expect-posthog-sink"), settings.EXPECT_POSTHOG_SINK === "true", `${where}: --expect-posthog-sink`);
      }
    }
  });

  scriptTest("each launch rehearses an update of its own bundle type when asked, and only then, in a home of its own", () => {
    const types = [];
    const homes = new Set();
    for (const launch of launches()) {
      const { job, runs } = launch;
      const [plain, all] = runs.map(({ calls }) => calls[0]?.args ?? []);
      assert.deepEqual([argValue(plain, "--rehearse"), argValue(plain, "--bundle-type")], [undefined, undefined], `job ${job} rehearses unasked`);
      assert.equal(argValue(all, "--rehearse"), "release", `job ${job} doesn't rehearse against release/ when asked`);
      const type = bundleTypeOf(launch);
      types.push(type);
      for (const args of [plain, all]) assert.equal(argValue(args, "--home"), `<dir>/runner-temp/home-${type}`, `job ${job}'s home`);
      homes.add(argValue(all, "--home"));
    }
    assert.deepEqual(types.sort(), ["app", "appimage", "deb", "nsis"]);
    assert.equal(homes.size, types.length, "two launches share a home");
  });

  scriptTest("each bundle starts the way a user starts it", () => {
    const byType = Object.fromEntries(launches().map((launch) => [bundleTypeOf(launch), launch]));
    const callOf = (type) => byType[type].runs[1].calls[0];
    const linux = "xvfb-run -a > dbus-run-session -- > ";
    // The AppImage runs extracted, as on a system without FUSE; the smoke
    // reads the app's real working directory from /proc on Linux.
    const appimage = callOf("appimage");
    assert.equal(appimage.wrappers, linux);
    assert.equal(argValue(appimage.args, "--app"), "release/Fleetify_1.2.3_amd64.AppImage");
    assert.equal(argValue(appimage.args, "--app-arg"), "--appimage-extract-and-run");
    const deb = callOf("deb");
    assert.equal(deb.wrappers, linux);
    assert.deepEqual([argValue(deb.args, "--app"), argValue(deb.args, "--legal-dir")], ["/usr/bin/fleetify-app", "/usr/lib/Fleetify/legal"]);
    const nsis = callOf("nsis");
    assert.equal(nsis.wrappers, "");
    assert.deepEqual(
      [argValue(nsis.args, "--app"), argValue(nsis.args, "--cwd"), argValue(nsis.args, "--legal-dir")],
      ["C:\\Users\\runner\\AppData\\Local\\Fleetify\\fleetify-app.exe", "C:\\", "C:\\Users\\runner\\AppData\\Local\\Fleetify\\legal"],
    );
    const app = callOf("app");
    assert.equal(app.wrappers, "");
    assert.deepEqual(
      [argValue(app.args, "--app"), argValue(app.args, "--legal-dir")],
      ["<dir>/runner-temp/Applications/Fleetify.app/Contents/MacOS/fleetify-app", "<dir>/runner-temp/Applications/Fleetify.app/Contents/Resources/legal"],
    );
  });

  scriptTest("the macOS signature check gets --expected-dr only when one is given", () => {
    // An empty --expected-dr is a usage error; a pinned one is read from tools/.
    const steps = jobOf(SMOKE, "macos").steps ?? [];
    const check = steps.find((step) => scriptOf(step).includes("macos-signature.mjs"));
    assert.ok(check, "the macOS job doesn't check the app's signature");
    assert.ok(steps.indexOf(check) < steps.findIndex((step) => scriptOf(step).includes("launch-smoke.mjs")), "the signature is checked before the launch");
    const [shapeOnly] = runSmokeStep(check.run, { EXPECTED_DR: "" });
    assert.deepEqual(shapeOnly.args, ["tools/scripts/release/macos-signature.mjs", "<dir>/runner-temp/dmg/Fleetify.app"]);
    const [pinned] = runSmokeStep(check.run, { EXPECTED_DR: "scripts/release/macos-designated-requirement.txt" });
    assert.deepEqual(pinned.args, [
      "tools/scripts/release/macos-signature.mjs",
      "<dir>/runner-temp/dmg/Fleetify.app",
      "--expected-dr",
      "tools/scripts/release/macos-designated-requirement.txt",
    ]);
  });

  yamlTest("the .rpm resolves on Fedora, and on openSUSE for information", () => {
    const steps = jobOf(SMOKE, "linux").steps ?? [];
    const fedora = steps.filter((step) => /docker run .*\bfedora:\d+ dnf install -y --nogpgcheck /.test(scriptOf(step)));
    assert.equal(fedora.length, 1, "the Linux job must install the .rpm with dnf in a Fedora container");
    assert.equal(fedora[0]["continue-on-error"], undefined, "Fedora's resolution must fail the job");
    const suse = steps.filter((step) => /docker run .*\bopensuse\/tumbleweed zypper --non-interactive install --allow-unsigned-rpm /.test(scriptOf(step)));
    assert.deepEqual(suse.map((step) => [step.name, step["continue-on-error"]]), [["openSUSE rpm resolution (informational)", true]]);
  });

  yamlTest("a failed smoke keeps its homes and the app's logs", () => {
    const names = [];
    for (const [id, job] of Object.entries(workflow(SMOKE).jobs ?? {})) {
      const upload = (job.steps ?? []).find((step) => usesAction(step, "actions/upload-artifact") && requires(step.if, "failure()"));
      assert.ok(upload, `job ${id} uploads nothing when it fails`);
      // The homes hold .fleetify and .local, which the upload skips unless told otherwise.
      assert.deepEqual([upload.with?.path, upload.with?.["include-hidden-files"], upload.with?.["retention-days"]], ["${{ runner.temp }}/home-*", true, 7], `job ${id}`);
      assert.match(String(upload.with?.name), /^smoke-logs-/, `job ${id}`);
      names.push(String(upload.with.name).replace("${{ matrix.arch }}", "<arch>"));
    }
    assert.equal(new Set(names).size, names.length, "two jobs upload logs under one name");
  });
});

describe("release-dry-run.yml's smoke", () => {
  yamlTest("it smoke-tests the assembled release, rehearsing updates only with a dry-run build", () => {
    // Only a dry-run build's updater asks the smoke's update server.
    const smoke = jobOf(DRY_RUN, "smoke");
    assert.equal(smoke.uses, "./.github/workflows/smoke.yml");
    assert.deepEqual([smoke.needs].flat().sort(), ["assemble", "meta"]);
    assert.deepEqual(smoke.with, { version: "${{ needs.meta.outputs.version }}", rehearse: "${{ needs.meta.outputs.environment == 'dry-run' }}" });
  });
});

describe("actionlint", () => {
  yamlTest("CI lints the workflows with actionlint, from an image pinned by digest", () => {
    const rel = `${WORKFLOWS}/ci.yml`;
    const lint = (jobOf(rel, "web").steps ?? []).filter((step) => /^docker:\/\/rhysd\/actionlint\b/.test(String(step.uses ?? "")));
    assert.equal(lint.length, 1, "ci.yml's web job must run actionlint once");
    const [step] = lint;
    assert.match(step.uses, /^docker:\/\/rhysd\/actionlint(:[\w.-]+)?@sha256:[0-9a-f]{64}$/, "the actionlint image must be pinned by digest");
    assert.equal(step["continue-on-error"], undefined, "actionlint must be a hard gate");
    const line = read(rel)
      .split(/\r?\n/)
      .find((text) => text.includes(step.uses));
    assert.match(line ?? "", /#\s*v\d+\.\d+\.\d+\s*$/, "the digest needs a comment naming its release");
  });

  test("the documented gates end with actionlint, as ci.yml runs it after the script tests", () => {
    for (const [file, heading] of [
      ["CONTRIBUTING.md", "## The gates"],
      ["CLAUDE.md", "### Unit + integration (gates that run in CI)"],
    ]) {
      const commands = codeBlockUnder(file, heading)
        .split("\n")
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter(Boolean);
      assert.equal(commands.at(-1), "actionlint", `${file}'s gate list must end with actionlint`);
    }
  });
});
