/**
 * Tests for check-dco.mjs, the DCO sign-off check that runs on every pull
 * request.
 *
 *   node --test scripts/ci/check-dco.test.mjs
 *
 * The last group runs the script, and fetchPullCommits, against a local
 * stand-in for the GitHub REST API, so nothing here touches the network.
 * Addresses use the reserved example.com domain or GitHub's noreply domain.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchPullCommits, findUnsignedCommits, formatFailure, isBot, isMerge } from "./check-dco.mjs";

const SCRIPT = fileURLToPath(new URL("./check-dco.mjs", import.meta.url));

const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);
const SHA_3 = "3".repeat(40);

const SIGNED_OFF = "Signed-off-by: Jane Doe <jane@example.com>";

/** A commit as findUnsignedCommits receives it, authored by a human. */
const human = (sha, message) => ({
  sha,
  authorName: "Jane Doe",
  authorEmail: "jane@example.com",
  authorLogin: "janedoe",
  message,
});

describe("findUnsignedCommits", () => {
  test("passes a commit that carries a well-formed sign-off", () => {
    const commit = human(SHA_1, `feat: add the thing\n\nWhy it matters.\n\n${SIGNED_OFF}\n`);
    assert.deepEqual(findUnsignedCommits([commit]), []);
  });

  test("reports an unsigned human commit by its sha, and only that one", () => {
    const failures = findUnsignedCommits([
      human(SHA_1, `feat: one\n\n${SIGNED_OFF}\n`),
      human(SHA_2, "fix: two\n"),
      human(SHA_3, `docs: three\n\n${SIGNED_OFF}\n`),
    ]);
    assert.deepEqual(
      failures.map((f) => f.sha),
      [SHA_2],
    );
    assert.match(failures[0].reason, /\S/);
  });

  test("exempts an unsigned commit whose GitHub login is dependabot[bot]", () => {
    // The address is not a bot's noreply address, so only the login can exempt it.
    const commit = {
      sha: SHA_1,
      authorName: "dependabot[bot]",
      authorEmail: "bot@example.com",
      authorLogin: "dependabot[bot]",
      message: "deps: bump serde from 1.0.0 to 1.0.1\n",
    };
    assert.deepEqual(findUnsignedCommits([commit]), []);
  });

  test("exempts an unsigned commit from the release bot's noreply address", () => {
    // No linked GitHub account, so only the address can exempt it.
    const commit = {
      sha: SHA_1,
      authorName: "fleetify-release-bot[bot]",
      authorEmail: "123+fleetify-release-bot[bot]@users.noreply.github.com",
      authorLogin: null,
      message: "chore(main): release 0.2.0\n",
    };
    assert.deepEqual(findUnsignedCommits([commit]), []);
  });

  test("exempts an unsigned merge commit with two parents, as GitHub's Update branch makes", () => {
    const commit = { ...human(SHA_1, "Merge branch 'main' into feature\n"), parentCount: 2 };
    assert.deepEqual(findUnsignedCommits([commit]), []);
  });

  test("still reports an unsigned human commit with a single parent", () => {
    const commit = { ...human(SHA_1, "fix: thing\n"), parentCount: 1 };
    assert.deepEqual(
      findUnsignedCommits([commit]).map((f) => f.sha),
      [SHA_1],
    );
  });

  for (const line of [
    "Signed-off-by: Jane Doe",
    "Signed-off-by: Jane Doe <>",
    "Signed-off-by: <jane@example.com>",
  ]) {
    test(`rejects a sign-off without both a name and an email: "${line}"`, () => {
      const failures = findUnsignedCommits([human(SHA_1, `fix: thing\n\n${line}\n`)]);
      assert.deepEqual(
        failures.map((f) => f.sha),
        [SHA_1],
      );
    });
  }

  test("explains a malformed sign-off differently from a missing one", () => {
    const failures = findUnsignedCommits([
      human(SHA_1, "fix: one\n\nSigned-off-by: Jane Doe\n"),
      human(SHA_2, "fix: two\n"),
    ]);
    assert.deepEqual(
      failures.map((f) => f.sha),
      [SHA_1, SHA_2],
    );
    assert.notEqual(failures[0].reason, failures[1].reason);
  });

  test("does not count a sign-off that is quoted rather than at the start of its line", () => {
    const failures = findUnsignedCommits([
      human(SHA_1, `fix: keep the reviewer's note\n\nThe patch said:\n> ${SIGNED_OFF}\n`),
    ]);
    assert.deepEqual(
      failures.map((f) => f.sha),
      [SHA_1],
    );
  });

  test("passes a sign-off in a message with Windows (CRLF) line endings", () => {
    const commit = human(SHA_1, `fix: thing\r\n\r\nWhy it matters.\r\n\r\n${SIGNED_OFF}\r\n`);
    assert.deepEqual(findUnsignedCommits([commit]), []);
  });

  for (const line of [
    `${SIGNED_OFF} `,
    `${SIGNED_OFF}\t`,
    "signed-off-by: Jane Doe <jane@example.com>",
    "Signed-Off-By: Jane Doe <jane@example.com>",
  ]) {
    test(`points a near-miss sign-off at trailing spaces and the exact spelling: ${JSON.stringify(line)}`, () => {
      const failures = findUnsignedCommits([human(SHA_1, `fix: thing\n\n${line}\n`)]);
      assert.deepEqual(
        failures.map((f) => f.sha),
        [SHA_1],
      );
      assert.match(failures[0].reason, /trailing spaces/);
      assert.match(failures[0].reason, /spelling/);
      assert.match(failures[0].reason, /Signed-off-by:/);
    });
  }
});

