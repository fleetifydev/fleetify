import { useCallback, useEffect, useRef, useState } from "react";
import { X, Image as ImageIcon, Loader2, Check, AlertCircle, Paperclip } from "lucide-react";
import { formatShortcut } from "@/lib/keyboard-shortcuts";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Attachment {
  id: string;
  name: string;
  mime: string;
  data_url: string;
}

type Category = "bug" | "feature" | "love" | "other";

const MAX_ATTACHMENTS = 6;
const MAX_BYTES_PER_FILE = 5 * 1024 * 1024;

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "love",    label: "Love it"  },
  { id: "bug",     label: "Bug"      },
  { id: "feature", label: "Feature"  },
  { id: "other",   label: "Other"    },
];

const PLACEHOLDERS: Record<Category, string> = {
  love:    "What's working well for you?",
  bug:     "What happened? What did you expect?",
  feature: "What would you like to see?",
  other:   "What's on your mind?",
};

export function FeedbackModal({ open, onClose }: Props) {
  const [comment, setComment]       = useState("");
  const [email, setEmail]           = useState<string>(() => readStoredEmail());
  const [category, setCategory]     = useState<Category>("other");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [status, setStatus]         = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef  = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setComment(""); setEmail(readStoredEmail());
      setCategory("other"); setAttachments([]);
      setStatus("idle"); setErrorMsg(null);
      setTimeout(() => textareaRef.current?.focus(), 60);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // preventDefault marks the key handled, so Escape-to-stop on the chat
    // underneath leaves it alone.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    const next: Attachment[] = [];
    for (const f of list) {
      if (!f.type.startsWith("image/") || f.size > MAX_BYTES_PER_FILE) continue;
      try {
        const data_url = await readAsDataUrl(f);
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: f.name, mime: f.type, data_url,
        });
      } catch { /* skip */ }
    }
    setAttachments(prev => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
  }, []);

  const removeAttachment = (id: string) =>
    setAttachments(prev => prev.filter(a => a.id !== id));

  const canSubmit = comment.trim().length > 0 && status !== "sending";

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setStatus("sending"); setErrorMsg(null);
    const result = await window.fleetify?.sendFeedback({
      comment: `[${category}] ${comment.trim()}`,
      email: email.trim() || null,
      attachments,
    });
    if (!result) {
      setStatus("error");
      setErrorMsg("Bridge unavailable — restart the app and try again.");
      return;
    }
    if (result.ok) {
      setStatus("sent");
      setTimeout(onClose, 1600);
    } else {
      setStatus("error");
      setErrorMsg(
        result.code === "NO_BEARER" || result.code === "UNAUTHORIZED"
          ? "You're signed out. Sign back in to send feedback."
          : result.error || "Send failed."
      );
    }
  };

  if (!open) return null;

  // Success state
  if (status === "sent") {
    return (
      <div
        role="dialog" aria-modal="true"
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.5)", backdropFilter: "blur(3px)",
        }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{
            width: 360, padding: "40px 32px",
            background: "var(--card)", border: "1px solid var(--c-brd)",
            borderRadius: 16, boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
            textAlign: "center",
            animation: "fade-in 0.18s ease both",
          }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: "50%",
            background: "rgba(34,197,94,0.12)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Check size={20} style={{ color: "#22c55e" }} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--c-high)", letterSpacing: "-0.02em" }}>
            Thanks for your feedback!
          </div>
          <div style={{ fontSize: 12.5, color: "var(--c-dim)", lineHeight: 1.55 }}>
            It helps us build something you'll love.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog" aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.5)", backdropFilter: "blur(3px)",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 460, maxWidth: "calc(100vw - 32px)",
          background: "var(--card)",
          border: "1px solid var(--c-brd)",
          borderRadius: 16,
          boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          animation: "fade-in 0.18s ease both",
        }}
      >
        {/* ── Header ── */}
        <div style={{
          display: "flex", alignItems: "flex-start",
          padding: "20px 20px 0",
        }}>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 15, fontWeight: 700,
              color: "var(--c-high)", letterSpacing: "-0.025em",
              fontFamily: "var(--font-sans)",
            }}>
              Share feedback
            </div>
            <div style={{
              fontSize: 12, color: "var(--c-dim)", marginTop: 2, lineHeight: 1.5,
            }}>
              Help us make Fleetify better.
            </div>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              width: 26, height: 26, borderRadius: 6, marginTop: -2,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              color: "var(--c-dim)", flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-med)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none";         e.currentTarget.style.color = "var(--c-dim)"; }}
          >
            <X size={13} />
          </button>
        </div>

        {/* ── Category chips ── */}
        <div style={{ display: "flex", gap: 6, padding: "16px 20px 0", flexWrap: "wrap" }}>
          {CATEGORIES.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              style={{
                display: "inline-flex", alignItems: "center",
                padding: "5px 12px", borderRadius: 99,
                fontSize: 12, fontWeight: 500,
                fontFamily: "var(--font-sans)",
                cursor: "pointer",
                transition: "all 0.12s",
                border: `1px solid ${category === c.id ? "var(--c-brd2)" : "var(--c-brd)"}`,
                background: category === c.id ? "var(--c-srf)" : "transparent",
                color: category === c.id ? "var(--c-high)" : "var(--c-dim)",
              }}
            >
              <span>{c.label}</span>
            </button>
          ))}
        </div>

        {/* ── Body ── */}
        <div style={{ padding: "14px 20px 0", display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder={PLACEHOLDERS[category]}
            rows={5}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { void handleSubmit(); }
            }}
            style={{
              width: "100%", boxSizing: "border-box",
              padding: "10px 12px",
              background: "var(--c-srf)",
              border: "1px solid var(--c-brd)",
              borderRadius: 9,
              fontSize: 13, color: "var(--c-high)",
              fontFamily: "inherit", outline: "none",
              resize: "vertical", minHeight: 110,
              lineHeight: 1.6,
              transition: "border-color 0.12s",
            }}
            onFocus={e  => { e.currentTarget.style.borderColor = "var(--c-brd2)"; }}
            onBlur={e   => { e.currentTarget.style.borderColor = "var(--c-brd)";  }}
          />

          {/* Email + attach row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email (optional)"
              autoComplete="email"
              style={{
                flex: 1, boxSizing: "border-box",
                padding: "7px 10px",
                background: "var(--c-srf)",
                border: "1px solid var(--c-brd)",
                borderRadius: 7,
                fontSize: 12.5, color: "var(--c-high)",
                fontFamily: "inherit", outline: "none",
                transition: "border-color 0.12s",
              }}
              onFocus={e => { e.currentTarget.style.borderColor = "var(--c-brd2)"; }}
              onBlur={e  => { e.currentTarget.style.borderColor = "var(--c-brd)";  }}
            />
            {/* Attach icon button */}
            <input
              ref={fileInputRef}
              type="file" accept="image/*" multiple
              style={{ display: "none" }}
              onChange={e => {
                if (e.target.files?.length) void addFiles(e.target.files);
                e.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_ATTACHMENTS}
              title="Attach image (PNG/JPEG, max 5 MB)"
              style={{
                width: 32, height: 32, borderRadius: 7, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: attachments.length > 0 ? "var(--c-srf)" : "transparent",
                border: "1px solid var(--c-brd)",
                color: attachments.length > 0 ? "var(--c-high)" : "var(--c-dim)",
                cursor: attachments.length >= MAX_ATTACHMENTS ? "default" : "pointer",
                opacity: attachments.length >= MAX_ATTACHMENTS ? 0.4 : 1,
                transition: "all 0.12s",
                position: "relative",
              }}
              onMouseEnter={e => { if (attachments.length < MAX_ATTACHMENTS) { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; } }}
              onMouseLeave={e => { if (attachments.length === 0) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-dim)"; } }}
            >
              <Paperclip size={13} />
              {attachments.length > 0 && (
                <span style={{
                  position: "absolute", top: -4, right: -4,
                  width: 14, height: 14, borderRadius: "50%",
                  background: "var(--c-high)", color: "var(--card)",
                  fontSize: 8.5, fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {attachments.length}
                </span>
              )}
            </button>
          </div>

          {/* Image thumbnails */}
          {attachments.length > 0 && (
            <div style={{
              display: "flex", gap: 6, flexWrap: "wrap",
            }}>
              {attachments.map(a => (
                <div key={a.id} style={{
                  position: "relative", width: 52, height: 52,
                  borderRadius: 6, overflow: "hidden",
                  border: "1px solid var(--c-brd)",
                }}>
                  <img src={a.data_url} alt={a.name}
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  <button
                    onClick={() => removeAttachment(a.id)}
                    style={{
                      position: "absolute", top: 2, right: 2,
                      width: 16, height: 16, borderRadius: "50%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      background: "rgba(0,0,0,0.65)", color: "#fff",
                      border: "none", cursor: "pointer",
                    }}
                  >
                    <X size={8} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {status === "error" && errorMsg && (
            <div style={{
              display: "flex", alignItems: "flex-start", gap: 8,
              padding: "8px 11px",
              background: "rgba(248,113,113,0.08)",
              border: "1px solid rgba(248,113,113,0.35)",
              borderRadius: 7, fontSize: 12, color: "#f87171", lineHeight: 1.45,
            }}>
              <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{
          display: "flex", alignItems: "center",
          padding: "14px 20px 18px",
          gap: 8,
        }}>
          <span style={{ fontSize: 11, color: "var(--c-ghost)", flex: 1, letterSpacing: "-0.01em" }}>
            {formatShortcut(["Mod", "Enter"])} to send
          </span>
          <button
            onClick={onClose}
            style={{
              padding: "6px 13px",
              fontSize: 12.5, fontWeight: 500,
              background: "transparent",
              border: "1px solid var(--c-brd)",
              borderRadius: 7,
              color: "var(--c-med)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
              letterSpacing: "-0.01em",
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--c-high)"; e.currentTarget.style.borderColor = "var(--c-brd2)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--c-med)"; e.currentTarget.style.borderColor = "var(--c-brd)"; }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "6px 14px",
              fontSize: 12.5, fontWeight: 600,
              background: canSubmit ? "var(--c-high)" : "var(--c-srf)",
              color: canSubmit ? "var(--card)" : "var(--c-ghost)",
              border: "1px solid transparent",
              borderRadius: 7,
              cursor: canSubmit ? "pointer" : "default",
              transition: "all 0.12s",
              fontFamily: "var(--font-sans)",
              letterSpacing: "-0.01em",
            }}
          >
            {status === "sending"
              ? <Loader2 size={12} className="spin" />
              : <ImageIcon size={12} style={{ display: "none" }} />
            }
            <span>Send Feedback</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ── */
function readStoredEmail(): string {
  try {
    const raw = localStorage.getItem("fleet:user");
    if (!raw) return "";
    const u = JSON.parse(raw) as { email?: string };
    return u?.email ?? "";
  } catch { return ""; }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
