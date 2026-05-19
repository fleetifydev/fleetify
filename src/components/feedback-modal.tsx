/**
 * Feedback modal — triggered from the sidebar's "Give Feedback" row.
 * Centred overlay (not a route) so the user keeps their workspace in
 * the background and the modal feels lightweight.
 *
 * Fields:
 *   • Comment textarea  — free-form, required.
 *   • Email input       — optional, seeded from the signed-in user's
 *                          stored email (``fleet:user`` in localStorage)
 *                          so they don't have to type it every time.
 *   • Attach Image      — multi-select file picker. Images render as
 *                          thumbnails with a per-thumb remove button.
 *                          We capture them as base64 ``data:`` URLs
 *                          and pipe through electron IPC; the dashboard
 *                          receives them inline in the POST body so
 *                          there's no separate upload-then-link dance.
 *
 * Send delegates to ``window.fleetify.sendFeedback`` which lives in
 * electron's main process — the access token is owned there and never
 * crosses into the renderer's JS context (mirrors github-link's
 * pattern).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Image as ImageIcon, Loader2, Check, AlertCircle } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Attachment {
  /** UI-only id so the remove button maps the right slot. */
  id: string;
  /** Original filename (informational; the dashboard receives this). */
  name: string;
  /** MIME type — gated to image/* at picker time. */
  mime: string;
  /** Inline base64 ``data:`` URL. Doubles as the <img src=…> for the
   *  preview thumbnail so we don't have to maintain a separate object
   *  URL lifecycle. */
  data_url: string;
}

const MAX_ATTACHMENTS = 6;
const MAX_BYTES_PER_FILE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_PREFIX = "image/";