describe("isMerge", () => {
  const cases = [
    ["one parent", { parentCount: 1 }, false],
    ["no parent count", {}, false],
    ["two parents", { parentCount: 2 }, true],
    ["three parents (an octopus merge)", { parentCount: 3 }, true],
  ];
  for (const [what, fields, expected] of cases) {
    test(`${expected ? "takes" : "does not take"} a commit with ${what} for a merge`, () => {
      assert.equal(isMerge({ sha: SHA_1, ...fields }), expected);
    });
  }
});

describe("isBot", () => {
  const cases = [
    ["a [bot] login", { authorLogin: "dependabot[bot]", authorEmail: "bot@example.com" }, true],
    [
      "a [bot] noreply address",
      { authorLogin: null, authorEmail: "123+fleetify-release-bot[bot]@users.noreply.github.com" },
      true,
    ],
    ["a human", { authorLogin: "janedoe", authorEmail: "jane@example.com" }, false],
    ["a human with no linked account", { authorLogin: null, authorEmail: "jane@example.com" }, false],
    [
      "a human's noreply address",
      { authorLogin: "janedoe", authorEmail: "123+janedoe@users.noreply.github.com" },
      false,
    ],
    [
      "a [bot] address on another domain",
      { authorLogin: "mallory", authorEmail: "mallory[bot]@example.com" },
      false,
    ],
    [
      "a login that does not end in [bot]",
      { authorLogin: "[bot]mallory", authorEmail: "mallory@example.com" },
      false,
    ],
  ];
  for (const [what, fields, expected] of cases) {
    test(`${expected ? "exempts" : "does not exempt"} ${what}`, () => {
      const commit = { sha: SHA_1, authorName: "Someone", message: "fix: x\n", ...fields };
      assert.equal(isBot(commit), expected);
    });
  }
});

