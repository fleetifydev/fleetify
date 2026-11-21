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
 * read` at the top. build.yml builds release-assets.mjs's TARGETS. Its jobs
 * that hold the signing keys run only GitHub's own actions, the lockfile's
 * Tauri CLI, system tools and the repository's scripts, get the release
 * secrets only in release-only steps, and check every artifact they take
 * before using it. A release build gets nothing of a dry run's: no cache,
 * none of the keys a dry run makes, no updater overlay. The dry run assembles with each build's own
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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { compiledFiles } from "../release/compiled-tar.mjs";
import { dryRunConfig } from "../release/dry-run-config.mjs";
import { TARGETS, UPDATER_KEY_ID, unsignedAssets, updaterAssets } from "../release/release-assets.mjs";

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
 * Whether a line of shell runs cargo itself: it calls cargo or the Tauri CLI
 * (but for its signer, which signs files and builds nothing), or a script of
 * the repo's that calls them: the sidecar build (build-sidecars.mjs, `npm run
 * build:sidecars`), whose `--check` only reads the config, and
 * dev-tauri-wt.mjs, which starts `tauri dev`.
 */
const lineRunsCargo = (line) =>
  /(^|[\s;&|(])cargo(\s|$)/.test(line) ||
  (/(^|[\s;&|(])tauri(\s|$)/.test(line) && !/(^|\s)tauri signer\s/.test(line)) ||
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
  "src-tauri/Info.plist",
  "src-tauri/build.rs",
  "src-tauri/capabilities/**",
  "src-tauri/icons/**",
  "src-tauri/Cargo.toml",
  "Cargo.toml",
  "package.json",
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
  ".nvmrc",
  "vendor/**",
];

/**
 * The `${{ }}` expressions in `text` that read a secret, in whatever form:
 * secrets.X, secrets['X'], toJSON(secrets), format('{0}', secrets.X). Each
 * expression is read to its closing }}.
 */
function secretExpressions(text) {
  return [...String(text).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].filter(([, inside]) => /\bsecrets\b/.test(inside)).map(([whole]) => whole);
}

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
  { marker: "macos-keychain.sh dry-run", what: "makes the run's own code-signing identity" },
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

/** The jobs of build.yml that run in the caller's environment, with the signing keys. */
const KEYED_JOBS = ["sign", "bundle-macos"];

/** The actions a job with the keys may run: GitHub's own (another test checks each is pinned to a commit). */
const KEYED_ACTIONS = ["actions/checkout", "actions/download-artifact", "actions/setup-node", "actions/upload-artifact"];

/** The secrets a release build signs with. */
const RELEASE_SECRETS = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"];

/** Whether a release target is a macOS one: its bundles are signed inside, in bundle-macos. */
const isMacOS = ({ bundles }) => bundles.includes("app");

const TAR_SKIP = spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0 ? false : "tar is needed to pack a hand-off";

const MACOS_ONLY = "runner.os == 'macOS'";
const NOT_MACOS = "runner.os != 'macOS'";

/** A build.yml job's steps. */
const stepsOf = (id) => jobOf(BUILD, id).steps ?? [];

/** The commands of a step's script: its lines, trimmed, without blank lines and comments. */
const commandLines = (step) =>
  scriptOf(step)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

/** Words that start or join a compound command, after which a command still comes. */
const RESERVED_WORDS = new Set(["!", "{", "}", "case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "select", "then", "time", "until", "while"]);

/** A redirection's operator, after any file descriptor number, and a descriptor it duplicates. */
const REDIRECT = /^(&>>|&>|<<<|<<-|<<|<&|>&|>>|>\||<>|<|>)(-|[0-9]+)?/;
/** The redirections that write to their target. */
const WRITES = new Set(["&>>", "&>", ">&", ">>", ">|", "<>", ">"]);

/**
 * The simple commands a bash script runs, as { words, assignments,
 * redirects } each: words with their quotes taken off; assignments, the
 * NAME=value words before the command, as { name, value }; redirects, its
 * redirections, as { op, target }. The commands inside $( ), <( ), >( ),
 * backquotes, ${ } and $(( )) are listed too, wherever they are, and so are
 * a function's; a function's name shows as a command where it is defined.
 * It reads enough of bash for the workflows' scripts: quotes, escapes,
 * expansions, substitutions, operators, redirections, reserved words and
 * array assignments. A here-document's text isn't read; the rules refuse
 * here-documents.
 *
 * @param {string} script
 * @returns {{ words: string[], assignments: { name: string, value: string }[], redirects: { op: string, target: string }[] }[]}
 */
function simpleCommands(script) {
  const commands = [];
  let i = 0;
  /** Past a single-quoted string, from its opening quote. */
  const skipSingle = () => {
    const end = script.indexOf("'", i + 1);
    i = end === -1 ? script.length : end + 1;
  };
  /**
   * At a $( ), <( ), >( ), backquote, ${ } or $(( )), read past it, listing
   * the commands inside: true; else false. <( and >( count where
   * `processes`, outside double quotes.
   */
  const substitution = (processes) => {
    if (script.startsWith("$((", i)) {
      i += 3;
      inside("))");
    } else if (script.startsWith("$(", i) || (processes && (script.startsWith("<(", i) || script.startsWith(">(", i)))) {
      i += 2;
      list(")");
    } else if (script.startsWith("${", i)) {
      i += 2;
      inside("}");
    } else if (script[i] === "`") {
      i += 1;
      list("`");
    } else {
      return false;
    }
    return true;
  };
  /** Past the rest of a ${ } or $(( )), up to `close`, listing the commands of its substitutions. */
  const inside = (close) => {
    let depth = 0;
    while (i < script.length) {
      if (depth === 0 && script.startsWith(close, i)) {
        i += close.length;
        return;
      }
      const c = script[i];
      if (c === "\\") i += 2;
      else if (c === "'") skipSingle();
      else if (c === '"') {
        i += 1;
        quoted();
      } else if (!substitution(false)) {
        if (close === "))" && c === "(") depth += 1;
        else if (close === "))" && c === ")") depth -= 1;
        i += 1;
      }
    }
  };
  /** Past the rest of a double-quoted string, from just inside it; its text, quotes off. */
  const quoted = () => {
    let text = "";
    while (i < script.length && script[i] !== '"') {
      const start = i;
      if (script[i] === "\\") {
        text += script[i + 1] ?? "";
        i += 2;
      } else if (substitution(false)) {
        text += script.slice(start, i);
      } else {
        text += script[i];
        i += 1;
      }
    }
    i += 1;
    return text;
  };
  /** A list of commands, up to `closer` (")" or "`"), or to the end. */
  const list = (closer) => {
    let command = { words: [], assignments: [], redirects: [] };
    let word = null;
    let raw = "";
    let op = null;
    let skipping = false;
    const add = (text, written = text) => {
      word = (word ?? "") + text;
      raw += written;
    };
    const endWord = () => {
      if (word === null) return;
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/.exec(raw);
      if (op !== null) {
        command.redirects.push({ op, target: word });
        op = null;
      } else if (command.words.length === 0 && assignment) {
        command.assignments.push({ name: assignment[1], value: word.slice(word.indexOf("=") + 1) });
      } else if (command.words.length === 0 && RESERVED_WORDS.has(raw)) {
        // for and select name a variable and a list, not a command.
        if (raw === "for" || raw === "select") skipping = true;
      } else if (!skipping) {
        command.words.push(word);
      }
      word = null;
      raw = "";
    };
    const endCommand = () => {
      endWord();
      if (op !== null) command.redirects.push({ op, target: "" });
      op = null;
      if (command.words.length + command.assignments.length + command.redirects.length > 0) commands.push(command);
      command = { words: [], assignments: [], redirects: [] };
      skipping = false;
    };
    while (i < script.length) {
      const c = script[i];
      const start = i;
      if (closer !== undefined && c === closer) {
        endCommand();
        i += 1;
        return;
      }
      if (c === "\\") {
        if (script[i + 1] !== "\n") add(script[i + 1] ?? "", script.slice(i, i + 2));
        i += 2;
      } else if (c === "'") {
        skipSingle();
        add(script.slice(start + 1, i - 1), script.slice(start, i));
      } else if (c === '"') {
        i += 1;
        const text = quoted();
        add(text, script.slice(start, i));
      } else if (c === "#" && word === null) {
        const end = script.indexOf("\n", i);
        i = end === -1 ? script.length : end;
      } else if (c === "(" && word !== null && raw.endsWith("=")) {
        // An array assignment's list, whose words can hold substitutions.
        i += 1;
        while (i < script.length && script[i] !== ")") {
          if (script[i] === "\\") i += 2;
          else if (script[i] === "'") skipSingle();
          else if (script[i] === '"') {
            i += 1;
            quoted();
          } else if (!substitution(true)) i += 1;
        }
        i += 1;
        add(script.slice(start, i));
      } else if (substitution(true)) {
        add(script.slice(start, i));
      } else {
        const rest = script.slice(i);
        const redirect = REDIRECT.exec(rest);
        if (redirect) {
          // A file descriptor's number before it belongs to the redirection.
          if (word !== null && /^[0-9]+$/.test(raw)) {
            word = null;
            raw = "";
          } else {
            endWord();
          }
          i += redirect[0].length;
          if (redirect[2] === undefined) op = redirect[1];
          else command.redirects.push({ op: redirect[0], target: "" });
        } else if (c === "(" || c === ")") {
          endCommand();
          i += 1;
        } else if (c === "\n" || c === ";" || c === "&" || c === "|") {
          endCommand();
          i += /^(&&|\|\||;;|\|&)/.test(rest) ? 2 : 1;
        } else if (c === " " || c === "\t") {
          endWord();
          i += 1;
        } else {
          add(c);
          i += 1;
        }
      }
    }
    endCommand();
  };
  list(undefined);
  return commands;
}

