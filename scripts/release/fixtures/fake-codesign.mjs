#!/usr/bin/env node
/**
 * fake-codesign.mjs — a stand-in for macOS's codesign in the tests of
 * macos-signature.mjs, so they also run where there is no codesign.
 *
 * Run as codesign (the tests put a wrapper of that name first on PATH), it
 * answers the four commands macos-signature.mjs runs from a scenario: the
 * JSON file named by FAKE_CODESIGN_SCENARIO, which maps each command's kind
 * (kindOf) to { status, stdout, stderr }, codesign's own streams as a capture
 * holds them, or to { status, output }: the text a terminal shows, both
 * streams together, which codesignStreams splits the way codesign does. Each
 * call's arguments are appended, as a JSON array, to a line of the file named
 * by FAKE_CODESIGN_LOG.
 */
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Which of macos-signature.mjs's codesign commands `args` is: verify,
 * requirements (-d -r-), display (-d -vvv) or entitlements; null for any other.
 *
 * @param {string[]} args
 * @returns {"verify" | "requirements" | "display" | "entitlements" | null}
 */
export function kindOf(args) {
  if (args.includes("--verify")) return "verify";
  if (args.includes("-r-")) return "requirements";
  if (args.includes("-vvv")) return "display";
  if (args.includes("--entitlements")) return "entitlements";
  return null;
}

/**
 * Split a terminal's view of codesign's output into its two streams. --verify
 * and -d -vvv write everything to stderr; -d -r- and -d --entitlements write
 * the Executable= line to stderr and what was asked for to stdout.
 *
 * @param {string} kind     as kindOf returns it
 * @param {string} output
 * @returns {{ stdout: string, stderr: string }}
 */
export function codesignStreams(kind, output) {
  if (kind === "verify" || kind === "display") return { stdout: "", stderr: output };
  const lines = output.split(/(?<=\n)/);
  const isExecutable = (line) => line.startsWith("Executable=");
  return {
    stdout: lines.filter((line) => !isExecutable(line)).join(""),
    stderr: lines.filter(isExecutable).join(""),
  };
}

function main(args) {
  appendFileSync(process.env.FAKE_CODESIGN_LOG, `${JSON.stringify(args)}\n`);
  const scenario = JSON.parse(readFileSync(process.env.FAKE_CODESIGN_SCENARIO, "utf8"));
  const kind = kindOf(args);
  if (kind === null || !Object.hasOwn(scenario, kind)) {
    process.stderr.write(`fake codesign: no answer for ${JSON.stringify(args)}\n`);
    return 64;
  }
  const answer = scenario[kind];
  const { status = 0, output = "" } = answer;
  const { stdout, stderr } = "stdout" in answer || "stderr" in answer ? { stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" } : codesignStreams(kind, output);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return status;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// exitCode instead of process.exit(), so buffered output is written first.
if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
