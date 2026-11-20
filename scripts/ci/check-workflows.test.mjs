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

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOWS = ".github/workflows";

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