/** The names of the functions a script defines. */
const definedFunctions = (script) => new Set([...script.matchAll(/^\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{/gm)].map(([, name]) => name));

/** Whether two lists of words are the same. */
const sameWords = (a, b) => a.length === b.length && a.every((word, n) => word === b[n]);

/** A rule for a tool's arguments: one of these lists exactly. */
const exactly =
  (...forms) =>
  (args) =>
    forms.some((form) => sameWords(form, args)) ? null : `takes only ${forms.map((form) => (form.length > 0 ? form.join(" ") : "no argument")).join(", or ")}`;

/** A rule for a tool's arguments: any. */
const anything = () => null;

/** A rule for arguments that name shell variables: lower-case names, which no tool reads, and -r. */
const scriptVariables = (args) =>
  args.every((arg) => arg === "-r" || /^[a-z_][a-z0-9_]*(=.*)?$/s.test(arg)) ? null : "sets a variable other than the script's own, lower-case ones";

/**
 * A path with a node_modules, scripts or src-tauri folder in it, whose files
 * the job runs, wherever: ./ and .. don't hide one, as each part is read.
 */
const PROTECTED_PATH = /(^|\/)(node_modules|scripts|src-tauri)(\/|$)/;

/** The copies a job with the keys makes into the checkout: the hand-off's listed files, and the notices. */
const KEYED_COPIES = [
  ["-p", "$out/$file", "$file"],
  ["$RUNNER_TEMP/notices/THIRD-PARTY-NOTICES", "THIRD-PARTY-NOTICES"],
];

/** The configs a job with the keys bundles with: the release's, and the dry run's overlay. */
const KEYED_TAURI_CONFIGS = ["src-tauri/tauri.release.conf.json", "$RUNNER_TEMP/dry-run-config/dry-run.json"];

/** The arguments tauri bundle may take in a job with the keys: flags and values the workflow passes. */
function bundleArgsProblem(args) {
  const seen = new Set();
  for (let n = 0; n < args.length; n += 1) {
    const [flag, value] = [args[n], args[n + 1]];
    const valued = (flag === "--target" && value === "$TRIPLE") || (flag === "--bundles" && value === "$BUNDLES") || (flag === "--config" && KEYED_TAURI_CONFIGS.includes(value));
    const key = flag === "--config" ? `${flag} ${value}` : flag;
    if (!valued && flag !== "--verbose" && flag !== "--ci") return `passes tauri bundle ${flag}${value === undefined ? "" : ` ${value}`}, which these jobs don't`;
    if (seen.has(key)) return `passes tauri bundle ${flag} twice`;
    seen.add(key);
    if (valued) n += 1;
  }
  return null;
}

/** The system tools a job with the keys may run, each with a rule for its arguments. */
const KEYED_TOOLS = new Map([
  ["[", anything],
  ["base64", exactly(["--decode"])],
  ["cd", anything],
  ["chmod", anything],
  ["codesign", anything],
  ["cp", (args) => (KEYED_COPIES.some((form) => sameWords(form, args)) || (args.length === 2 && !args[0].startsWith("-") && args[1].startsWith("$RUNNER_TEMP/") && !args[1].split("/").includes("..")) ? null : "copies only into $RUNNER_TEMP, or the hand-off's listed files and the notices into the checkout")],
  ["dirname", anything],
  ["echo", anything],
  ["exit", anything],
  ["find", exactly(["$out", "!", "-type", "f", "!", "-type", "d"], [".", "-type", "f"])],
  ["git", (args) => (["ls-files --others --", "diff --exit-code --"].includes(args.slice(0, 3).join(" ")) ? null : "takes only ls-files --others -- <paths> or diff --exit-code -- <paths>")],
  ["local", scriptVariables],
  ["mkdir", anything],
  ["printf", anything],
  ["read", scriptVariables],
  ["rm", anything],
  ["rustup", exactly(["toolchain", "install"], ["show", "active-toolchain"])],
  ["sed", exactly(["-e", "s|^\\./||"])],
  ["security", (args) => (["delete-keychain", "find-identity", "list-keychains"].includes(args[0]) ? null : "takes only delete-keychain, find-identity or list-keychains")],
  ["shift", anything],
  ["sort", exactly([])],
  ["sw_vers", exactly([])],
  ["true", exactly([])],
  ["xattr", exactly(["-lr", "$app"])],
]);

/**
 * Why a simple command may not run in a job with the keys: none, when it may.
 * Only these may run: the lockfile's Tauri CLI, to bundle with the flags the
 * workflow passes or to sign; npm ci --ignore-scripts; node on
 * scripts/release/*.mjs; bash on scripts/release/macos-keychain.sh; the
 * tools above, with the arguments their rules allow; and the script's own
 * functions. No assignment may set a variable a tool reads (PATH, GIT_*,
 * LD_*, NODE_OPTIONS, …), and no redirection may write under node_modules,
 * scripts or src-tauri, or to $GITHUB_ENV or $GITHUB_PATH, which set later
 * steps' environment. A here-document isn't read, so it is refused.
 *
 * @param {{ words: string[], assignments: { name: string }[], redirects: { op: string, target: string }[] }} command
 * @param {Set<string>} functions  the functions the script defines
 * @returns {string[]}
 */
function keyedProblems({ words: [name, ...args], assignments, redirects }, functions) {
  const problems = [];
  for (const assignment of assignments) {
    if (!/^[a-z_][a-z0-9_]*$/.test(assignment.name) && !["IFS", "LC_ALL", "P12"].includes(assignment.name)) problems.push(`sets ${assignment.name}, which a tool can read`);
  }
  for (const { op, target } of redirects) {
    if (op === "<<" || op === "<<-") problems.push("uses a here-document, which this check doesn't read");
    else if (WRITES.has(op) && (PROTECTED_PATH.test(target) || /^\$\{?GITHUB_(ENV|PATH)\}?$/.test(target))) problems.push(`writes to ${target}`);
  }
  if (name === undefined) return problems;
  let why = null;
  if (name === "npx") {
    if (args.slice(0, 3).join(" ") !== "--no -- tauri") why = "runs npx other than as npx --no -- tauri";
    else if (args[3] === "bundle") why = bundleArgsProblem(args.slice(4));
    else if (args.slice(3, 5).join(" ") === "signer sign") {
      const forms = [["$RUNNER_TEMP/bundles/$name"], ["-f", "$RUNNER_TEMP/dry-run/updater.key", "-p", "", "$RUNNER_TEMP/bundles/$name"]];
      if (!forms.some((form) => sameWords(form, args.slice(5)))) why = "passes tauri signer sign arguments these jobs don't";
    } else why = `runs tauri ${args[3] ?? ""}, where these jobs only bundle and sign`;
  } else if (name === "npm") {
    if (!sameWords(args, ["ci", "--ignore-scripts"])) why = "runs npm other than as npm ci --ignore-scripts";
  } else if (name === "node") {
    if (!/^scripts\/release\/[\w-]+\.mjs$/.test(args[0] ?? "")) why = "runs node on something other than a scripts/release/*.mjs file";
  } else if (name === "bash") {
    if (args[0] !== "scripts/release/macos-keychain.sh" || !["dry-run", "import"].includes(args[1]) || args.length !== 2) why = "runs bash other than as bash scripts/release/macos-keychain.sh dry-run or import";
  } else if (!functions.has(name)) {
    if (/[/$`]/.test(name)) why = "runs a file by its path, or a command named by a variable";
    else if (!KEYED_TOOLS.has(name)) why = `runs ${name}, which isn't among the commands these jobs may run`;
    else {
      const rule = KEYED_TOOLS.get(name)(args);
      if (rule !== null) why = `runs ${name}, which ${rule}`;
    }
  }
  if (why !== null) problems.push(why);
  return problems;
}

describe("build.yml", () => {
  yamlTest("compile runs in no environment; sign and bundle-macos, after it, in the one the caller names", () => {
    const call = triggersOf(workflow(BUILD)).workflow_call;
    assert.deepEqual(Object.keys(call?.inputs ?? {}).sort(), ["environment", "ref", "version"]);
    for (const [name, input] of Object.entries(call.inputs)) {
      assert.deepEqual([input.type, input.required], ["string", true], `input ${name} must be a required string`);
    }
    assert.deepEqual(Object.keys(workflow(BUILD).jobs ?? {}).sort(), ["bundle-macos", "compile", "notices", "sign"]);
    const compile = jobOf(BUILD, "compile");
    assert.equal(compile.environment, undefined, "the compile job must run in no environment");
    assert.deepEqual([[compile.needs].flat(), compile["timeout-minutes"]], [["notices"], 120], "the compile job");
    for (const [id, runner, timeout] of [
      ["sign", "ubuntu-24.04", 30],
      ["bundle-macos", "${{ matrix.runner }}", 60],
    ]) {
      const job = jobOf(BUILD, id);
      assert.deepEqual(
        [job.environment, [job.needs].flat(), job["runs-on"], job["timeout-minutes"]],
        ["${{ inputs.environment }}", ["compile"], runner, timeout],
        `the ${id} job`,
      );
    }
  });

  yamlTest("each job's matrix is its share of release-assets.mjs's TARGETS, and the job's name gives the target's label", () => {
    const full = ({ triple, runner, bundles, label }) => ({ triple, runner, bundles: [...bundles], label });
    const shares = {
      compile: TARGETS.map(full),
      sign: TARGETS.filter((target) => !isMacOS(target)).map(({ triple, label }) => ({ triple, label })),
      "bundle-macos": TARGETS.filter(isMacOS).map(full),
    };
    for (const [id, include] of Object.entries(shares)) {
      assert.ok(include.length > 0, `release-assets.mjs's TARGETS give job ${id} no target`);
      assert.deepEqual(jobOf(BUILD, id).strategy?.matrix, { include }, `job ${id}'s matrix`);
    }
    assert.deepEqual(
      Object.keys(shares).map((id) => jobOf(BUILD, id).name),
      ["Compile (${{ matrix.label }})", "Sign (${{ matrix.label }})", "Bundle (${{ matrix.label }})"],
    );
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

  yamlTest("every npm ci skips the packages' install scripts, and every npx runs the lockfile's Tauri CLI", () => {
    // An install script is dependency code; none of the build needs one.
    // npx --no runs only what node_modules holds, and never downloads; with
    // --, it reads none of the flags after tauri.
    const problems = [];
    for (const [id, job] of Object.entries(workflow(BUILD).jobs ?? {})) {
      for (const [i, step] of (job.steps ?? []).entries()) {
        for (const { words } of simpleCommands(scriptOf(step))) {
          const where = `${BUILD}, job ${id}, ${stepLabel(step, i)}: ${words.join(" ")}`;
          if (words[0] === "npm" && ["ci", "install", "i"].includes(words[1]) && !words.includes("--ignore-scripts")) problems.push(`${where} runs install scripts`);
          if (words[0] === "npx" && words.slice(1, 4).join(" ") !== "--no -- tauri") problems.push(`${where} runs npx other than as npx --no -- tauri`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  yamlTest("every checkout leaves the job's token out of the checkout", () => {
    const problems = Object.entries(workflow(BUILD).jobs ?? {}).flatMap(([id, job]) =>
      (job.steps ?? [])
        .filter((step) => usesAction(step, "actions/checkout") && step.with?.["persist-credentials"] !== false)
        .map((step) => `job ${id}, ${step.uses}: persist-credentials isn't false`),
    );
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  test("the secret check finds a secret in any form an expression can read it", () => {
    for (const text of [
      "${{ secrets.X }}",
      "${{ secrets['X'] }}",
      "${{ toJSON(secrets) }}",
      "${{ format('{0}', secrets.X) }}",
      "${{\n  secrets.X\n}}",
      "${{ inputs.ref }} and ${{ secrets.Y }}",
    ]) {
      assert.equal(secretExpressions(text).length, 1, JSON.stringify(text));
    }
    for (const text of ["node scripts/release/scan-secrets.mjs", "${{ inputs.environment }}", "secrets.X, outside an expression"]) {
      assert.deepEqual(secretExpressions(text), [], JSON.stringify(text));
    }
  });

  yamlTest("the release secrets reach only release-only steps of sign and bundle-macos, and the macOS ones bundle-macos alone", () => {
    const flow = workflow(BUILD);
    const problems = [];
    if (secretExpressions(JSON.stringify(flow.env ?? {})).length > 0) problems.push("the workflow's env reads a secret");
    const found = {};
    for (const [id, job] of Object.entries(flow.jobs ?? {})) {
      const { steps = [], ...settings } = job;
      if (secretExpressions(JSON.stringify(settings)).length > 0) problems.push(`job ${id} reads a secret outside its steps`);
      for (const [i, step] of steps.entries()) {
        const { env = {}, ...rest } = step;
        const where = `job ${id}, ${stepLabel(step, i)}`;
        if (secretExpressions(JSON.stringify(rest)).length > 0) problems.push(`${where} reads a secret outside its env`);
        for (const value of Object.values(env)) {
          for (const expression of secretExpressions(String(value))) {
            const secret = expression.match(/^\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}$/)?.[1];
            if (secret === undefined) {
              problems.push(`${where} reads secrets in a form other than secrets.NAME: ${expression}`);
              continue;
            }
            found[secret] = [...new Set([...(found[secret] ?? []), id])].sort();
            if (!requires(step.if, RELEASE_ONLY)) problems.push(`${where} gets ${secret}, but its condition isn't "${RELEASE_ONLY}" (and more): ${step.if ?? "none"}`);
          }
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
    assert.deepEqual(found, {
      APPLE_CERTIFICATE: ["bundle-macos"],
      APPLE_CERTIFICATE_PASSWORD: ["bundle-macos"],
      TAURI_SIGNING_PRIVATE_KEY: ["bundle-macos", "sign"],
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ["bundle-macos", "sign"],
    });
    assert.deepEqual(Object.keys(found).sort(), RELEASE_SECRETS);
  });

  yamlTest("only bundle-macos's release identity step reads the macOS identity's name, and no other job mentions APPLE_", () => {
    const readers = Object.entries(workflow(BUILD).jobs ?? {}).flatMap(([id, job]) =>
      (job.steps ?? []).filter((step) => JSON.stringify(step).includes("vars.APPLE_SIGNING_IDENTITY")).map((step) => ({ id, step })),
    );
    assert.equal(readers.length, 1, "one step reads vars.APPLE_SIGNING_IDENTITY");
    const [{ id, step }] = readers;
    assert.equal(id, "bundle-macos");
    assert.ok(requires(step.if, RELEASE_ONLY), `the step that reads it runs outside a release build: ${step.if}`);
    assert.equal(step.env?.IDENTITY, "${{ vars.APPLE_SIGNING_IDENTITY }}");
    for (const other of ["notices", "compile", "sign"]) {
      assert.doesNotMatch(JSON.stringify(jobOf(BUILD, other)), /APPLE_/, `job ${other} mentions APPLE_`);
    }
  });

  yamlTest("sign and bundle-macos run only GitHub's checkout, setup-node and artifact actions", () => {
    for (const id of KEYED_JOBS) {
      const used = [...new Set(stepsOf(id).filter((step) => step.uses !== undefined).map((step) => String(step.uses).split("@")[0]))].sort();
      assert.deepEqual(used, KEYED_ACTIONS, `job ${id}'s actions`);
    }
  });

  yamlTest("sign and bundle-macos run only the lockfile's Tauri CLI, npm ci --ignore-scripts, the repository's scripts and system tools, with bash", () => {
    const problems = [];
    for (const id of KEYED_JOBS) {
      // No other shell: a step's shell: could run its script with anything.
      if (jobOf(BUILD, id).defaults !== undefined) problems.push(`job ${id} sets defaults of its own`);
      for (const [i, step] of stepsOf(id).entries()) {
        if (step.shell !== undefined) problems.push(`job ${id}, ${stepLabel(step, i)} sets shell: ${step.shell}`);
        const functions = definedFunctions(scriptOf(step));
        for (const command of simpleCommands(scriptOf(step))) {
          for (const why of keyedProblems(command, functions)) problems.push(`job ${id}, ${stepLabel(step, i)} ${why}: ${command.words.join(" ")}`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
    assert.equal(workflow(BUILD).defaults?.run?.shell, "bash", "build.yml's steps must run with bash");
    assert.ok(stepsOf("bundle-macos").some(isTauriBundle), "bundle-macos doesn't run tauri bundle");
  });

  test("simpleCommands finds each command a script runs, inside quotes, expansions and substitutions too", () => {
    const script = `found=$(cd "$out" && find . -type f | sed -e 's|^\\./||' | LC_ALL=C sort)
if [ "$found" != "$(LC_ALL=C sort <<< "$listed")" ]; then exit 1; fi
while IFS= read -r name; do names+=("$name" "$(a)"); done <<< "$expected"
mkdir -p "$(dirname "$file")"
P12="$dir/release.p12" bash scripts/release/macos-keychain.sh import > "$out/x.txt" 2>&1 || status=$?
x=\${y:-$(b)} n=$(( $(c) + 1 )) && echo "\${z:-\`d\`}"
sort <(e) > >(f) < <(g)
capture() {
  local name=$1
}`;
    assert.deepEqual(
      simpleCommands(script).map(({ words }) => words),
      [
        ["cd", "$out"],
        ["find", ".", "-type", "f"],
        ["sed", "-e", "s|^\\./||"],
        ["sort"],
        [],
        ["sort"],
        ["[", "$found", "!=", '$(LC_ALL=C sort <<< "$listed")', "]"],
        ["exit", "1"],
        ["read", "-r", "name"],
        ["a"],
        [],
        [],
        ["dirname", "$file"],
        ["mkdir", "-p", '$(dirname "$file")'],
        ["bash", "scripts/release/macos-keychain.sh", "import"],
        [],
        ["b"],
        ["c"],
        [],
        ["d"],
        ["echo", "${z:-`d`}"],
        ["e"],
        ["f"],
        ["g"],
        ["sort", "<(e)"],
        ["capture"],
        ["local", "name=$1"],
      ],
    );
    const commands = simpleCommands(script);
    assert.deepEqual(commands.find(({ words }) => words[0] === "bash").assignments, [{ name: "P12", value: "$dir/release.p12" }]);
    assert.deepEqual(commands.find(({ words }) => words[0] === "bash").redirects, [{ op: ">", target: "$out/x.txt" }, { op: ">&1", target: "" }]);
    assert.deepEqual(commands.find(({ words }) => words[0] === "sort" && words[1] === "<(e)").redirects, [{ op: ">", target: ">(f)" }, { op: "<", target: "<(g)" }]);
  });

  test("the rules for sign and bundle-macos refuse what they don't allow, and let through what those jobs run", () => {
    const refused = (script) => simpleCommands(script).flatMap((command) => keyedProblems(command, definedFunctions(script)));
    for (const script of [
      "source ./env.sh",
      ". ./env.sh",
      "true && . ./env.sh",
      "exec bash",
      'eval "$x"',
      "sh -c 'id'",
      "zsh -c 'id'",
      "perl -e 'print 1'",
      "osascript -e 'beep'",
      "python3 -c 1",
      "./x",
      "/usr/bin/x",
      "FOO=1 ./evil",
      '"$tool" --help',
      "x=$(./evil)",
      'echo "$(sh -c id)"',
      "if true; then ./evil; fi",
      "env FOO=1 sh",
      "find . -exec sh {} \\;",
      "curl -fsSL https://example.com",
      "wget https://example.com",
      "tar -xf compiled.tar",
      "cargo metadata",
      "npx tauri bundle",
      "npx --no tauri bundle",
      "npx --yes -- tauri signer sign x",
      "npx --no -- tauri build --ci",
      "npx --no -- tauri dev",
      "npx --no -- tauri signer generate -w key",
      "npm exec tauri",
      "npm rebuild",
      "npm cit",
      "npm install",
      "npm ci",
      "node -e 'console.log(1)'",
      "node --eval x",
      "node scripts/build-sidecars.mjs",
      "x=$(node scripts/other.mjs)",
      "bash -c 'id'",
      "bash ./x.sh",
      "bash scripts/release/macos-keychain.sh evil",
      // Commands inside expansions and process substitutions.
      "x=${y:-$(./evil)}",
      "n=$(( $(./evil) ))",
      'echo "${x:-$(./evil)}"',
      "x=`./evil`",
      'names=("$(./evil)")',
      'while read -r x; do echo "$x"; done < <(./evil)',
      "sort <(./evil)",
      "echo x > >(./evil)",
      // Tools that can run another program, with arguments the workflow doesn't pass.
      "git -c alias.x='!sh' x",
      "git -c core.pager=./evil diff --exit-code -- x",
      "git diff --ext-diff",
      "git ls-files --others --exclude-standard -- x",
      "sed -e '1e ./evil'",
      "sed -i -e 's/a/b/' scripts/release/x.mjs",
      "sort --compress-program=./evil",
      "rustup run stable ./evil",
      "rustup toolchain install nightly",
      "find . -type f -delete",
      "security execute-with-privileges ./evil",
      'xattr -w com.example.x y "$app"',
      // Writes where the job's code lives, or into later steps' environment.
      "echo x > scripts/release/build.mjs",
      "echo x >> node_modules/.bin/tauri",
      "printf x > ./src-tauri/tauri.macos.conf.json",
      "printf x > target/../scripts/x.mjs",
      'echo "PATH=./bin" >> "$GITHUB_PATH"',
      'echo "NODE_OPTIONS=--require ./evil" >> "${GITHUB_ENV}"',
      'cp "$out/evil" scripts/release/x.mjs',
      "cp a src-tauri/tauri.macos.conf.json",
      'cp -r "$RUNNER_TEMP/x" node_modules/',
      'cp a "$RUNNER_TEMP/../work/scripts/x"',
      // tauri with flags or arguments the workflow doesn't pass.
      "npx --no -- tauri bundle --config ./evil.json",
      'npx --no -- tauri bundle --verbose --ci --target "$TRIPLE" --no-sign',
      "npx --no -- tauri bundle --target x86_64-apple-darwin",
      'npx --no -- tauri bundle --verbose --verbose',
      'npx --no -- tauri signer sign -k "$KEY" "$RUNNER_TEMP/bundles/$name"',
      // Variables a tool reads, and a here-document.
      'PATH=./bin cp a "$RUNNER_TEMP/b"',
      "GIT_EXTERNAL_DIFF=./evil git diff --exit-code -- x",
      "NODE_OPTIONS=--require=./evil node scripts/release/check-artifact.mjs x y",
      "read -r PATH <<< ./bin",
      "local PATH=./bin",
      "read -r x <<EOF",
    ]) {
      assert.notDeepEqual(refused(script), [], script);
    }
    for (const script of [
      "npm ci --ignore-scripts",
      'npx --no -- tauri bundle --verbose --ci --target "$TRIPLE"',
      'npx --no -- tauri bundle --verbose --ci --target "$TRIPLE" --bundles "$BUNDLES" --config src-tauri/tauri.release.conf.json --config "$RUNNER_TEMP/dry-run-config/dry-run.json"',
      'npx --no -- tauri signer sign -f "$RUNNER_TEMP/dry-run/updater.key" -p "" "$RUNNER_TEMP/bundles/$name" < /dev/null',
      'cp "$RUNNER_TEMP/notices/THIRD-PARTY-NOTICES" THIRD-PARTY-NOTICES',
      'cp "$RUNNER_TEMP/dry-run/updater.key.pub" "$RUNNER_TEMP/bundles/updater-pubkey.txt"',
      'security find-identity -v -p codesigning > "$out/find-identity.txt" 2>&1 || true',
      "git ls-files --others -- 'src-tauri/tauri*.conf*' 'src-tauri/Tauri*.toml'",
      "git diff --exit-code -- 'src-tauri/tauri*.conf*'",
      "rustup toolchain install",
      "found=$(cd \"$out\" && find . -type f | sed -e 's|^\\./||' | LC_ALL=C sort)",
      'printf \'%s\' "$APPLE_CERTIFICATE" | base64 --decode > "$dir/release.p12"',
      'npx --no -- tauri signer sign "$RUNNER_TEMP/bundles/$name" < /dev/null',
      'node scripts/release/check-artifact.mjs "$RUNNER_TEMP/notices" THIRD-PARTY-NOTICES',
      'expected=$(node scripts/release/release-assets.mjs unsigned "$TRIPLE" "$VERSION")',
      'while IFS= read -r name; do names+=("$name"); done <<< "$expected"',
      "bash scripts/release/macos-keychain.sh dry-run || status=$?",
      'P12="$dir/release.p12" bash scripts/release/macos-keychain.sh import',
      'mkdir -p "$(dirname "$file")"',
      'cp -p "$out/$file" "$file"',
      'capture() {\n  codesign "$@" "$app"\n}\ncapture verify --verify',
    ]) {
      assert.deepEqual(refused(script), [], script);
    }
  });

  yamlTest("every artifact a job downloads goes into a folder of its own, which check-artifact.mjs checks first", () => {
    // Exactly the expected files, each a regular file, before anything uses one.
    const expectedFiles = {
      "third-party-notices": "THIRD-PARTY-NOTICES",
      "updater-key-${{ matrix.triple }}": "updater.key updater.key.pub",
      "compiled-${{ matrix.triple }}": "compiled.tar",
      "unsigned-${{ matrix.triple }}": '"${names[@]}"',
    };
    const problems = [];
    let downloads = 0;
    for (const [id, job] of Object.entries(workflow(BUILD).jobs ?? {})) {
      const steps = job.steps ?? [];
      for (const [i, step] of steps.entries()) {
        if (!usesAction(step, "actions/download-artifact")) continue;
        downloads += 1;
        const where = `job ${id}, ${stepLabel(step, i)}`;
        const { name, path } = step.with ?? {};
        if (!/^\$\{\{ runner\.temp \}\}\/[\w-]+$/.test(String(path))) {
          problems.push(`${where} downloads ${name} into ${path}, not a folder of its own under runner.temp`);
          continue;
        }
        const folder = `"${path.replace("${{ runner.temp }}", "$RUNNER_TEMP")}"`;
        // Any mention of the folder or a file in it.
        const mention = new RegExp(`\\$RUNNER_TEMP/${path.split("/").at(-1)}["/]`);
        const next = steps[i + 1];
        const first = commandLines(next ?? {}).find((line) => mention.test(line));
        if (first !== `node scripts/release/check-artifact.mjs ${folder} ${expectedFiles[name]}`) {
          problems.push(`${where}: the next step doesn't first run check-artifact.mjs on ${folder} for ${expectedFiles[name] ?? "(an artifact this test doesn't know)"}: ${first ?? "(none)"}`);
        }
        if (next?.if !== step.if) problems.push(`${where}: the check runs under "${next?.if}", the download under "${step.if}"`);
      }
    }
    assert.ok(downloads > 0, "build.yml downloads no artifact");
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  yamlTest("the unsigned bundles a sign leg checks are the ones release-assets.mjs names for its target", () => {
    const step = stepsOf("sign").find((candidate) => scriptOf(candidate).includes('"${names[@]}"'));
    assert.match(scriptOf(step), /^expected=\$\(node scripts\/release\/release-assets\.mjs unsigned "\$TRIPLE" "\$VERSION"\)$/m);
  });

  scriptTest("a sign leg's check passes the target's unsigned bundles, and fails with anything more", () => {
    const step = stepsOf("sign").find((candidate) => scriptOf(candidate).includes('"${names[@]}"'));
    const triple = "x86_64-unknown-linux-gnu";
    inTempDir((dir) => {
      const bundles = join(dir, "bundles");
      mkdirSync(bundles);
      for (const name of unsignedAssets(triple, "1.2.3")) writeFileSync(join(bundles, name), `${name}\n`);
      const env = { RUNNER_TEMP: dir, TRIPLE: triple, VERSION: "1.2.3" };
      const good = runScript(step.run, { cwd: ROOT, env });
      assert.equal(good.status, 0, `${good.stdout}${good.stderr}`);
      writeFileSync(join(bundles, "extra.sh"), "#!/bin/sh\n");
      const extra = runScript(step.run, { cwd: ROOT, env });
      assert.equal(extra.status, 1, `${extra.stdout}${extra.stderr}`);
      assert.match(extra.stderr, /unexpected file extra\.sh/);
    });
  });

  yamlTest("the dry run's updater key goes from compile to sign and bundle-macos, alone and kept a day", () => {
    // Only this run's dry-run builds trust the key.
    const keyArtifact = (id, action) =>
      stepsOf(id).filter((step) => usesAction(step, action) && String(step.with?.name).startsWith("updater-key-"));
    const uploads = keyArtifact("compile", "actions/upload-artifact");
    assert.equal(uploads.length, 1, "the compile job must upload the dry run's updater key once");
    assert.deepEqual(
      [uploads[0].with.name, uploads[0].with.path, uploads[0].with["retention-days"]],
      ["updater-key-${{ matrix.triple }}", "${{ runner.temp }}/dry-run", 1],
    );
    // The folder it uploads holds the key's two halves and nothing else: the overlay goes elsewhere.
    const inFolder = new Set(stepsOf("compile").flatMap((step) => [...textOf(step).matchAll(/RUNNER_TEMP\/dry-run\/([^"\s\\]+)/g)].map(([, file]) => file)));
    assert.deepEqual([...inFolder].sort(), ["updater.key", "updater.key.pub"]);
    for (const id of KEYED_JOBS) {
      const downloads = keyArtifact(id, "actions/download-artifact");
      assert.equal(downloads.length, 1, `job ${id} must download the dry run's updater key once`);
      assert.deepEqual([downloads[0].with.name, downloads[0].with.path], ["updater-key-${{ matrix.triple }}", "${{ runner.temp }}/dry-run"]);
    }
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

  yamlTest("a release build compiles and bundles with the release config alone, and a dry run adds the overlay", () => {
    const pair = (id, isCommand) => {
      const steps = stepsOf(id).filter(isCommand);
      const release = steps.filter((step) => requires(step.if, RELEASE_ONLY));
      const dryRun = steps.filter((step) => requires(step.if, DRY_RUN_ONLY));
      assert.deepEqual([steps.length, release.length, dryRun.length], [2, 1, 1], `job ${id} must run it once if "${RELEASE_ONLY}" and once if "${DRY_RUN_ONLY}"`);
      return { release: release[0], dryRun: dryRun[0] };
    };
    const overlay = /--config "\$RUNNER_TEMP\/dry-run-config\/dry-run\.json"/;
    const compile = pair("compile", isTauriBuild);
    for (const step of [compile.release, compile.dryRun]) assert.match(scriptOf(step), /\s--no-bundle(\s|$)/, "the app must be compiled without bundling");
    // The overlay's key and endpoint are compiled into the app.
    assert.match(scriptOf(compile.dryRun), overlay, "the dry run doesn't compile the overlay in");
    const unsigned = pair("compile", isTauriBundle);
    const macOS = pair("bundle-macos", isTauriBundle);
    for (const { release, dryRun } of [compile, unsigned, macOS]) {
      assert.doesNotMatch(textOf(release), /dry-run/, `${release.name} mentions the dry run`);
      assert.match(scriptOf(dryRun), overlay, `${dryRun.name} doesn't use the overlay`);
    }
    // Linux and Windows bundle in compile, with no key; macOS signs in bundle-macos.
    for (const step of [unsigned.release, unsigned.dryRun]) {
      assert.ok(requires(step.if, NOT_MACOS), `${step.name} runs on macOS too`);
      assert.match(scriptOf(step), /(^|\s)tauri bundle --no-sign\s/, `${step.name} doesn't pass --no-sign`);
      assert.equal(step.env, undefined, `${step.name} gets an environment`);
    }
    for (const step of [macOS.release, macOS.dryRun]) assert.doesNotMatch(scriptOf(step), /--no-sign/, `${step.name} doesn't sign`);
    assert.deepEqual(macOS.release.env, {
      TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    });
    assert.deepEqual(macOS.dryRun.env, { TAURI_SIGNING_PRIVATE_KEY: "${{ runner.temp }}/dry-run/updater.key", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" });
  });

  yamlTest("every tauri build and bundle names the target, adds src-tauri/tauri.release.conf.json, and every bundle is --verbose", () => {
    for (const id of ["compile", "bundle-macos"]) {
      const commands = stepsOf(id).filter((step) => isTauriBuild(step) || isTauriBundle(step));
      assert.ok(commands.length > 0, `job ${id} runs neither tauri build nor tauri bundle`);
      for (const step of commands) {
        assert.match(scriptOf(step), /\s--target "\$TRIPLE"\s/, `${step.name} doesn't name the target`);
        assert.match(scriptOf(step), /--config src-tauri\/tauri\.release\.conf\.json(\s|$)/, `${step.name} misses the release config`);
        // --verbose logs each command the bundler runs.
        if (isTauriBundle(step)) assert.match(scriptOf(step), /(^|\s)tauri bundle (--no-sign )?--verbose(\s|$)/, `${step.name} doesn't pass --verbose`);
      }
    }
  });

  yamlTest("the Linux compile leg installs the pinned AppImage tools before it bundles", () => {
    const steps = stepsOf("compile");
    const tools = steps.findIndex((step) => commandLines(step).includes("node scripts/release/appimage-tools.mjs"));
    assert.ok(tools !== -1, "the compile job doesn't install the pinned AppImage tools");
    assert.equal(steps[tools].if, "runner.os == 'Linux'");
    const bundles = steps.map((step, i) => (isTauriBundle(step) ? i : -1)).filter((i) => i !== -1);
    assert.ok(bundles.length > 0 && bundles.every((i) => i > tools), "a tauri bundle runs before the AppImage tools are installed");
  });

  yamlTest("the macOS compile legs pack exactly compiled-tar.mjs's list, in ustar without macOS metadata, and check the archive", () => {
    const steps = stepsOf("compile");
    const pack = steps.find((step) => /(^|\s)tar\s/m.test(scriptOf(step)));
    assert.ok(pack, "the compile job doesn't pack compiled.tar");
    assert.equal(pack.if, MACOS_ONLY);
    const lines = commandLines(pack);
    const at = (line) => lines.indexOf(line);
    const order = [
      at('node scripts/release/compiled-tar.mjs list --target "$TRIPLE" > "$RUNNER_TEMP/compiled-files.txt"'),
      at('tar --format ustar --no-mac-metadata -cf "$RUNNER_TEMP/compiled/compiled.tar" -T "$RUNNER_TEMP/compiled-files.txt"'),
      at('node scripts/release/compiled-tar.mjs unpack --target "$TRIPLE" --tar "$RUNNER_TEMP/compiled/compiled.tar" --out "$RUNNER_TEMP/compiled-check"'),
    ];
    assert.ok(order.every((i, n) => i !== -1 && (n === 0 || i > order[n - 1])), `the step must list, pack and check, in that order:\n${lines.join("\n")}`);
    assert.ok(steps.indexOf(pack) > steps.findLastIndex(isTauriBuild), "compiled.tar is packed before the app is built");
    const upload = steps.find((step) => usesAction(step, "actions/upload-artifact") && step.with?.name === "compiled-${{ matrix.triple }}");
    assert.deepEqual(
      [upload?.if, upload?.with?.path, upload?.with?.["if-no-files-found"]],
      [MACOS_ONLY, "${{ runner.temp }}/compiled/compiled.tar", "error"],
    );
  });

  yamlTest("bundle-macos unpacks compiled.tar with compiled-tar.mjs, looks for anything else, and copies only the listed files", () => {
    const steps = stepsOf("bundle-macos");
    const download = steps.findIndex((step) => usesAction(step, "actions/download-artifact") && step.with?.name === "compiled-${{ matrix.triple }}");
    assert.ok(download !== -1, "bundle-macos doesn't download compiled-<triple>");
    const unpack = download + 1;
    const lines = commandLines(steps[unpack]);
    const at = (pattern) => lines.findIndex((line) => pattern.test(line));
    const order = [
      at(/^node scripts\/release\/check-artifact\.mjs "\$RUNNER_TEMP\/compiled-download" compiled\.tar$/),
      at(/^node scripts\/release\/compiled-tar\.mjs unpack --target "\$TRIPLE" --tar "\$RUNNER_TEMP\/compiled-download\/compiled\.tar" --out "\$out"$/),
      at(/^odd=\$\(find "\$out" ! -type f ! -type d\)$/),
      at(/^found=\$\(cd "\$out" && find \. -type f \| /),
      at(/^cp -p "\$out\/\$file" "\$file"$/),
    ];
    assert.ok(order.every((i, n) => i !== -1 && (n === 0 || i > order[n - 1])), `the step must check, unpack, look for anything else, compare with the list and copy, in that order:\n${lines.join("\n")}`);
    assert.ok(unpack < steps.findIndex(isTauriBundle), "the compiled files are unpacked after tauri bundle");
    assert.doesNotMatch(read(BUILD), /tar -x/, "build.yml unpacks an archive with tar");
  });

  test("bundle-macos's unpack copies a good hand-off into the checkout, executable, and refuses one with a file more", { skip: YAML_SKIP || BASH_SKIP || TAR_SKIP }, () => {
    const step = stepsOf("bundle-macos").find((candidate) => scriptOf(candidate).includes("compiled-tar.mjs unpack"));
    const triple = "aarch64-apple-darwin";
    const files = compiledFiles(triple);
    inTempDir((dir) => {
      const handOff = (name, extra) => {
        const checkout = join(dir, name, "checkout");
        const temp = join(dir, name, "temp");
        for (const rel of ["scripts/release/compiled-tar.mjs", "scripts/release/check-artifact.mjs", "src-tauri/tauri.conf.json"]) {
          mkdirSync(dirname(join(checkout, rel)), { recursive: true });
          copyFileSync(join(ROOT, rel), join(checkout, rel));
        }
        const src = join(dir, name, "src");
        for (const file of [...files, ...extra]) {
          mkdirSync(dirname(join(src, file)), { recursive: true });
          writeFileSync(join(src, file), `binary ${file}\n`, { mode: 0o755 });
        }
        mkdirSync(join(temp, "compiled-download"), { recursive: true });
        const packed = spawnSync("tar", ["--format", "ustar", "-cf", join(temp, "compiled-download", "compiled.tar"), ...files, ...extra], { cwd: src, encoding: "utf8" });
        assert.equal(packed.status, 0, packed.stderr);
        const result = runScript(step.run, { cwd: checkout, env: { RUNNER_TEMP: temp, TRIPLE: triple } });
        return { ...result, checkout };
      };
      const good = handOff("good", []);
      assert.equal(good.status, 0, `${good.stdout}${good.stderr}`);
      for (const file of files) {
        assert.equal(readFileSync(join(good.checkout, file), "utf8"), `binary ${file}\n`);
        assert.equal(statSync(join(good.checkout, file)).mode & 0o111, 0o111, `${file} isn't executable`);
      }
      const extra = handOff("extra", ["src-tauri/tauri.macos.conf.json"]);
      assert.equal(extra.status, 1, `${extra.stdout}${extra.stderr}`);
      assert.match(extra.stderr, /unexpected file "src-tauri\/tauri\.macos\.conf\.json"/);
      assert.ok(!existsSync(join(extra.checkout, "target")) && !existsSync(join(extra.checkout, "src-tauri", "tauri.macos.conf.json")), "a refused hand-off put files in the checkout");
    });
  });

  yamlTest("bundle-macos makes the dry run's overlay again from the run's public key, before it bundles", () => {
    const steps = stepsOf("bundle-macos");
    const make = steps.findIndex((step) =>
      commandLines(step).includes('node scripts/release/dry-run-config.mjs --pubkey-file "$RUNNER_TEMP/dry-run/updater.key.pub" --out "$RUNNER_TEMP/dry-run-config/dry-run.json"'),
    );
    assert.ok(make !== -1, "bundle-macos doesn't make the overlay from the run's public key");
    assert.ok(requires(steps[make].if, DRY_RUN_ONLY));
    const check = commandLines(steps[make]).indexOf('node scripts/release/check-artifact.mjs "$RUNNER_TEMP/dry-run" updater.key updater.key.pub');
    assert.equal(check, 0, "the key isn't checked before the overlay is made from it");
    const bundle = steps.findIndex((step) => isTauriBundle(step) && requires(step.if, DRY_RUN_ONLY));
    assert.ok(make < bundle, "the overlay is made after the dry run bundles");
    const downloaded = Object.values(workflow(BUILD).jobs ?? {}).flatMap((job) => (job.steps ?? []).filter((step) => usesAction(step, "actions/download-artifact") && /dry-run-config/.test(textOf(step))));
    assert.deepEqual(downloaded, [], "a job downloads the overlay");
  });

  yamlTest("bundle-macos checks that the Tauri configs are the tracked ones, after the downloads and before it bundles", () => {
    const steps = stepsOf("bundle-macos");
    const check = steps.findIndex((step) => scriptOf(step).includes("git ls-files --others"));
    assert.ok(check !== -1, "bundle-macos doesn't check for Tauri configs that aren't tracked");
    assert.equal(steps[check].if, undefined, "the check must run in release builds and dry runs alike");
    assert.ok(check > steps.findLastIndex((step) => usesAction(step, "actions/download-artifact")), "an artifact is downloaded after the check");
    assert.ok(check < steps.findIndex(isTauriBundle), "the check runs after tauri bundle");
  });

  scriptTest("the config check fails on an untracked or ignored Tauri config, and on a changed tracked one", () => {
    const step = stepsOf("bundle-macos").find((candidate) => scriptOf(candidate).includes("git ls-files --others"));
    inTempDir((dir) => {
      const git = (...args) => {
        const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      git("init", "-q");
      mkdirSync(join(dir, "src-tauri"));
      writeFileSync(join(dir, "src-tauri", "tauri.conf.json"), "{}\n");
      writeFileSync(join(dir, "src-tauri", "tauri.release.conf.json"), "{}\n");
      writeFileSync(join(dir, ".gitignore"), "src-tauri/Tauri.toml\n");
      git("add", ".");
      git("commit", "-q", "-m", "configs");
      const check = () => runScript(step.run, { cwd: dir });
      assert.equal(check().status, 0, "a clean checkout fails the check");
      for (const [file, text] of [
        ["src-tauri/tauri.macos.conf.json", '{"build":{"beforeBundleCommand":"id"}}'],
        ["src-tauri/Tauri.toml", "[build]\n"],
        ["src-tauri/tauri.conf.json5", "{}"],
      ]) {
        writeFileSync(join(dir, file), text);
        const result = check();
        assert.equal(result.status, 1, `${file} passes the check`);
        assert.match(result.stdout, new RegExp(`::error::Tauri configs that aren't tracked are in the checkout: ${file.replaceAll(".", "\\.")}`));
        rmSync(join(dir, file));
      }
      writeFileSync(join(dir, "src-tauri", "tauri.release.conf.json"), '{"build":{"beforeBundleCommand":"id"}}\n');
      assert.notEqual(check().status, 0, "a changed tracked config passes the check");
    });
  });

  yamlTest("each environment sets up its macOS identity with macos-keychain.sh, before tauri bundle", () => {
    const steps = stepsOf("bundle-macos");
    const identity = steps.filter((step) => scriptOf(step).includes("macos-keychain.sh"));
    const dryRun = identity.filter((step) => requires(step.if, DRY_RUN_ONLY));
    const release = identity.filter((step) => requires(step.if, RELEASE_ONLY));
    assert.deepEqual([identity.length, dryRun.length, release.length], [2, 1, 1], `one identity step if "${RELEASE_ONLY}" and one if "${DRY_RUN_ONLY}"`);
    assert.ok(commandLines(dryRun[0]).includes("bash scripts/release/macos-keychain.sh dry-run || status=$?"));
    assert.deepEqual(dryRun[0].env, { IDENTITY: "Fleetify Dry Run Code Signing" });
    // The release step only decodes the p12; the password stays in the environment.
    assert.deepEqual(release[0].env, {
      APPLE_CERTIFICATE: "${{ secrets.APPLE_CERTIFICATE }}",
      P12_PASSWORD: "${{ secrets.APPLE_CERTIFICATE_PASSWORD }}",
      IDENTITY: "${{ vars.APPLE_SIGNING_IDENTITY }}",
    });
    assert.ok(commandLines(release[0]).includes('P12="$dir/release.p12" bash scripts/release/macos-keychain.sh import'));
    assert.doesNotMatch(scriptOf(release[0]), /P12_PASSWORD/, "the release step uses the p12's password itself");
    const firstBundle = steps.findIndex(isTauriBundle);
    for (const step of identity) {
      assert.equal(step["timeout-minutes"], 5, `${step.name} must give up after five minutes`);
      assert.ok(steps.indexOf(step) < firstBundle, `${step.name} runs after tauri bundle`);
    }
    // The dry run keeps what codesign can see even when the script fails.
    const lines = commandLines(dryRun[0]);
    const script = lines.indexOf("bash scripts/release/macos-keychain.sh dry-run || status=$?");
    for (const kept of ['security find-identity -v -p codesigning > "$out/find-identity.txt" 2>&1 || true', 'security list-keychains -d user > "$out/list-keychains.txt" 2>&1 || true']) {
      assert.ok(lines.indexOf(kept) > script, `the dry run's identity step doesn't keep, after the script: ${kept}`);
    }
    assert.equal(lines.at(-1), 'exit "$status"');
    // The certificate comes from the script's own config: build.yml makes none.
    assert.doesNotMatch(read(BUILD), /openssl req|-addext/);
  });

  yamlTest("Tauri signs the macOS app with APPLE_SIGNING_IDENTITY alone, from the keychain the job made", () => {
    // tauri-macos-sign's own import (APPLE_CERTIFICATE) finds only identities
    // named like Apple's, never a self-signed one, and fails the build.
    const steps = stepsOf("bundle-macos");
    const problems = steps
      .filter((step) => isTauriBundle(step) && Object.keys(step.env ?? {}).some((name) => name.startsWith("APPLE_")))
      .map((step) => `${step.name} gets ${Object.keys(step.env).filter((name) => name.startsWith("APPLE_")).join(", ")}`);
    problems.push(...steps.filter((step) => /APPLE_CERTIFICATE[A-Z_]*=/.test(scriptOf(step))).map((step) => `${step.name} sets APPLE_CERTIFICATE for later steps`));
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  yamlTest("bundle-macos deletes the keychain right after tauri bundle, whatever happened, and keeps the trust setting", () => {
    // GitHub discards a hosted runner's VM after the job, trust setting and
    // all, while removing it waits for an authorization dialog: the second
    // dry run's cleanup hung there for 40 minutes.
    const steps = stepsOf("bundle-macos");
    const cleanup = steps.findIndex((step) => /security delete-keychain/.test(scriptOf(step)));
    assert.equal(cleanup, steps.findLastIndex(isTauriBundle) + 1, "the keychain isn't deleted right after tauri bundle");
    assert.deepEqual([steps[cleanup].if, steps[cleanup]["timeout-minutes"]], ["always()", 5]);
    assert.ok(commandLines(steps[cleanup]).includes('rm -rf "$RUNNER_TEMP/codesign"'));
    const script = read("scripts/release/macos-keychain.sh");
    for (const [what, text] of [["build.yml", read(BUILD)], ["macos-keychain.sh", script]]) {
      assert.doesNotMatch(text, /remove-trusted-cert/, `${what} removes a trust setting`);
    }
    const sudo = script.split("\n").filter((line) => /(^|\s)sudo\s/.test(line) && !line.trim().startsWith("#"));
    assert.deepEqual(sudo.map((line) => line.trim().split(" ").slice(0, 3).join(" ")), ["sudo security add-trusted-cert"], "macos-keychain.sh runs another sudo command");
  });

  yamlTest("bundle-macos checks the app's signature with macos-signature.mjs in every build, before it collects the bundles", () => {
    const steps = stepsOf("bundle-macos");
    const check = steps.findIndex((step) => commandLines(step).includes('node scripts/release/macos-signature.mjs "target/$TRIPLE/release/bundle/macos/Fleetify.app"'));
    assert.ok(check !== -1, "bundle-macos doesn't check the app's signature");
    assert.equal(steps[check].if, undefined, "the signature check must run in release builds and dry runs alike");
    assert.ok(check > steps.findLastIndex(isTauriBundle), "the signature is checked before the app is bundled");
    assert.ok(check < steps.findIndex((step) => scriptOf(step).includes("collect-bundles.mjs")), "the bundles are collected before the signature is checked");
  });

  yamlTest("scan-secrets.mjs scans the UI and the binaries in every compile leg, after the app is built", () => {
    const steps = stepsOf("compile");
    const scan = steps.findIndex((step) => scriptOf(step).includes("scan-secrets.mjs"));
    assert.ok(scan !== -1, "the compile job doesn't run scan-secrets.mjs");
    assert.ok(scan > steps.findLastIndex(isTauriBuild), "scan-secrets.mjs runs before the app is built");
    assert.equal(steps[scan].if, undefined, "the secret scan must run in every build");
    for (const path of [/\sdist\s/, /release\/fleetify-app/, /release\/fleet-\*-mcp/]) {
      assert.match(scriptOf(steps[scan]), path, `the secret scan misses ${path}`);
    }
  });

  scriptTest("the updater check fails a release build with the dry run's overlay, and a dry run without it", () => {
    const steps = stepsOf("compile");
    const step = steps.find((candidate) => scriptOf(candidate).includes("127.0.0.1:18080/update"));
    assert.ok(step, "the compile job doesn't check the updater settings compiled into the app");
    assert.equal(step.if, undefined, "the check must run in release builds and dry runs alike");
    assert.ok(steps.indexOf(step) > steps.findLastIndex(isTauriBuild), "the check runs before the app is built");
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

  yamlTest("the Linux and Windows legs collect their unsigned bundles into an empty folder, add the AppImage's libraries, and upload them", () => {
    const steps = stepsOf("compile");
    const collect = steps.findIndex((step) => scriptOf(step).includes("collect-bundles.mjs"));
    assert.ok(collect !== -1, "the compile job doesn't run collect-bundles.mjs");
    assert.equal(steps[collect].if, NOT_MACOS);
    assert.ok(commandLines(steps[collect]).includes('node scripts/release/collect-bundles.mjs --unsigned --target "$TRIPLE" --version "$VERSION" --out "$RUNNER_TEMP/unsigned"'));
    assert.ok(collect > steps.findLastIndex(isTauriBundle), "the bundles are collected before they're made");
    const earlier = steps.slice(0, collect).filter((step) => /RUNNER_TEMP\/unsigned|runner\.temp \}\}\/unsigned/.test(textOf(step))).map(stepLabel);
    assert.deepEqual(earlier, [], "these steps use the folder before collect-bundles.mjs fills it");
    const upload = steps.findIndex((step) => usesAction(step, "actions/upload-artifact") && step.with?.name === "unsigned-${{ matrix.triple }}");
    assert.ok(upload !== -1, "the compile job doesn't upload unsigned-<triple>");
    assert.deepEqual([steps[upload].if, steps[upload].with?.path, steps[upload].with?.["if-no-files-found"]], [NOT_MACOS, "${{ runner.temp }}/unsigned", "error"]);
    const libraries = steps.findIndex((step) => textOf(step).includes("RUNNER_TEMP/unsigned/LINUX-APPIMAGE-LIBRARIES.txt"));
    assert.ok(libraries > collect && libraries < upload, "LINUX-APPIMAGE-LIBRARIES.txt isn't added after collect-bundles.mjs and before the upload");
    assert.equal(steps[libraries].if, "runner.os == 'Linux'");
  });

  yamlTest("sign signs each updater artifact with the Tauri CLI's signer: the release key from the environment, the run's from its file", () => {
    const steps = stepsOf("sign");
    const signs = steps.filter((step) => /(^|\s)npx --no -- tauri signer sign /m.test(scriptOf(step)));
    const release = signs.filter((step) => requires(step.if, RELEASE_ONLY));
    const dryRun = signs.filter((step) => requires(step.if, DRY_RUN_ONLY));
    assert.deepEqual([signs.length, release.length, dryRun.length], [2, 1, 1], `sign must sign once if "${RELEASE_ONLY}" and once if "${DRY_RUN_ONLY}"`);
    for (const step of signs) {
      assert.equal(commandLines(step)[0], 'updaters=$(node scripts/release/release-assets.mjs updaters "$TRIPLE" "$VERSION")', `${step.name} doesn't sign release-assets.mjs's updater artifacts`);
    }
    assert.deepEqual(release[0].env, {
      TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    });
    // Each call reads /dev/null, not the loop's list.
    assert.ok(commandLines(release[0]).includes('npx --no -- tauri signer sign "$RUNNER_TEMP/bundles/$name" < /dev/null'));
    assert.equal(dryRun[0].env, undefined);
    assert.ok(commandLines(dryRun[0]).includes('npx --no -- tauri signer sign -f "$RUNNER_TEMP/dry-run/updater.key" -p "" "$RUNNER_TEMP/bundles/$name" < /dev/null'));
  });

  scriptTest("sign's loop signs every updater artifact of the target, and nothing else", () => {
    const step = stepsOf("sign").find((candidate) => requires(candidate.if, RELEASE_ONLY) && /tauri signer sign/.test(scriptOf(candidate)));
    for (const triple of TARGETS.filter((target) => !isMacOS(target)).map(({ triple: t }) => t)) {
      inTempDir((dir) => {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "npx"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$NPX_LOG"\n`, { mode: 0o755 });
        const env = { PATH: `${bin}:${process.env.PATH}`, NPX_LOG: join(dir, "npx.log"), RUNNER_TEMP: dir, TRIPLE: triple, VERSION: "1.2.3" };
        const result = runScript(step.run, { cwd: ROOT, env });
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        assert.deepEqual(
          readFileSync(join(dir, "npx.log"), "utf8").trim().split("\n"),
          updaterAssets(triple, "1.2.3").map((name) => `--no -- tauri signer sign ${join(dir, "bundles", name)}`),
          triple,
        );
      });
    }
  });

  yamlTest("every updater signature is checked before upload: against the shipped key in a release, the run's in a dry run", () => {
    for (const id of KEYED_JOBS) {
      const steps = stepsOf(id);
      const verifies = steps.filter((step) => scriptOf(step).includes("minisign.mjs verify"));
      const release = verifies.filter((step) => requires(step.if, RELEASE_ONLY));
      const dryRun = verifies.filter((step) => requires(step.if, DRY_RUN_ONLY));
      assert.deepEqual([verifies.length, release.length, dryRun.length], [2, 1, 1], `job ${id} must check the signatures once per environment`);
      assert.equal(commandLines(release[0]).at(-1), `node scripts/release/minisign.mjs verify --pubkey-config src-tauri/tauri.conf.json --expect-key-id ${UPDATER_KEY_ID} "\${files[@]}"`);
      assert.equal(commandLines(dryRun[0]).at(-1), 'node scripts/release/minisign.mjs verify --pubkey-file "$RUNNER_TEMP/dry-run/updater.key.pub" "${files[@]}"');
      for (const step of verifies) {
        assert.equal(commandLines(step)[0], 'updaters=$(node scripts/release/release-assets.mjs updaters "$TRIPLE" "$VERSION")', `${step.name} doesn't check every updater artifact`);
      }
      const upload = steps.findIndex((step) => usesAction(step, "actions/upload-artifact") && step.with?.name === "bundles-${{ matrix.triple }}");
      const signed = Math.max(steps.findLastIndex(isTauriBundle), steps.findLastIndex((step) => /tauri signer sign/.test(scriptOf(step))));
      for (const step of verifies) {
        const at = steps.indexOf(step);
        assert.ok(at > signed && at < upload, `job ${id}: ${step.name} must run after the signing and before the upload`);
      }
    }
  });

  yamlTest("sign and bundle-macos upload bundles-<triple> after the bundles are complete", () => {
    // assemble.mjs takes exactly these artifacts: the files under their
    // release names, their signatures, and in a dry run the run's public key.
    for (const [id, folderFilledBy] of [
      ["sign", (step) => usesAction(step, "actions/download-artifact") && step.with?.name === "unsigned-${{ matrix.triple }}"],
      ["bundle-macos", (step) => commandLines(step).includes('node scripts/release/collect-bundles.mjs --target "$TRIPLE" --version "$VERSION" --out "$RUNNER_TEMP/bundles"')],
    ]) {
      const steps = stepsOf(id);
      const filled = steps.findIndex(folderFilledBy);
      assert.ok(filled !== -1, `job ${id} doesn't fill its bundles folder as expected`);
      const earlier = steps.slice(0, filled).filter((step) => /RUNNER_TEMP\/bundles|runner\.temp \}\}\/bundles/.test(textOf(step))).map(stepLabel);
      assert.deepEqual(earlier, [], `job ${id}: these steps use the bundles folder before it's filled`);
      const upload = steps.findIndex((step) => usesAction(step, "actions/upload-artifact") && step.with?.name === "bundles-${{ matrix.triple }}");
      assert.deepEqual([steps[upload]?.with?.path, steps[upload]?.with?.["if-no-files-found"]], ["${{ runner.temp }}/bundles", "error"], `job ${id}'s upload`);
      const pubkey = steps.findIndex((step) => textOf(step).includes("updater-pubkey.txt"));
      assert.ok(pubkey > filled && pubkey < upload, `job ${id}: updater-pubkey.txt isn't added after the folder is filled and before the upload`);
    }
    const collect = stepsOf("bundle-macos").findIndex((step) => scriptOf(step).includes("collect-bundles.mjs"));
    assert.ok(collect > stepsOf("bundle-macos").findIndex((step) => scriptOf(step).includes("macos-signature.mjs")), "bundle-macos collects before it checks the signature");
  });

  yamlTest("compiled-* and unsigned-* are kept a week, as a release's approval can come days later, and the dry run's key a day", () => {
    const uploads = Object.values(workflow(BUILD).jobs ?? {}).flatMap((job) => (job.steps ?? []).filter((step) => usesAction(step, "actions/upload-artifact")));
    const retention = {};
    for (const step of uploads) retention[step.with.name] = [...new Set([...(retention[step.with.name] ?? []), step.with["retention-days"]])];
    assert.deepEqual(retention, {
      "third-party-notices": [7],
      "unsigned-${{ matrix.triple }}": [7],
      "compiled-${{ matrix.triple }}": [7],
      "updater-key-${{ matrix.triple }}": [1],
      "bundles-${{ matrix.triple }}": [7],
      "codesign-output-${{ matrix.triple }}": [7],
    });
  });

  yamlTest("the compile job installs CONTRIBUTING's Linux packages", () => {
    // It builds against them, and the AppImage carries the libraries, which
    // linuxdeploy copies from the system.
    const documented = aptPackages(codeBlockUnder("CONTRIBUTING.md", "### Linux"));
    const installed = new Set(stepsOf("compile").flatMap((step) => aptPackages(scriptOf(step))));
    assert.deepEqual(documented.filter((name) => !installed.has(name)), [], "the compile job misses these packages that CONTRIBUTING.md lists");
  });

  yamlTest("a macOS dry run keeps codesign's own output and the app's extended attributes, whatever the checks say", () => {
    // The codesign fixtures of macos-signature.test.mjs are such output.
    const steps = stepsOf("bundle-macos");
    const when = ["always()", DRY_RUN_ONLY];
    const capture = steps.find((step) => ["--verify", "-r-", "-vvv", "--entitlements"].every((arg) => scriptOf(step).includes(arg)) && /\bcodesign\b/.test(scriptOf(step)));
    assert.ok(capture, "no step keeps the output of the four codesign commands");
    assert.deepEqual(when.filter((clause) => !requires(capture.if, clause)), [], `the capture's condition must hold ${when.join(" && ")}`);
    // Tauri clears the app's extended attributes between making and signing it.
    const lines = commandLines(capture);
    const xattr = lines.indexOf('xattr -lr "$app" > "$out/xattr.txt" 2>&1 || true');
    assert.ok(xattr > lines.findIndex((line) => line.startsWith('if [ ! -d "$app" ]')), "the capture doesn't keep the app's extended attributes once it knows the app is there");
    const upload = steps.find((step) => usesAction(step, "actions/upload-artifact") && String(step.with?.name).startsWith("codesign-output-"));
    assert.ok(upload, "codesign's output isn't uploaded");
    assert.equal(upload.with.name, "codesign-output-${{ matrix.triple }}");
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

/**
 * What a desktop provides and an AppImage leaves to the system, by Ubuntu
 * 24.04's names: the graphics stack (with Mesa's EGL and GL, which render
 * under Xvfb) and a few base libraries. The smoke's runner is a server
 * image, which lacks some of them.
 */
const DESKTOP_PACKAGES = [
  "libegl1",
  "libgl1",
  "libegl-mesa0",
  "libgl1-mesa-dri",
  "libgbm1",
  "libdrm2",
  "libx11-6",
  "libx11-xcb1",
  "libxcb1",
  "libasound2t64",
  "libcom-err2",
  "libexpat1",
  "libfontconfig1",
  "libfreetype6",
  "libfribidi0",
  "libharfbuzz0b",
  "libgmp10",
  "libgpg-error0",
  "zlib1g",
  "libstdc++6",
  "libgcc-s1",
];

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

  yamlTest("the Linux job installs what a desktop provides, then checks the AppImage's libraries, before the AppImage starts", () => {
    const steps = jobOf(SMOKE, "linux").steps ?? [];
    const install = steps.findIndex((step) => aptPackages(scriptOf(step)).includes("xvfb"));
    assert.ok(install !== -1, "the Linux job doesn't install its packages");
    assert.deepEqual(aptPackages(scriptOf(steps[install])), ["dbus", "xvfb", ...DESKTOP_PACKAGES].sort());
    const check = steps.findIndex((step) => scriptOf(step).includes("appimage-host-libs.mjs"));
    assert.ok(check !== -1, "the Linux job doesn't check the AppImage's libraries");
    assert.ok(scriptOf(steps[check]).split("\n").map((line) => line.trim()).includes('node tools/scripts/release/appimage-host-libs.mjs --appimage "${appimages[0]}"'));
    assert.equal(steps[check].if, undefined, "the check must run in every smoke");
    const launch = steps.findIndex((step) => scriptOf(step).includes("--appimage-extract-and-run"));
    assert.ok(install < check && check < launch, "the packages, the check and the AppImage's launch must come in that order");
  });

  scriptTest("the library check is given the release's AppImage", () => {
    const step = (jobOf(SMOKE, "linux").steps ?? []).find((candidate) => scriptOf(candidate).includes("appimage-host-libs.mjs"));
    assert.deepEqual(runSmokeStep(step.run, {}), [{ args: ["tools/scripts/release/appimage-host-libs.mjs", "--appimage", "release/Fleetify_1.2.3_amd64.AppImage"], wrappers: "" }]);
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