describe("formatFailure", () => {
  test("lists every failing sha next to its reason, then the exact fix", () => {
    const failures = [
      { sha: SHA_1, reason: "reason for the first commit" },
      { sha: SHA_2, reason: "reason for the second commit" },
    ];
    const text = formatFailure(failures);
    const lines = text.split("\n");
    for (const { sha, reason } of failures) {
      assert.ok(
        lines.some((line) => line.includes(sha) && line.includes(reason)),
        `no line names ${sha} with its reason:\n${text}`,
      );
    }
    for (const fix of [
      "git rebase --signoff",
      "git push --force-with-lease",
      "git commit --amend -s",
      "https://developercertificate.org",
    ]) {
      assert.ok(text.includes(fix), `missing "${fix}":\n${text}`);
    }
  });

  test("rebases onto the pull request's base branch, which is main unless given", () => {
    const failures = [{ sha: SHA_1, reason: "no sign-off" }];
    assert.match(formatFailure(failures), /^ {2}git rebase --signoff upstream\/main$/m);
    const text = formatFailure(failures, "release/0.2");
    assert.match(text, /^ {2}git rebase --signoff upstream\/release\/0\.2$/m);
    assert.doesNotMatch(text, /\/main\b/);
  });

  test("names the remote that points at this repository before the commands that use it", () => {
    // Most contributors push from a fork, where origin is the fork.
    const text = formatFailure([{ sha: SHA_1, reason: "no sign-off" }]);
    const remote = text.indexOf("the remote that points at this repository");
    assert.notEqual(remote, -1, text);
    assert.ok(remote < text.indexOf("git fetch"), text);
    assert.ok(remote < text.indexOf("git rebase --signoff"), text);
  });
});

