import { useEffect, useState } from "react";
import { ArrowRight, ArrowLeft, Loader2, AlertCircle } from "lucide-react";
import { LogoMark } from "@/components/brand/logo-mark";
import type { AuthUser } from "@/lib/api";

interface AuthScreenProps {
  onAuth: (user: AuthUser, token: string, isNew: boolean) => void;
  onBack?: () => void;
}

export function AuthScreen({ onAuth, onBack }: AuthScreenProps) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

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
    <div className="app-drag" style={{
      height: "100vh", width: "100vw",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "transparent", padding: "32px", position: "relative",
    }}>
      {onBack && (
        <button
          className="app-no-drag"
          onClick={onBack}
          aria-label="Back"
          style={{
            position: "absolute", top: 14, right: 14, width: 30, height: 30,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "transparent", border: "none", borderRadius: 7,
            color: "var(--m-text-2)", cursor: "pointer",
          }}
        >
          <ArrowLeft size={15} strokeWidth={2} />
        </button>
      )}

      <div className="app-no-drag" style={{
        width: "100%", maxWidth: 340,
        opacity: show ? 1 : 0,
        transform: show ? "translateY(0)" : "translateY(12px)",
        transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
      }}>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center",
          gap: 10, marginBottom: 28, color: "var(--m-text)" }}>
          <LogoMark size={26} color="currentColor" />
          <span style={{
            fontFamily: "'Geist Variable', 'Geist', system-ui, sans-serif",
            fontWeight: 700, fontSize: 22, letterSpacing: "-0.025em", lineHeight: 1,
          }}>Fleetify</span>
        </div>

        <h1 style={{
          fontSize: 22, fontWeight: 600, color: "var(--m-text)",
          letterSpacing: "-0.025em", textAlign: "center", marginBottom: 6,
        }}>
          Welcome to Fleetify
        </h1>
        <p style={{
          fontSize: 13, color: "var(--m-text-2)", textAlign: "center",
          lineHeight: 1.5, marginBottom: 28,
        }}>
          Sign in to continue. We'll open your browser to fleetify.dev — no password needed here.
        </p>

        {error && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 12px", borderRadius: 8, marginBottom: 14,
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.18)",
          }}>
            <AlertCircle size={13} style={{ color: "#ef4444", flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, color: "#ef4444" }}>{error}</span>
          </div>
        )}

        <button
          type="button"
          onClick={handleSignIn}
          disabled={loading}
          style={{
            width: "100%", height: 44, borderRadius: 10,
            fontSize: 13.5, fontWeight: 600,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            background: loading ? "rgba(255,255,255,0.06)" : "#fff",
            color: loading ? "var(--m-text-3)" : "#000",
            border: loading ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(255,255,255,0.9)",
            cursor: loading ? "not-allowed" : "pointer",
            transition: "transform 0.15s ease",
          }}
        >
          {loading ? (
            <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
              Opening browser…</>
          ) : (
            <>Sign in with Fleetify <ArrowRight size={13} strokeWidth={2.2} /></>
          )}
        </button>

        <p style={{
          textAlign: "center", marginTop: 20,
          fontSize: 12.5, color: "var(--m-text-3)",
        }}>
          New here?{" "}
          <button
            type="button"
            onClick={() => window.electronAPI?.openExternal("https://app.fleetify.dev/login")}
            style={{
              background: "none", border: "none",
              color: "var(--m-text)", cursor: "pointer",
              fontSize: 12.5, fontWeight: 600, padding: 0,
            }}
          >
            Create an account
          </button>
        </p>
      </div>
    </div>
  );
}
