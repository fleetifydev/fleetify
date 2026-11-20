/**
 * Checks for the links and contact addresses in the project's public docs,
 * the files in DOCS:
 *
 * - every relative link, image and reference definition, and every href, src
 *   and srcset in their HTML, points to a file that exists;
 * - every #anchor matches a heading in the file it points into, slugged the
 *   way GitHub slugs headings;
 * - every link into github.com/fleetifydev/fleetify goes to a page on a short
 *   allow-list (GITHUB_PAGES), so none points at a page that doesn't exist,
 *   such as a release download before the first release;
 * - the only email addresses are the project's contacts (CONTACTS).
 *
 *   node --test scripts/ci/check-docs-links.test.mjs
 *
 * A link counts where GitHub renders one: not inside a code block, a code span
 * or an HTML comment. The github.com and address checks read the whole file,
 * since everything in it is published. Nothing here touches the network.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The docs these checks cover. A doc marked `pending` arrives with a later
 * change, and its checks skip until it exists. Drop `pending` once the file
 * lands, so that losing it fails the checks.
 */
const DOCS = [
  { file: "README.md" },
  { file: "README.tr.md", pending: "the Turkish README comes with the README rewrite" },
  { file: "CONTRIBUTING.md" },
  { file: "SECURITY.md" },
  { file: "SUPPORT.md" },
  { file: "CODE_OF_CONDUCT.md" },
  { file: "TRADEMARKS.md" },
  { file: "docs/INSTALL.md", pending: "the install guide comes with the docs review" },
];

/** The only email addresses the docs may show: security reports, the code of conduct, business. */
const CONTACTS = ["security@fleetify.dev", "conduct@fleetify.dev", "hello@fleetify.dev"];

/**
 * The pages of github.com/fleetifydev/fleetify the docs may link to, besides
 * the repository's front page. A link may also go to a page below one, such as
 * discussions/categories/q-a, issues/new/choose or
 * actions/workflows/ci.yml/badge.svg, unless the entry is `exact`: nothing
 * exists under releases/ before the first release, so a download link there
 * would return 404.
 */
const GITHUB_PAGES = [
  { path: "discussions" },
  { path: "security/advisories/new", exact: true },
  { path: "issues" },
  { path: "actions/workflows/ci.yml" },
  { path: "releases", exact: true },
];

