/**
 * Reading a CLI agent's login output: the sign-in URL, a device code, and
 * whether it waits for a pasted code. Shapes verified against each CLI's
 * real output (2026-11-28):
 *
 *   claude auth login   "If the browser didn't open, visit:\n<claude.ai URL>\n
 *                        Paste code here if prompted > "
 *   codex login         "Starting local login server on http://localhost:1455.
 *                        … navigate to this URL to authenticate:\n\n<auth.openai.com URL>"
 *   grok login --device-auth
 *                       "open this URL in your browser:\n  https://accounts.x.ai/oauth2/device?user_code=VQSW-NV6S
 *                        … Confirm this code in your browser:\n  VQSW-NV6S"
 *   kimi login          "Opening browser for Kimi device login: <url>\n
 *                        If the browser did not open, paste the URL above and enter code: <code>"
 *   copilot login       "To authenticate, visit https://github.com/login/device and enter code 1234-5678"
 *
 * The CLIs open the browser themselves; the card offers the URL in case that
 * didn't work.
 */

// Strip ANSI/terminal escape sequences (CSI, OSC, single-char escapes) so a
// regex isn't broken by cursor-positioning codes. Piped login output is
// already clean; this is defense-in-depth (e.g. if a ConPTY ever feeds in).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const CODE_IN_URL_RE = /[?&]user_code=([A-Za-z0-9-]+)/i;
const CODE_AFTER_PROMPT_RE = /enter (?:the )?code:?\s+([A-Za-z0-9][A-Za-z0-9-]{3,})/i;
const CODE_LINE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const PASTE_PROMPT_RE = /paste (?:the |your )?code/i;
const SIGNED_IN_AS_RE = /signed in (?:successfully )?as\s+(\S+)/i;

export interface LoginOutput {
  /** The sign-in URL to offer (never the CLI's own localhost callback). */
  url: string | null;
  /** A device code the user confirms in the browser. */
  code: string | null;
  /** The CLI waits for a code pasted back from the browser. */
  asksForCode: boolean;
  /** "Signed in as …" when the CLI said so. */
  signedInAs: string | null;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "0.0.0.0" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return true;
  }
}

/** Parse everything a login has printed so far (idempotent: pass the whole
 *  accumulated output each time). */
export function parseLoginOutput(raw: string): LoginOutput {
  // Escapes become spaces, not "": a ConPTY encodes line breaks as cursor
  // moves, and deleting them would glue the URL to the next word.
  const text = raw.replace(ANSI_RE, " ");
  let url: string | null = null;
  for (const m of text.matchAll(URL_RE)) {
    const candidate = m[0].replace(/[)\].,;'"]+$/, "");
    if (!isLoopback(candidate)) {
      url = candidate;
      break;
    }
  }
  const code =
    (url ? url.match(CODE_IN_URL_RE)?.[1] : undefined) ??
    text.match(CODE_AFTER_PROMPT_RE)?.[1] ??
    text.match(CODE_LINE_RE)?.[1] ??
    null;
  return {
    url,
    code: code ? code.replace(/[.,]+$/, "") : null,
    asksForCode: PASTE_PROMPT_RE.test(text),
    signedInAs: text.match(SIGNED_IN_AS_RE)?.[1]?.replace(/[.,]+$/, "") ?? null,
  };
}
