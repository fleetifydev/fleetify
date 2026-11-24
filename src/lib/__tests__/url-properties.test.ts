import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { isLoopbackDevUrl } from "../dev-server-url";
import { normalizeCloneUrl } from "../git-url";
import { safeExternalUrl } from "../utils";

/* Property-based tests: for each property fast-check generates a hundred
   inputs, the awkward ones a hand-written list misses among them, and shrinks
   a failure down to its smallest counterexample. */

/** Schemes a link must never open with, whatever a payload claims. */
const UNSAFE_SCHEMES = ["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "chrome:"];

/** An unsafe scheme in random case, maybe behind the whitespace or control
 *  character a URL parser skips. */
const disguisedScheme = fc
  .tuple(
    fc.constantFrom(...UNSAFE_SCHEMES),
    fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
    fc.constantFrom("", " ", "\t", "\n", "\u0000", "\u001f"),
  )
  .map(([scheme, upper, lead]) => lead + [...scheme].map((c, i) => (upper[i] ? c.toUpperCase() : c)).join(""));

function parses(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

describe("safeExternalUrl", () => {
  it("returns nothing but an http(s) URL", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.webUrl(), fc.tuple(disguisedScheme, fc.string()).map(([s, r]) => s + r)), (input) => {
        const out = safeExternalUrl(input);
        if (out !== undefined) expect(["http:", "https:"]).toContain(new URL(out).protocol);
      }),
    );
  });

  it("refuses an unsafe scheme however it is spelled", () => {
    fc.assert(
      fc.property(disguisedScheme, fc.string(), (scheme, rest) => {
        expect(safeExternalUrl(scheme + rest)).toBeUndefined();
      }),
    );
  });

  it("keeps a web URL it accepts, normalized as the browser would", () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        fc.pre(parses(url));
        expect(safeExternalUrl(url)).toBe(new URL(url).toString());
      }),
    );
  });

  it("gives the same answer for its own output", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.webUrl()), (input) => {
        const out = safeExternalUrl(input);
        if (out !== undefined) expect(safeExternalUrl(out)).toBe(out);
      }),
    );
  });
});

describe("isLoopbackDevUrl", () => {
  it("accepts http(s) on localhost and 127.0.0.1, any port and path", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("http", "https", "HTTP"),
        fc.constantFrom("localhost", "LocalHost", "127.0.0.1"),
        fc.integer({ min: 1, max: 65535 }),
        fc.webPath(),
        (scheme, host, port, path) => {
          expect(isLoopbackDevUrl(`${scheme}://${host}:${port}${path}`)).toBe(true);
        },
      ),
    );
  });

  it("refuses any other host, look-alikes included", () => {
    const lookAlike = fc.oneof(
      fc.domain().map((d) => `http://localhost.${d}/`),
      fc.domain().map((d) => `http://127.0.0.1.${d}/`),
      fc.domain().map((d) => `http://localhost@${d}/`),
      fc.domain().map((d) => `http://${d}/#@localhost`),
    );
    fc.assert(
      fc.property(fc.oneof(fc.webUrl(), lookAlike), (url) => {
        fc.pre(parses(url));
        const host = new URL(url).hostname;
        fc.pre(host !== "localhost" && host !== "127.0.0.1");
        expect(isLoopbackDevUrl(url)).toBe(false);
      }),
    );
  });

  it("refuses every scheme but http(s), even on localhost", () => {
    fc.assert(
      fc.property(disguisedScheme, (scheme) => {
        expect(isLoopbackDevUrl(`${scheme}//localhost:3000/`)).toBe(false);
      }),
    );
  });
});

describe("normalizeCloneUrl", () => {
  it("gives the same answer for its own output", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const once = normalizeCloneUrl(input);
        expect(normalizeCloneUrl(once)).toBe(once);
      }),
    );
  });

  it("turns any owner/repo shorthand into its github.com URL", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
        fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,40}$/),
        fc.constantFrom("", "/", "//", " ", " / "),
        (owner, repo, tail) => {
          expect(normalizeCloneUrl(`${owner}/${repo}${tail}`)).toBe(`https://github.com/${owner}/${repo}`);
        },
      ),
    );
  });
});