export function FeedbackModal({ open, onClose }: Props) {
  const [comment, setComment] = useState("");
  const [email, setEmail] = useState<string>(() => readStoredEmail());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset form state every time the modal re-opens so the user
  // doesn't see yesterday's draft. ``status="sent"`` is intentionally
  // wiped too — the "thanks, sent!" success card is a transient
  // confirmation, not a persistent state.
  useEffect(() => {
    if (open) {
      setComment("");
      setEmail(readStoredEmail());
      setAttachments([]);
      setStatus("idle");
      setErrorMsg(null);
    }
  }, [open]);

  // Esc closes — matches Settings / Library / palette muscle memory.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    const next: Attachment[] = [];
    for (const f of list) {
      if (!f.type.startsWith(ALLOWED_PREFIX)) continue;     // images only
      if (f.size > MAX_BYTES_PER_FILE) continue;            // skip oversized
      try {
        const data_url = await readAsDataUrl(f);
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: f.name,
          mime: f.type,
          data_url,
        });
      } catch { /* unreadable — silently skip */ }
    }
    setAttachments(prev => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
  }, []);

  const removeAttachment = (id: string) =>
    setAttachments(prev => prev.filter(a => a.id !== id));

  const canSubmit = comment.trim().length > 0 && status !== "sending";

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setStatus("sending");
    setErrorMsg(null);
    const trimmedEmail = email.trim();
    const result = await window.fleetify?.sendFeedback({
      comment: comment.trim(),
      email: trimmedEmail || null,
      attachments,
    });
    if (!result) {
      setStatus("error");
      setErrorMsg("Bridge unavailable — restart the app and try again.");
      return;
    }
    if (result.ok) {
      setStatus("sent");
      // Auto-dismiss after the success card has been on screen long
      // enough to read. 1.4s matches the rest of the app's "thanks"
      // toasts (PR created, copy-to-clipboard, etc.).
      setTimeout(onClose, 1400);
    } else {
      setStatus("error");
      // NO_BEARER is the synthetic code the bridge raises when there's
      // no signed-in user (auth: "required" short-circuit). UNAUTHORIZED
      // is the server's response when a token *was* attached but the
      // backend rejected it (expired, revoked, signature mismatch).
      // Both land on the same user-facing fix — sign in again — so they
      // share one tailored copy instead of the generic envelope string.
      if (result.code === "NO_BEARER" || result.code === "UNAUTHORIZED") {
        setErrorMsg("You're signed out. Sign back in to send feedback.");
      } else {
        setErrorMsg(result.error || "Send failed.");
      }
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 480, maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
          background: "var(--card)",
          border: "1px solid var(--c-brd)",
          borderRadius: 12,
          boxShadow: "0 18px 48px rgba(0,0,0,0.40)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "14px 16px",
          borderBottom: "1px solid var(--c-brd)",
        }}>
          <span style={{
            fontSize: 14, fontWeight: 600, color: "var(--c-high)", flex: 1,
          }}>Give Feedback</span>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              width: 24, height: 24, borderRadius: 5,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              color: "var(--c-dim)",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-med)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none";       e.currentTarget.style.color = "var(--c-dim)"; }}
          >
            <X size={12} />
          </button>
        </div>

        {/* Body */}
        <div className="scroll-subtle" style={{
          flex: 1, overflowY: "auto",
          padding: "16px",
          display: "flex", flexDirection: "column", gap: 14,
        }}>
          <Field label="What's on your mind?">
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Tell us what's working, what isn't, or what you'd like to see next."
              rows={6}
              style={inputStyle({ minHeight: 110, fontFamily: "inherit", resize: "vertical" })}
            />
          </Field>

          <Field label="Email" hint="Optional — we'll only use it to follow up.">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              style={inputStyle({})}
            />
          </Field>

          <Field
            label="Attach Image"
            hint={`PNG or JPEG, up to ${Math.round(MAX_BYTES_PER_FILE / (1024 * 1024))} MB each (max ${MAX_ATTACHMENTS}).`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={e => {
                if (e.target.files && e.target.files.length > 0) {
                  void addFiles(e.target.files);
                }
                // Reset so re-picking the same file fires onChange again.
                e.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_ATTACHMENTS}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 12px",
                fontSize: 12.5, fontWeight: 500,
                background: "var(--c-srf)",
                border: "1px solid var(--c-brd)",
                borderRadius: 7,
                color: "var(--c-high)",
                cursor: attachments.length >= MAX_ATTACHMENTS ? "default" : "pointer",
                opacity: attachments.length >= MAX_ATTACHMENTS ? 0.45 : 1,
              }}
            >
              <ImageIcon size={12} />
              <span>Attach Image</span>
            </button>

            {attachments.length > 0 && (
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
                gap: 8,
                marginTop: 10,
              }}>
                {attachments.map(a => (
                  <ThumbCard key={a.id} att={a} onRemove={() => removeAttachment(a.id)} />
                ))}
              </div>
            )}
          </Field>

          {status === "error" && errorMsg && (
            <div style={{
              display: "flex", alignItems: "flex-start", gap: 8,
              padding: "9px 12px",
              background: "rgba(248,113,113,0.08)",
              border: "1px solid rgba(248,113,113,0.40)",
              borderRadius: 8, fontSize: 12, color: "#f87171",
              lineHeight: 1.45,
            }}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 8, padding: "12px 16px",
          borderTop: "1px solid var(--c-brd)",
          background: "var(--c-srf)",
        }}>
          <button
            onClick={onClose}
            style={{
              padding: "6px 12px",
              fontSize: 12.5, fontWeight: 500,
              background: "transparent",
              border: "1px solid var(--c-brd)",
              borderRadius: 7,
              color: "var(--c-high)",
              cursor: "pointer",
            }}
          >Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "6px 14px",
              fontSize: 12.5, fontWeight: 600,
              background: "var(--c-high)",
              color: "var(--card)",
              border: "none",
              borderRadius: 7,
              cursor: canSubmit ? "pointer" : "default",
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            {status === "sending" && <Loader2 size={12} className="spin" />}
            {status === "sent"    && <Check size={12} />}
            <span>{status === "sent" ? "Sent!" : "Send Feedback"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Field — label + optional hint + child input ─────────────── */
function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={{
        display: "block",
        fontSize: 11.5, fontWeight: 600,
        color: "var(--c-dim)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        marginBottom: 6,
      }}>{label}</label>
      {children}
      {hint && (
        <div style={{
          fontSize: 11, color: "var(--c-low)",
          marginTop: 4, lineHeight: 1.45,
        }}>{hint}</div>
      )}
    </div>
  );
}

/* ── ThumbCard — image preview with remove pill ──────────────── */
function ThumbCard({ att, onRemove }: { att: Attachment; onRemove: () => void }) {
  return (
    <div style={{
      position: "relative",
      aspectRatio: "1 / 1",
      borderRadius: 7,
      overflow: "hidden",
      border: "1px solid var(--c-brd)",
      background: "var(--c-srf)",
    }}>
      <img
        src={att.data_url}
        alt={att.name}
        style={{
          width: "100%", height: "100%",
          objectFit: "cover", display: "block",
        }}
      />
      <button
        onClick={onRemove}
        title={`Remove ${att.name}`}
        style={{
          position: "absolute", top: 4, right: 4,
          width: 18, height: 18, borderRadius: "50%",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.6)",
          color: "#fff",
          border: "none", cursor: "pointer",
        }}
      >
        <X size={10} />
      </button>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────── */
function inputStyle(extra: React.CSSProperties): React.CSSProperties {
  return {
    width: "100%", boxSizing: "border-box",
    padding: "7px 10px",
    background: "var(--c-srf)",
    border: "1px solid var(--c-brd)",
    borderRadius: 7,
    fontSize: 12.5, color: "var(--c-high)",
    fontFamily: "inherit", outline: "none",
    transition: "border-color 0.12s",
    ...extra,
  };
}

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