/** An inline link or image, [text](destination "title"), allowing one level of brackets in the text. */
const INLINE_LINK =
  /(!?)\[((?:\\.|[^[\]\\]|\[(?:\\.|[^[\]\\])*\])*)\]\(\s*(<(?:\\.|[^<>\\\n])*>|(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+)?(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?\s*\)/g;

/** A link reference definition, [label]: destination. A footnote, [^1]: text, isn't one. */
const REFERENCE_DEFINITION = /^[ \t]{0,3}\[(?!\^)((?:\\.|[^[\]\\])+)\]:[ \t]*\n?[ \t]*(<[^<>\n]*>|\S+)/gm;

const HTML_TAG = /<[A-Za-z][^<>]*>/g;
const HTML_URL_ATTRIBUTE = /\s(href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const HTML_ANCHOR_ATTRIBUTE = /\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** A link into this repository on github.com; group 1 is whatever follows the repository's name. */
const REPO_LINK = /https?:\/\/(?:www\.)?github\.com\/fleetifydev\/fleetify(?![\w.-])([^\s<>"'`)\]]*)/gi;

/**
 * An email address. The domain starts with a letter, so that an image named
 * logo@2x.png or a package pinned as react@19.0.0 isn't taken for one.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** `match` with everything but its line breaks turned into spaces, so that offsets and line numbers stay put. */
const blank = (match) => match.replace(/[^\n]/g, " ");

/** The line of `text` that `offset` falls on, counting from 1. */
const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;

/** `markdown` with its fenced code blocks and HTML comments blanked out. */
function withoutCodeBlocks(markdown) {
  let closing = null;
  const lines = markdown.split("\n").map((line) => {
    if (closing) {
      if (closing.test(line)) closing = null;
      return blank(line);
    }
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence's info string holds no backtick: ```a``` is a code span.
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      closing = new RegExp(`^\\s*${open[1][0]}{${open[1].length},}\\s*$`);
      return blank(line);
    }
    return line;
  });
  return lines.join("\n").replace(/<!--[\s\S]*?-->/g, blank);
}

/** `markdown` with everything GitHub never renders as a link blanked out: code blocks, comments, code spans. */
function withoutCode(markdown) {
  // A code span is a run of backticks, then anything but a blank line, then the same run.
  return withoutCodeBlocks(markdown).replace(/(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g, blank);
}

/** A destination as written, without its angle brackets and backslash escapes. */
const destination = (raw) => raw.replace(/^<([\s\S]*)>$/, "$1").replace(/\\([!-/:-@[-`{-~])/g, "$1");

/**
 * Every link destination in `markdown`, with its line: inline links and
 * images, reference definitions, and href, src and srcset in its HTML.
 */
function linkTargets(markdown) {
  const text = withoutCode(markdown);
  const found = [];
  const inline = (part, offset) => {
    for (const m of part.matchAll(INLINE_LINK)) {
      const at = offset + m.index;
      if (m[3] !== undefined) found.push({ target: destination(m[3]), line: lineAt(text, at) });
      // The text can hold an image of its own: [![logo](logo.svg)](https://…).
      inline(m[2], at + m[1].length + 1);
    }
  };
  inline(text, 0);
  for (const m of text.matchAll(REFERENCE_DEFINITION)) {
    found.push({ target: destination(m[2]), line: lineAt(text, m.index) });
  }
  for (const tag of text.matchAll(HTML_TAG)) {
    for (const attribute of tag[0].matchAll(HTML_URL_ATTRIBUTE)) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      // srcset lists candidates, "url [descriptor]", separated by commas.
      const urls =
        attribute[1].toLowerCase() === "srcset"
          ? value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0])
          : [value];
      for (const url of urls.filter(Boolean)) found.push({ target: url, line: lineAt(text, tag.index) });
    }
  }
  return found;
}

const decode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * Where a link points in the repository: the file, relative to the root (the
 * linking file itself for a bare #anchor), and the anchor, "" for none. Null
 * for a link with a scheme (https:, mailto:, …), which leaves the repository.
 */
function inRepo(sourceRel, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  const hash = target.indexOf("#");
  const path = decode((hash === -1 ? target : target.slice(0, hash)).split("?")[0]);
  const anchor = hash === -1 ? "" : decode(target.slice(hash + 1));
  if (path === "") return { file: sourceRel, anchor };
  // GitHub resolves a path that starts with / from the repository's root.
  const base = path.startsWith("/") ? ROOT : join(ROOT, dirname(sourceRel));
  return { file: relative(ROOT, join(base, path)), anchor };
}

/** Whether a path relative to the root leaves the repository; on Windows, path.relative uses backslashes. */
const outsideRepo = (file) => file === ".." || file.startsWith("../") || file.startsWith("..\\") || isAbsolute(file);

const isMarkdown = (file) => /\.(md|markdown)$/i.test(file);

/** A heading's text as GitHub renders it: markup gone, links and code spans reduced to their text. */
function plainText(raw) {
  const spans = [];
  const text = raw
    // Code spans keep their text as written, so set them aside first.
    .replace(/(`+)([\s\S]+?)\1/g, (_match, _ticks, code) => {
      spans.push(/^ [\s\S]* $/.test(code) && code.trim() !== "" ? code.slice(1, -1) : code);
      return `\u0000${spans.length - 1}\u0000`;
    })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+(?=\S)([^_]+?)(?<=\S)_+(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[entity])
    .replace(/\\([!-/:-@[-`{-~])/g, "$1");
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]).trim();
}

/**
 * GitHub's slug for a heading (github-slugger): lowercase, everything but
 * letters, marks, numbers, connectors (_), spaces and hyphens dropped, and
 * each space turned into a hyphen.
 */
const slugify = (text) => text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");

/** `slug`, or slug-1, slug-2, … when a heading before it already took it, as github-slugger counts. */
function uniqueSlug(slug, taken) {
  let result = slug;
  while (taken.has(result)) {
    taken.set(slug, taken.get(slug) + 1);
    result = `${slug}-${taken.get(slug)}`;
  }
  taken.set(result, 0);
  return result;
}

/** The anchors in `markdown`: GitHub's slugs of its headings, and the id and name attributes in its HTML. */
function anchorsOf(markdown) {
  const text = withoutCodeBlocks(markdown);
  const anchors = new Set();
  const taken = new Map();
  for (const line of text.split("\n")) {
    const heading = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) anchors.add(uniqueSlug(slugify(plainText(heading[1] ?? "")), taken));
  }
  for (const tag of text.matchAll(HTML_TAG)) {
    for (const attribute of tag[0].matchAll(HTML_ANCHOR_ATTRIBUTE)) anchors.add(attribute[1] ?? attribute[2]);
  }
  return anchors;
}

/** Every link into the repository on github.com in `text`, with the page it opens ("" for the front page). */
function repoLinks(text) {
  return [...text.matchAll(REPO_LINK)].map((m) => {
    // Punctuation that ends a sentence isn't part of the link, as with GitHub's autolinks.
    const rest = m[1].replace(/[.,:;!?*_~]+$/, "");
    const page = rest.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
    return { url: m[0].slice(0, m[0].length - m[1].length) + rest, page, line: lineAt(text, m.index) };
  });
}

const allowedPage = (page) =>
  page === "" || GITHUB_PAGES.some(({ path, exact }) => page === path || (!exact && page.startsWith(`${path}/`)));

/** Every email address in `text`, with its line. */
const emailsIn = (text) => [...text.matchAll(EMAIL)].map((m) => ({ email: m[0], line: lineAt(text, m.index) }));

/** The text of `rel` (relative to the repo root), with Windows line endings normalised, failing clearly when it's missing. */
function read(rel) {
  const file = join(ROOT, rel);
  assert.ok(existsSync(file), `${rel} is missing`);
  return readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
}

/** Fails, listing every problem on a line of its own, unless there are none. */
function assertNone(problems, what) {
  assert.ok(problems.length === 0, `${what}:\n  ${problems.join("\n  ")}`);
}

describe("docs", () => {
  const anchorCache = new Map();
  const anchorsIn = (rel) => {
    if (!anchorCache.has(rel)) anchorCache.set(rel, anchorsOf(read(rel)));
    return anchorCache.get(rel);
  };

  for (const { file, pending } of DOCS) {
    const skip = pending && !existsSync(join(ROOT, file)) ? `${file} doesn't exist yet: ${pending}` : false;

    /** The doc's links into the repository, with where each one points. */
    const localLinks = () =>
      linkTargets(read(file))
        .map((link) => ({ ...link, to: inRepo(file, link.target) }))
        .filter((link) => link.to !== null);

    test(`${file}: relative links point to files that exist`, { skip }, () => {
      const problems = [];
      for (const { target, line, to } of localLinks()) {
        if (outsideRepo(to.file)) problems.push(`${file}:${line}: ${target} points outside the repository`);
        else if (!existsSync(join(ROOT, to.file))) problems.push(`${file}:${line}: ${target}: there is no ${to.file}`);
      }
      assertNone(problems, `${file} links to files that don't exist`);
    });

    test(`${file}: anchors match headings in the files they point into`, { skip }, () => {
      const problems = [];
      for (const { target, line, to } of localLinks()) {
        // A missing file is the test above's to report.
        if (to.anchor === "" || outsideRepo(to.file) || !existsSync(join(ROOT, to.file))) continue;
        if (!isMarkdown(to.file)) {
          problems.push(`${file}:${line}: ${target}: ${to.file} isn't markdown, so it has no headings to link to`);
        } else if (!anchorsIn(to.file).has(to.anchor)) {
          problems.push(`${file}:${line}: ${target}: ${to.file} has no heading with the anchor #${to.anchor}`);
        }
      }
      assertNone(problems, `${file} links to anchors that don't exist`);
    });

    test(`${file}: links into github.com/fleetifydev/fleetify go to allowed pages`, { skip }, () => {
      const problems = repoLinks(read(file))
        .filter(({ page }) => !allowedPage(page))
        .map(({ url, line }) => `${file}:${line}: ${url}`);
      const allowed = GITHUB_PAGES.map(({ path, exact }) => (exact ? path : `${path}[/…]`)).join(", ");
      assertNone(problems, `${file} links to pages outside the allow-list (${allowed}); link a repository file relatively`);
    });

    test(`${file}: the only email addresses are the project contacts`, { skip }, () => {
      const problems = emailsIn(read(file))
        .filter(({ email }) => !CONTACTS.includes(email.toLowerCase()))
        .map(({ email, line }) => `${file}:${line}: ${email}`);
      assertNone(problems, `${file} shows addresses other than ${CONTACTS.join(", ")}`);
    });
  }
});

describe("contact points", () => {
  /** Fails unless `rel` contains every one of `expected`. */
  function assertMentions(rel, expected) {
    const text = read(rel);
    const missing = expected.filter((part) => !text.includes(part));
    assertNone(missing, `${rel} doesn't mention`);
  }

  test("SECURITY.md takes reports through private vulnerability reporting and security@fleetify.dev", () => {
    assertMentions("SECURITY.md", [
      "https://github.com/fleetifydev/fleetify/security/advisories/new",
      "security@fleetify.dev",
    ]);
  });

  test("CODE_OF_CONDUCT.md names conduct@fleetify.dev for reports and keeps no placeholder", () => {
    assertMentions("CODE_OF_CONDUCT.md", ["conduct@fleetify.dev"]);
    assert.ok(!read("CODE_OF_CONDUCT.md").includes("[INSERT CONTACT METHOD]"), "the contact placeholder is still there");
  });

  test("SUPPORT.md routes questions, bugs, vulnerabilities and business to their channels", () => {
    assertMentions("SUPPORT.md", [
      "https://github.com/fleetifydev/fleetify/discussions",
      "https://github.com/fleetifydev/fleetify/issues/new/choose",
      "hello@fleetify.dev",
    ]);
    const linksSecurity = linkTargets(read("SUPPORT.md")).some(
      ({ target }) => inRepo("SUPPORT.md", target)?.file === "SECURITY.md",
    );
    assert.ok(linksSecurity, "SUPPORT.md doesn't link SECURITY.md for vulnerabilities");
  });
});

describe("the checker", () => {
  test("slugs headings the way GitHub does", () => {
    const markdown = [
      "# Contributing to Fleetify",
      "## Dev setup",
      "## The `DCO` sign-off ##",
      "## What's in scope?",
      "## Safe harbour & bounty",
      "### `FLEETIFY_NOAUTH=1` runs",
      "## [Linked](https://example.com) _heading_",
      "## Gizlilik ve güvenlik",
      "## Notes",
      "## Notes",
      "#not-a-heading",
      "```bash",
      "# a shell comment, not a heading",
      "```",
      '<a id="custom-anchor"></a>',
    ].join("\n");
    assert.deepEqual(
      [...anchorsOf(markdown)].sort(),
      [
        "contributing-to-fleetify",
        "custom-anchor",
        "dev-setup",
        "fleetify_noauth1-runs",
        "gizlilik-ve-güvenlik",
        "linked-heading",
        "notes",
        "notes-1",
        "safe-harbour--bounty",
        "the-dco-sign-off",
        "whats-in-scope",
      ],
    );
  });

  test("finds links, images, reference definitions and HTML URLs, but none in code or comments", () => {
    const markdown = [
      'See [the guide](docs/guide.md#setup) and ![a screenshot](<docs/images/a shot.png> "Title").',
      "[![CI](https://example.com/badge.svg)](docs/badge-target.md)",
      "[ref]: TRADEMARKS.md",
      "[^note]: a footnote, not a link",
      '<a href="SUPPORT.md"><img src="docs/images/mark.svg" srcset="docs/images/mark@2x.png 2x, docs/images/mark@3x.png 3x"></a>',
      "`[not a link](code-span.md)` and <!-- [nor this](comment.md) -->",
      "```",
      "[nor this](fenced.md)",
      "```",
      "[mail](mailto:hello@fleetify.dev)",
    ].join("\n");
    assert.deepEqual(
      linkTargets(markdown)
        .map(({ target, line }) => `${line} ${target}`)
        .sort(),
      [
        "1 docs/guide.md#setup",
        "1 docs/images/a shot.png",
        "10 mailto:hello@fleetify.dev",
        "2 docs/badge-target.md",
        "2 https://example.com/badge.svg",
        "3 TRADEMARKS.md",
        "5 SUPPORT.md",
        "5 docs/images/mark.svg",
        "5 docs/images/mark@2x.png",
        "5 docs/images/mark@3x.png",
      ],
    );
  });

  test("resolves links from the linking file's folder, or the root for a leading /", () => {
    assert.deepEqual(inRepo("docs/INSTALL.md", "../SECURITY.md#scope"), { file: "SECURITY.md", anchor: "scope" });
    assert.deepEqual(inRepo("docs/INSTALL.md", "/README.md"), { file: "README.md", anchor: "" });
    assert.deepEqual(inRepo("CONTRIBUTING.md", "#the-gates"), { file: "CONTRIBUTING.md", anchor: "the-gates" });
    assert.equal(inRepo("CONTRIBUTING.md", "https://example.com/x.md"), null);
    assert.ok(outsideRepo(inRepo("CONTRIBUTING.md", "../elsewhere.md").file));
  });

  test("allows only the listed github.com/fleetifydev/fleetify pages", () => {
    const allowed = [
      "https://github.com/fleetifydev/fleetify",
      "https://github.com/fleetifydev/fleetify/discussions.",
      "https://github.com/fleetifydev/fleetify/discussions/categories/q-a",
      "https://github.com/fleetifydev/fleetify/issues/new/choose",
      "https://github.com/fleetifydev/fleetify/issues?q=label%3A%22good+first+issue%22",
      "https://github.com/fleetifydev/fleetify/security/advisories/new",
      "https://github.com/fleetifydev/fleetify/actions/workflows/ci.yml/badge.svg",
      "https://github.com/fleetifydev/fleetify/releases",
    ];
    const refused = [
      "https://github.com/fleetifydev/fleetify/releases/latest/download/SHA256SUMS",
      "https://github.com/fleetifydev/fleetify/blob/main/CONTRIBUTING.md",
      "https://github.com/fleetifydev/fleetify/security/advisories",
      "https://github.com/fleetifydev/fleetify/issuesx",
    ];
    assert.deepEqual(
      repoLinks(allowed.join("\n")).map(({ page }) => allowedPage(page)),
      allowed.map(() => true),
    );
    assert.deepEqual(
      repoLinks(refused.join("\n")).map(({ page }) => allowedPage(page)),
      refused.map(() => false),
    );
    // Other repositories and accounts are no concern of the allow-list.
    assert.deepEqual(repoLinks("https://github.com/fleetifydev/fleetify-example https://github.com/dorukozgen"), []);
  });

  test("finds email addresses, but not handles, scoped packages, versions or @2x images", () => {
    const text = "Mail jane@example.com or SECURITY@FLEETIFY.DEV. Ping @dorukozgen; run @tauri-apps/cli@2.11.0 or react@19.0.0; see logo@2x.png.";
    assert.deepEqual(
      emailsIn(text).map(({ email }) => email),
      ["jane@example.com", "SECURITY@FLEETIFY.DEV"],
    );
  });
});
