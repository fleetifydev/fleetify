#!/usr/bin/env node
/**
 * check-dco.mjs — fail a pull request when a commit by a human lacks a
 * Developer Certificate of Origin sign-off (https://developercertificate.org).
 *
 *   node scripts/ci/check-dco.mjs
 *
 * It runs as the `DCO` job in .github/workflows/dco.yml. The pull request
 * number comes from the event file at GITHUB_EVENT_PATH; the commits come
 * from the GitHub REST API, read with GITHUB_TOKEN from GITHUB_REPOSITORY
 * (and GITHUB_API_URL, which defaults to https://api.github.com).
 *
 * Two kinds of commit are exempt:
 *   - commits by bots (Dependabot, the Fleetify Release Bot app);
 *   - merge commits, which have more than one parent. GitHub's "Update
 *     branch" button makes one on the contributor's behalf, without a
 *     sign-off, and common DCO checks skip them too.
 *
 * To try it against a real pull request:
 *
 *   echo '{"pull_request":{"number":3}}' > /tmp/event.json
 *   GITHUB_REPOSITORY=fleetifydev/fleetify GITHUB_TOKEN="$(gh auth token)" \
 *     GITHUB_EVENT_PATH=/tmp/event.json node scripts/ci/check-dco.mjs
 *
 * Exit codes:
 *   0  every commit is signed off or exempt
 *   1  at least one commit is missing a sign-off; the report names each one
 *      and the commands that fix it
 *   2  the check could not be completed: a variable is missing, the event
 *      has no pull request, or the API failed or hid commits. A check that
 *      cannot see every commit must fail rather than pass.
 *
 * The token is never printed.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A sign-off is a line "Signed-off-by: Name <email>", as `git commit -s`
 * writes it.
 *
 * How the sign-off has to relate to the commit (the author's name or email,
 * or the committer's) is deliberately left open. For now any well-formed
 * sign-off counts; tighten it here if the project decides to.
 *
 * Neither regex has the `g` flag, which keeps `test()` stateless.
 */
const SIGN_OFF = /^Signed-off-by: .+ <.+>$/m;
const MENTIONS_SIGN_OFF = /signed-off-by/i;

const MISSING = "no Signed-off-by line";
const MALFORMED =
  "no well-formed Signed-off-by line; it must read " +
  '"Signed-off-by: Name <email>" on a line of its own';

/** GitHub lists at most this many commits of a pull request. */
const MAX_LISTED_COMMITS = 250;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Whether a commit's author is a bot, which needs no sign-off. A commit is
 * exempt when authorLogin ends with "[bot]" or authorEmail ends with
 * "[bot]@users.noreply.github.com".
 *
 * @param {{ authorLogin?: string | null, authorEmail?: string | null }} commit
 * @returns {boolean}
 */
export function isBot(commit) {
  const login = commit.authorLogin ?? "";
  const email = commit.authorEmail ?? "";
  return login.endsWith("[bot]") || email.endsWith("[bot]@users.noreply.github.com");
}

/**
 * Whether a commit is a merge commit (more than one parent), which needs no
 * sign-off. A commit whose parent count is unknown is not a merge, so it is
 * checked.
 *
 * @param {{ parents?: number }} commit
 * @returns {boolean}
 */
export function isMerge(commit) {
  return (commit.parents ?? 0) > 1;
}

/**
 * The commits that need a sign-off and lack one, in the order given. Bots
 * and merge commits need none.
 *
 * @param {Array<{ sha: string, authorName: string, authorEmail: string,
 *   authorLogin: string | null, message: string, parents?: number }>} commits
 * @returns {Array<{ sha: string, reason: string }>} empty when every commit passes
 */
export function findUnsignedCommits(commits) {
  const failures = [];
  for (const commit of commits) {
    if (isBot(commit) || isMerge(commit)) continue;
    const message = commit.message ?? "";
    if (SIGN_OFF.test(message)) continue;
    const reason = MENTIONS_SIGN_OFF.test(message) ? MALFORMED : MISSING;
    failures.push({ sha: commit.sha, reason });
  }
  return failures;
}

/**
 * The report for a failed check: each commit with its reason, what a
 * sign-off certifies, and the commands that add one.
 *
 * @param {Array<{ sha: string, reason: string }>} failures
 * @returns {string}
 */
export function formatFailure(failures) {
  const count = failures.length === 1 ? "1 commit is" : `${failures.length} commits are`;
  return [
    `DCO: ${count} missing a sign-off.`,
    "",
    ...failures.map(({ sha, reason }) => `  ${sha}  ${reason}`),
    "",
    "Every commit in a pull request must be signed off under the Developer",
    "Certificate of Origin (https://developercertificate.org): its message ends",
    "with a line like",
    "",
    "  Signed-off-by: Your Name <you@example.com>",
    "",
    "which certifies that you wrote the change, or otherwise have the right to",
    "submit it under the project's licence. `git commit -s` adds the line, using",
    "your git user.name and user.email.",
    "",
    "To fix this, sign off the commits and update the pull request.",
    "",
    "If only the last commit is affected:",
    "",
    "  git commit --amend -s --no-edit",
    "  git push --force-with-lease",
    "",
    "Otherwise, sign off every commit on the branch:",
    "",
    "  git fetch origin",
    "  git rebase --signoff origin/main",
    "  git push --force-with-lease",
    "",
    "If origin is your fork, use the remote that points at this repository",
    "instead, for example upstream/main.",
  ].join("\n");
}

