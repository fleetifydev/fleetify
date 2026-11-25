import { useEffect, useState, type ReactNode } from "react";
import { Loader2, AlertCircle, ArrowRight } from "lucide-react";
import { LogoMark } from "@/components/brand/logo-mark";
import { ProviderLogo } from "@/components/ui/provider-logo";
import type { AuthUser } from "@/lib/api";
import { openExternalUrl } from "@/lib/links";

interface WelcomeScreenProps {
  onAuth: (user: AuthUser, token: string, isNew: boolean) => void;
}

const PROVIDERS = ["claude-code", "codex-cli", "cursor-cli", "ollama", "kimi-code"] as const;

/** fleetify.dev's legal pages: signing in accepts the Terms of Service, and
 *  the Privacy Policy says what the app and fleetify.dev collect. */
const TERMS_URL = "https://fleetify.dev/legal/terms";
const PRIVACY_URL = "https://fleetify.dev/legal/privacy";

/** A link to a page on fleetify.dev. It opens in the system browser: the
 *  main window doesn't stop a page from another site, so a plain `<a href>`
 *  would load the page in place of the app. */
function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="no-drag"
      href={href}
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        openExternalUrl(href);
      }}
      style={{ color: "var(--m-text-2)", textDecoration: "underline", textUnderlineOffset: 2 }}
    >
      {children}
    </a>
  );
}

/**
 * Welcome — chevron + Geist Bold lockup, provider logo strip, single
 * "Sign in with Fleetify" CTA. Click triggers the OAuth 2.1 + PKCE
 * flow via window.fleetify.signIn() (Electron main owns the browser
 * + loopback + token exchange). On success, control passes to App.tsx
 * via onAuth(user, "", isNew). Under the CTA, a line links the Terms of
 * Service and the Privacy Policy (`LegalLink`).
 */
export function WelcomeScreen({ onAuth }: WelcomeScreenProps) {
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setShow(true), 60);
    return () => clearTimeout(t);
  }, []);

  const handleSignIn = async () => {
    if (loading) return;
    setError("");
    setLoading(true);
    try {
      const result = await window.fleetify?.signIn();
      if (!result?.ok) {
        throw new Error(result?.error ?? "Sign-in failed");
      }
      const u = result.user;
      const user: AuthUser = {
        id: u.sub ?? u.id ?? "",
        name: u.name ?? u.email?.split("@")[0] ?? "",
        email: u.email ?? "",
      };
      onAuth(user, "", false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="drag-region"
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        padding: "32px",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          width: "100%",
          maxWidth: 360,
          opacity: show ? 1 : 0,
          transform: show ? "translateY(0)" : "translateY(8px)",
          transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* Brand lockup — chevron + Geist Bold wordmark */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 32,
            color: "var(--m-text)",
          }}
        >
          <LogoMark size={28} color="currentColor" />
          <span
            style={{
              fontFamily: "'Geist Variable', 'Geist', system-ui, sans-serif",
              fontWeight: 700,
              fontSize: 24,
              letterSpacing: "-0.025em",
              lineHeight: 1,
            }}
          >
            Fleetify
          </span>
        </div>

        {/* Tagline */}
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: "var(--m-text)",
            letterSpacing: "-0.025em",
            lineHeight: 1.2,
            marginBottom: 14,
            maxWidth: 320,
          }}
        >
          Think it.{" "}
          <span style={{ display: "block" }}>Your fleet builds it.</span>
        </h1>

        {/* Description */}
        <p
          style={{
            fontSize: 13,
            color: "var(--m-text-2)",
            lineHeight: 1.55,
            marginBottom: 22,
            maxWidth: 320,
          }}
        >
          Run every agent side by side. See every move, track every dollar, stay in control.
        </p>

        {/* Provider strip — full-color glyphs, small + tight */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            marginBottom: 36,
          }}
        >
          {PROVIDERS.map((tool) => (
            <ProviderLogo key={tool} tool={tool} size={14} />
          ))}
        </div>

        {/* Single CTA — Sign in with Fleetify */}
        <button
          className="no-drag"
          onClick={handleSignIn}
          disabled={loading}
          style={{
            width: "100%",
            height: 44,
            borderRadius: 10,
            fontSize: 13.5,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: loading ? "rgba(255,255,255,0.06)" : "#fff",
            color: loading ? "var(--m-text-3)" : "#000",
            border: loading ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(255,255,255,0.9)",
            outline: "none",
            cursor: loading ? "not-allowed" : "pointer",
            boxShadow: loading
              ? "none"
              : "0 1px 0 rgba(255,255,255,0.4) inset, 0 1px 2px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.05)",
            transition: "transform 0.15s ease, box-shadow 0.15s ease",
          }}
          onMouseEnter={(e) => {
            if (loading) return;
            e.currentTarget.style.transform = "translateY(-1px)";
            e.currentTarget.style.boxShadow =
              "0 1px 0 rgba(255,255,255,0.5) inset, 0 4px 10px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.05)";
          }}
          onMouseLeave={(e) => {
            if (loading) return;
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow =
              "0 1px 0 rgba(255,255,255,0.4) inset, 0 1px 2px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.05)";
          }}
        >
          {loading ? (
            <>
              <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
              Opening browser…
            </>
          ) : (
            <>
              Sign in with Fleetify
              <ArrowRight size={13} strokeWidth={2.2} />
            </>
          )}
        </button>

        {/* Error — alert icon + red text, left-aligned, no banner box; below the CTA */}
        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 14,
              width: "100%",
            }}
            role="alert"
          >
            <AlertCircle size={13} style={{ color: "#ef4444", flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, color: "#ef4444", textAlign: "left" }}>{error}</span>
          </div>
        )}

        {/* Legal line — what signing in accepts */}
        <p
          style={{
            marginTop: 14,
            fontSize: 11.5,
            color: "var(--m-text-3)",
            lineHeight: 1.5,
          }}
        >
          By signing in, you agree to the <LegalLink href={TERMS_URL}>Terms of Service</LegalLink> and
          acknowledge the <LegalLink href={PRIVACY_URL}>Privacy Policy</LegalLink>.
        </p>
      </div>
    </div>
  );
}