describe("against a stand-in for the GitHub API", () => {
  const REPO = "fleetifydev/fleetify";
  const PR = 42;
  const TOKEN = "fake-token-for-tests";
  const API_LIMIT = 250; // GitHub lists at most 250 commits of a pull request.

  const TMP = mkdtempSync(join(tmpdir(), "check-dco-"));
  after(() => rmSync(TMP, { recursive: true, force: true }));

  const shaOf = (n) => n.toString(16).padStart(40, "0");

  /** Item n of GET /repos/{repo}/pulls/{n}/commits, shaped like the real response. */
  function apiCommit(
    n,
    {
      message = `fix: change ${n}\n\n${SIGNED_OFF}\n`,
      name = "Jane Doe",
      email = "jane@example.com",
      account = { login: "janedoe", id: 1001, type: "User" },
      parentCount = 1,
    } = {},
  ) {
    const sha = shaOf(n);
    const tree = "f".repeat(40);
    const person = { name, email, date: "2026-11-20T10:00:00Z" };
    const user = account && { ...account, node_id: `U_${account.id}`, site_admin: false };
    return {
      sha,
      node_id: `C_${sha.slice(-8)}`,
      commit: {
        author: person,
        committer: person,
        message,
        tree: { sha: tree, url: `https://api.github.com/repos/${REPO}/git/trees/${tree}` },
        url: `https://api.github.com/repos/${REPO}/git/commits/${sha}`,
        comment_count: 0,
        verification: { verified: false, reason: "unsigned", signature: null, payload: null },
      },
      url: `https://api.github.com/repos/${REPO}/commits/${sha}`,
      html_url: `https://github.com/${REPO}/commit/${sha}`,
      comments_url: `https://api.github.com/repos/${REPO}/commits/${sha}/comments`,
      author: user,
      committer: user,
      parents: Array.from({ length: parentCount }, (_, i) => ({
        sha: shaOf(n * 10 + i + 100000),
        url: "",
        html_url: "",
      })),
    };
  }

  /**
   * A local stand-in for GET /repos/{repo}/pulls/{n}/commits. Like the real
   * endpoint it pages with per_page (default 30, at most 100) and page, sends
   * a Link header, and lists at most 250 commits. With `status` it answers
   * every request with that error instead. It closes when test `t` ends.
   */
  async function fakeGitHub(t, commits, { status } = {}) {
    const requests = [];
    let base;
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const { authorization } = req.headers;
      requests.push({ method: req.method, path: url.pathname, authorization });
      const send = (code, body, headers = {}) => {
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...headers });
        res.end(JSON.stringify(body));
      };
      if (status) return send(status, { message: "Not Found", status: String(status) });
      if (req.method !== "GET" || url.pathname !== `/repos/${REPO}/pulls/${PR}/commits`) {
        return send(404, { message: "Not Found", status: "404" });
      }
      const perPage = Math.min(Number(url.searchParams.get("per_page") || 30), 100);
      const page = Number(url.searchParams.get("page") || 1);
      const listed = commits.slice(0, API_LIMIT);
      const last = Math.max(1, Math.ceil(listed.length / perPage));
      const headers = {};
      if (page < last) {
        const at = (p) => `<${base}${url.pathname}?per_page=${perPage}&page=${p}>`;
        headers.link = `${at(page + 1)}; rel="next", ${at(last)}; rel="last"`;
      }
      send(200, listed.slice((page - 1) * perPage, page * perPage), headers);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    return { url: base, requests };
  }

  let events = 0;
  /**
   * A pull_request event file, as GITHUB_EVENT_PATH points at: `commits` is
   * the pull request's commit count, `head` its head commit's sha (left out
   * when null) and `base` the branch it targets.
   */
  function eventFile({ commits, head, base }) {
    const file = join(TMP, `event-${++events}.json`);
    const pullRequest = { number: PR, state: "open", commits, base: { ref: base } };
    if (head !== null) pullRequest.head = { sha: head };
    const event = { action: "synchronize", number: PR, pull_request: pullRequest };
    writeFileSync(file, JSON.stringify(event));
    return file;
  }

  /** Run the script with the given GitHub variables and nothing else from the outside. */
  function runCli(vars) {
    const env = { ...process.env };
    for (const name of ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_EVENT_PATH", "GITHUB_API_URL"]) {
      delete env[name];
    }
    Object.assign(env, vars);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  /**
   * The variables the workflow provides, pointed at `api`, for a pull request
   * of `commitCount` commits. Its head is the last of them, apiCommit(n), and
   * its base main, unless `head` or `base` says otherwise.
   */
  const vars = (api, commitCount, { head = shaOf(commitCount), base = "main" } = {}) => ({
    GITHUB_TOKEN: TOKEN,
    GITHUB_REPOSITORY: REPO,
    GITHUB_EVENT_PATH: eventFile({ commits: commitCount, head, base }),
    GITHUB_API_URL: api.url,
  });

  test("fetchPullCommits reads every page even when asked for more than 100 per page", async (t) => {
    // GitHub serves at most 100 per page, so a 100-item page is not the last one here.
    const commits = Array.from({ length: 130 }, (_, i) => apiCommit(i + 1));
    const api = await fakeGitHub(t, commits);
    const listed = await fetchPullCommits({
      apiUrl: api.url,
      repo: REPO,
      pr: PR,
      token: TOKEN,
      perPage: 500,
    });
    assert.equal(listed.length, 130);
    assert.equal(listed.at(-1).sha, shaOf(130));
  });

  test("reads every page and passes when all 130 commits are signed off", async (t) => {
    // Every tenth author has no GitHub account, so the API's `author` is null.
    const commits = Array.from({ length: 130 }, (_, i) =>
      apiCommit(i + 1, i % 10 === 0 ? { account: null } : {}),
    );
    const api = await fakeGitHub(t, commits);
    const result = await runCli(vars(api, commits.length));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "DCO: all 130 commits signed off\n");
    assert.ok(api.requests.length > 0);
    for (const request of api.requests) assert.equal(request.authorization, `Bearer ${TOKEN}`);
    assert.ok(!(result.stdout + result.stderr).includes(TOKEN), "token printed");
  });

  test("exits 1 and names an unsigned commit on the second page, with the fix", async (t) => {
    const commits = Array.from({ length: 130 }, (_, i) => apiCommit(i + 1));
    commits[116] = apiCommit(117, { message: "fix: forgot to sign off\n" });
    const api = await fakeGitHub(t, commits);
    const result = await runCli(vars(api, commits.length));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const output = result.stdout + result.stderr;
    assert.ok(output.includes(shaOf(117)), output);
    assert.ok(!output.includes(shaOf(116)), output);
    assert.ok(output.includes("git rebase --signoff"), output);
  });

  test("tells the contributor to rebase onto the pull request's own base branch", async (t) => {
    const commits = [apiCommit(1, { message: "fix: forgot to sign off\n" })];
    const api = await fakeGitHub(t, commits);
    const result = await runCli(vars(api, commits.length, { base: "release/0.2" }));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /^ {2}git rebase --signoff upstream\/release\/0\.2$/m);
  });

  test("passes a bot PR whose Dependabot and release-bot commits carry no sign-off", async (t) => {
    const commits = [
      apiCommit(1, {
        name: "dependabot[bot]",
        email: "49699333+dependabot[bot]@users.noreply.github.com",
        account: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
        message: "deps: bump serde from 1.0.0 to 1.0.1\n",
      }),
      apiCommit(2, {
        name: "fleetify-release-bot[bot]",
        email: "123+fleetify-release-bot[bot]@users.noreply.github.com",
        account: { login: "fleetify-release-bot[bot]", id: 123, type: "Bot" },
        message: "chore(main): release 0.2.0\n",
      }),
    ];
    const api = await fakeGitHub(t, commits);
    const result = await runCli(vars(api, commits.length));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^DCO: all 2 commits signed off/);
    assert.match(result.stdout, /exempt/);
  });

  test("passes a PR whose only unsigned commit is a merge from Update branch", async (t) => {
    const commits = [
      apiCommit(1),
      apiCommit(2, { message: "Merge branch 'main' into feature\n", parentCount: 2 }),
    ];
    const api = await fakeGitHub(t, commits);
    const result = await runCli(vars(api, commits.length));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^DCO: all 2 commits signed off/);
    assert.match(result.stdout, /exempt/);
  });

  test("exits 2 and names the variable when GITHUB_TOKEN is not set", async (t) => {
    const api = await fakeGitHub(t, [apiCommit(1)]);
    const { GITHUB_TOKEN: _unset, ...rest } = vars(api, 1);
    const result = await runCli(rest);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /GITHUB_TOKEN/);
    assert.equal(api.requests.length, 0);
  });

  test("fails closed with exit 2 when the API answers with an error", async (t) => {
    const api = await fakeGitHub(t, [], { status: 404 });
    const result = await runCli(vars(api, 3));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /404/);
    assert.ok(!(result.stdout + result.stderr).includes(TOKEN), "token printed");
  });

  test("fails closed with exit 2 when the API's 250-commit limit hides commits", async (t) => {
    // Commit 255 is unsigned, but the API never lists it.
    const commits = Array.from({ length: 260 }, (_, i) => apiCommit(i + 1));
    commits[254] = apiCommit(255, { message: "fix: hidden past the limit\n" });
    const api = await fakeGitHub(t, commits);
    const result = await runCli(vars(api, commits.length));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /250/);
  });

  test("fails closed with exit 2 when the API lists no commits", async (t) => {
    const api = await fakeGitHub(t, []);
    const result = await runCli(vars(api, 0));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /signed off/);
  });

  test("fails closed with exit 2 when a short page ends the list before the head commit", async (t) => {
    // The API answers with the first 60 of the pull request's 130 commits, as
    // if a page had come back short. Commit 117, past them, is unsigned.
    const commits = Array.from({ length: 130 }, (_, i) => apiCommit(i + 1));
    commits[116] = apiCommit(117, { message: "fix: hidden behind a short page\n" });
    const api = await fakeGitHub(t, commits.slice(0, 60));
    const result = await runCli(vars(api, commits.length));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(shaOf(130)), result.stderr);
    assert.doesNotMatch(result.stdout, /signed off/);
  });

  test("fails closed with exit 2 when the branch moved after the event, so its head isn't listed", async (t) => {
    // A force-push between the event and the listing: the API lists the new
    // commits, none of which is the head the event names.
    const api = await fakeGitHub(t, [apiCommit(1), apiCommit(2)]);
    const result = await runCli(vars(api, 2, { head: shaOf(99) }));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(shaOf(99)), result.stderr);
    assert.doesNotMatch(result.stdout, /signed off/);
  });

  test("exits 2 without asking the API when the event names no head commit", async (t) => {
    const api = await fakeGitHub(t, [apiCommit(1)]);
    const result = await runCli(vars(api, 1, { head: null }));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /head/);
    assert.equal(api.requests.length, 0);
  });
});