/**
 * An item of GET /repos/{repo}/pulls/{n}/commits in the shape
 * findUnsignedCommits takes. `author` is the GitHub account that the
 * commit's email belongs to, and null when it belongs to none; `parents` is
 * the array of parent commits.
 */
function toCommit(item) {
  return {
    sha: item.sha,
    authorName: item.commit?.author?.name ?? "",
    authorEmail: item.commit?.author?.email ?? "",
    authorLogin: item.author?.login ?? null,
    message: item.commit?.message ?? "",
    parents: item.parents?.length ?? 0,
  };
}

/**
 * Every commit of pull request `pr` that GitHub lists (at most 250), read
 * page by page.
 *
 * @param {{ apiUrl: string, repo: string, pr: number, token: string, perPage?: number }} options
 */
export async function fetchPullCommits({ apiUrl, repo, pr, token, perPage = 100 }) {
  // GitHub serves at most 100 per page. Asking for more would make a full
  // page look like the last one, and the loop would stop early.
  const size = Math.min(perPage, 100);
  const path = `/repos/${repo}/pulls/${pr}/commits`;
  const commits = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${apiUrl}${path}?per_page=${size}&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "fleetify-dco-check",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json()).message ?? "";
      } catch {
        // No JSON body; the status says enough.
      }
      throw new Error(`GET ${path} answered ${response.status}${detail ? ` (${detail})` : ""}`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error(`GET ${path} did not answer with a list`);
    commits.push(...batch.map(toCommit));
    if (batch.length < size || commits.length >= MAX_LISTED_COMMITS) return commits;
  }
}

/** `text` with every occurrence of the token masked. */
function redact(text, token) {
  return token ? String(text).split(token).join("***") : String(text);
}

const report = (message) => process.stderr.write(`DCO: ${message}\n`);

async function main(env) {
  const token = env.GITHUB_TOKEN?.trim() ?? "";
  const missing = [
    ["GITHUB_TOKEN", token],
    ["GITHUB_REPOSITORY", env.GITHUB_REPOSITORY],
    ["GITHUB_EVENT_PATH", env.GITHUB_EVENT_PATH],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    const verb = missing.length === 1 ? "is" : "are";
    report(
      `${missing.join(", ")} ${verb} not set. ` +
        "The check runs on pull_request events in GitHub Actions.",
    );
    return 2;
  }

  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch (err) {
    report(`cannot read the event file ${env.GITHUB_EVENT_PATH}: ${err.message}`);
    return 2;
  }
  const pr = event?.pull_request?.number;
  if (!Number.isInteger(pr) || pr < 1) {
    report("the event has no pull request number. The check runs on pull_request events.");
    return 2;
  }

  const apiUrl = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  let commits;
  try {
    commits = await fetchPullCommits({ apiUrl, repo: env.GITHUB_REPOSITORY, pr, token });
  } catch (err) {
    const cause = err.cause?.message ? ` (${err.cause.message})` : "";
    report(redact(`cannot list the commits of pull request #${pr}: ${err.message}${cause}`, token));
    return 2;
  }

  if (commits.length === 0) {
    report(`GitHub listed no commits for pull request #${pr}; failing rather than passing unchecked.`);
    return 2;
  }
  const total = event.pull_request.commits;
  if (commits.length >= MAX_LISTED_COMMITS && total !== commits.length) {
    const has = Number.isInteger(total) ? `has ${total}` : "may have more";
    report(
      `GitHub lists at most ${MAX_LISTED_COMMITS} commits of a pull request, and #${pr} ${has}, ` +
        "so some of its commits cannot be checked. Squash or split the pull request.",
    );
    return 2;
  }

  const failures = findUnsignedCommits(commits);
  if (failures.length > 0) {
    process.stderr.write(`${formatFailure(failures)}\n`);
    return 1;
  }

  const bots = commits.filter(isBot).length;
  const merges = commits.filter((commit) => !isBot(commit) && isMerge(commit)).length;
  const exemptions = [];
  if (bots > 0) exemptions.push(`${bots} by ${bots === 1 ? "a bot" : "bots"}`);
  if (merges > 0) exemptions.push(`${merges} ${merges === 1 ? "merge commit" : "merge commits"}`);
  const exempt = exemptions.length === 0 ? "" : ` or exempt (${exemptions.join(", ")})`;
  const noun = commits.length === 1 ? "commit" : "commits";
  process.stdout.write(`DCO: all ${commits.length} ${noun} signed off${exempt}\n`);
  return 0;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// exitCode instead of process.exit(): writes to a piped stdout can be
// asynchronous on some platforms, and exiting early could cut the report short.
if (invokedDirectly()) {
  main(process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      report(redact(`unexpected error: ${err?.stack ?? err}`, process.env.GITHUB_TOKEN?.trim()));
      process.exitCode = 2;
    },
  );
}
