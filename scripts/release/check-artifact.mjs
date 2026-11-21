#!/usr/bin/env node
/**
 * check-artifact.mjs — check that a downloaded artifact's folder holds
 * exactly the files a job expects, before the job uses any of them.
 *
 *   node scripts/release/check-artifact.mjs <dir> <name>...
 *
 * The folder must be a real folder, not a symlink, and hold exactly the
 * files named: each a non-empty regular file (symlinks aren't followed),
 * nothing missing and nothing else, no folder either. A job that holds keys
 * downloads each artifact into a folder of its own and checks it this way,
 * so what another job uploaded can't bring anything the job didn't ask for.
 *
 * Exit codes: 0 the folder holds exactly those files; 1 a problem, each
 * listed on stderr; 2 usage (no folder, no names, a name that is a path or
 * is given twice).
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/release/check-artifact.mjs <dir> <name>...";

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** fs.lstat, with null for a path that isn't there. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * What is wrong with an artifact's folder, given the files it must hold.
 *
 * @param {string} dir
 * @param {string[]} names  file names, not paths
 * @returns {string[]} one message per problem; empty when it holds exactly those files
 */
export function checkArtifact(dir, names) {
  const stats = lstatOrNull(dir);
  if (stats === null) return [`${dir} is missing`];
  if (!stats.isDirectory()) return [`${dir} is not a folder`];
  const problems = [];
  const present = new Set(readdirSync(dir));
  for (const name of names) {
    if (!present.has(name)) {
      problems.push(`missing ${name}`);
      continue;
    }
    const file = lstatSync(join(dir, name));
    if (!file.isFile()) problems.push(`${name} is not a regular file`);
    else if (file.size === 0) problems.push(`${name} is empty`);
  }
  for (const name of [...present].sort(compare)) {
    if (names.includes(name)) continue;
    problems.push(lstatSync(join(dir, name)).isDirectory() ? `unexpected folder ${name}/` : `unexpected file ${name}`);
  }
  return problems;
}

/** `<dir> <name>...`, each name a plain file name, given once. Throws a usage error. */
function parseArgs(argv) {
  const [dir, ...names] = argv;
  if (dir === undefined || dir === "") throw new Error("give the artifact's folder");
  if (names.length === 0) throw new Error("name the files the folder must hold");
  for (const name of names) {
    if (name === "" || name === "." || name === ".." || /[/\\]/.test(name)) throw new Error(`${JSON.stringify(name)} is not a file name`);
  }
  if (new Set(names).size !== names.length) throw new Error("a file is named twice");
  return { dir, names };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`check-artifact: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  const problems = checkArtifact(args.dir, args.names);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`check-artifact: ${problem}\n`);
    process.stderr.write(`check-artifact: ${args.dir} doesn't hold exactly ${args.names.join(", ")}\n`);
    return 1;
  }
  process.stdout.write(`check-artifact: ${args.dir} holds exactly ${args.names.join(", ")}\n`);
  return 0;
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
