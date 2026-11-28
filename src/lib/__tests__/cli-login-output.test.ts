import { describe, it, expect } from "vitest";
import { parseLoginOutput } from "../cli-login-output";
import { unseenTail } from "../pty-replay";

// Real output, captured from each CLI's login run without a terminal
// (2026-11-28); OAuth parameters shortened.
const CLAUDE =
  "Opening browser to sign in…\n" +
  "If the browser didn't open, visit:\n" +
  "https://claude.ai/oauth/authorize?z-Aj-lq2T2zvbx9Sr5Yug62AfUJGeIRuPfFlCDVBELBfE\n" +
  "Paste code here if prompted > ";
const CODEX =
  "Starting local login server on http://localhost:1455.\n" +
  "If your browser did not open, navigate to this URL to authenticate:\n\n" +
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s\n\n" +
  "On a remote or headless machine? Use `codex login --device-auth` instead.\n";
const GROK =
  "\nTo sign in, open this URL in your browser:\n\n" +
  "  https://accounts.x.ai/oauth2/device?user_code=VQSW-NV6S\n\n" +
  "Confirm this code in your browser:\n\n  VQSW-NV6S\n\n" +
  "Only continue with a code you requested. Don't share it with anyone.\n\nWaiting for authorization...\n";
// From the kimi-code 2.8 and Copilot CLI sources / docs.
const KIMI =
  "\nOpening browser for Kimi device login: https://www.kimi.com/device?code=ABCD1234\n" +
  "If the browser did not open, paste the URL above and enter code: ABCD1234\n" +
  "Code expires in 600s.\nWaiting for authorization to complete…\n";
const COPILOT =
  "To authenticate, visit https://github.com/login/device and enter code 1234-5678\nWaiting for authorization...\n";

describe("parseLoginOutput", () => {
  it("reads Claude Code's fallback URL and its paste-code prompt", () => {
    const o = parseLoginOutput(CLAUDE);
    expect(o.url).toBe(
      "https://claude.ai/oauth/authorize?z-Aj-lq2T2zvbx9Sr5Yug62AfUJGeIRuPfFlCDVBELBfE",
    );
    expect(o.asksForCode).toBe(true);
    expect(o.code).toBeNull();
  });

  it("skips Codex's localhost callback server and offers the auth URL", () => {
    const o = parseLoginOutput(CODEX);
    expect(o.url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    expect(o.asksForCode).toBe(false);
  });

  it("reads Grok's device URL and code", () => {
    const o = parseLoginOutput(GROK);
    expect(o.url).toBe("https://accounts.x.ai/oauth2/device?user_code=VQSW-NV6S");
    expect(o.code).toBe("VQSW-NV6S");
  });

  it("reads Kimi's and Copilot's device codes", () => {
    expect(parseLoginOutput(KIMI).code).toBe("ABCD1234");
    expect(parseLoginOutput(KIMI).asksForCode).toBe(false);
    const c = parseLoginOutput(COPILOT);
    expect(c.url).toBe("https://github.com/login/device");
    expect(c.code).toBe("1234-5678");
  });

  it("strips terminal escape codes before matching", () => {
    const E = "\x1b";
    const o = parseLoginOutput(
      `${E}[?25lTo sign in, open this URL in your browser:${E}[4;1H  ` +
        `https://accounts.x.ai/oauth2/device?user_code=42EN-YCNG${E}[6;1H${E}[?25h` +
        `Confirm this code in your browser:${E}[8;1H  42EN-YCNG`,
    );
    expect(o.url).toBe("https://accounts.x.ai/oauth2/device?user_code=42EN-YCNG");
    expect(o.code).toBe("42EN-YCNG");
  });

  it("reports who signed in when the CLI says so", () => {
    expect(parseLoginOutput("Signed in successfully as Octocat.").signedInAs).toBe("Octocat");
    expect(parseLoginOutput("").url).toBeNull();
  });
});

describe("unseenTail", () => {
  it("drops the live chunks the buffer already holds", () => {
    expect(unseenTail("abc", "bcd")).toBe("d");
    expect(unseenTail("abc", "abc")).toBe("");
    expect(unseenTail("", "xyz")).toBe("xyz");
    expect(unseenTail("abc", "xyz")).toBe("xyz");
  });
});
