/**
 * Create-item dialog for the Library. One form, parameterized by `kind`:
 * name → auto-slug, description, a provider multi-select gated to the kind's
 * allowed set (hidden for the provider-agnostic `prompt`), and the authored
 * body (SKILL.md text for skills, command/prompt markdown otherwise). On
 * submit it POSTs via `useLibraryStore().create`, surfacing the backend's
 * 400 (invalid slug / no providers) and 409 (slug exists) inline.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Upload, X } from "lucide-react";
import { useLibraryStore } from "@/stores/library-store";
import {
  PROVIDERS_FOR_KIND,
  SLUG_RE,
  slugify,
  type LibraryItem,
  type LibraryKind,
} from "@/lib/library-api";
import { ProviderLogo, providerName } from "@/components/ui/provider-logo";

const KIND_LABEL: Record<LibraryKind, string> = {
  prompt: "Prompt",
  skill: "Skill",
  hook: "Hook",
  template: "Template",
};

const BODY_HINT: Record<LibraryKind, string> = {
  prompt: "The reusable prompt text. Available to every agent.",
  skill: "SKILL.md content. Frontmatter is optional — name + description are set for you.",
  hook: "",
  template: "The system prompt for this agent preset.",
};

/** The Agent-Skills open standard caps `description` at 1024 chars; every
 *  provider (Codex/OpenCode/Copilot…) requires a non-empty one, so skills make
 *  the Description field mandatory. */
const SKILL_DESCRIPTION_MAX = 1024;

export function CreateItemDialog({
  kind,
  editing,
  onClose,
}: {
  kind: LibraryKind;
  editing?: LibraryItem;
  onClose: () => void;
}) {
  const create = useLibraryStore((s) => s.create);
  const update = useLibraryStore((s) => s.update);
  const allowedProviders = PROVIDERS_FOR_KIND[kind];
  const providerScoped = allowedProviders.length > 0;

  const [name, setName] = useState(editing?.name ?? "");
  const [slug, setSlug] = useState(editing?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(!!editing);
  const [description, setDescription] = useState(editing?.description ?? "");
  const [providers, setProviders] = useState<string[]>(editing?.providers ?? []);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // File-import: read a chosen file's text into the body, seeding the name from
  // the filename when empty. Single-file (SKILL.md / command.md / prompt.md /
  // hook json); multi-file skill folders are a follow-up.
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBody(await file.text());
    if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
    e.target.value = "";
  };

  // Slug tracks the name until the user hand-edits it.
  const effectiveSlug = slugEdited ? slug : slugify(name);
  const slugValid = SLUG_RE.test(effectiveSlug);

  const valid = useMemo(() => {
    if (name.trim().length === 0 || !slugValid) return false;
    if (!editing && body.trim().length === 0) return false;
    if (providerScoped && providers.length === 0) return false;
    // Skills must carry a non-empty, ≤1024-char description — it's injected
    // into the materialized SKILL.md and required by the open standard.
    if (kind === "skill") {
      const d = description.trim();
      if (d.length === 0 || d.length > SKILL_DESCRIPTION_MAX) return false;
    }
    return true;
  }, [editing, name, slugValid, body, providerScoped, providers, kind, description]);

  const toggleProvider = (id: string) =>
    setProviders((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        kind,
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || undefined,
        providers: providerScoped ? providers : [],
        body,
      };
      if (editing) await update(editing.id, payload);
      else await create(payload);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--card)",
          border: "1px solid var(--c-brd)",
          borderRadius: 12,
          padding: "20px 22px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--c-high)" }}>
            {editing ? "Edit" : "New"} {KIND_LABEL[kind]}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--c-dim)",
              display: "flex",
            }}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`My ${kind}`}
            style={inputStyle}
          />
        </Field>

        <Field label="Slug" hint="lowercase, digits, hyphens">
          <input
            value={effectiveSlug}
            disabled={!!editing}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value);
            }}
            style={{
              ...inputStyle,
              borderColor: effectiveSlug && !slugValid ? "var(--c-danger, #d44)" : "var(--c-brd)",
            }}
          />
          {effectiveSlug && !slugValid && (
            <div style={{ fontSize: 11, color: "var(--c-danger, #d44)", marginTop: 4 }}>
              Must match ^[a-z0-9][a-z0-9-]*$
            </div>
          )}
        </Field>

        <Field
          label="Description"
          hint={kind === "skill" ? `required · injected into SKILL.md (≤${SKILL_DESCRIPTION_MAX})` : "optional"}
        >
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={kind === "skill" ? SKILL_DESCRIPTION_MAX : undefined}
            placeholder={kind === "skill" ? "What this skill does and when to use it" : undefined}
            style={inputStyle}
          />
        </Field>

        {providerScoped && (
          <Field label="Providers" hint="where this materializes">
            <ProviderMultiSelect
              allowed={allowedProviders}
              selected={providers}
              onToggle={toggleProvider}
            />
          </Field>
        )}

        <Field label="Body" hint={editing ? "leave blank to keep current" : BODY_HINT[kind]}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "3px 9px", fontSize: 11.5, fontWeight: 600,
                background: "none", color: "var(--c-med)",
                border: "1px solid var(--c-brd)", borderRadius: 6, cursor: "pointer",
              }}
            >
              <Upload size={12} /> Import from file
            </button>
            <input ref={fileRef} type="file" onChange={onImportFile} style={{ display: "none" }} />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
          />
        </Field>

        {error && (
          <div
            style={{
              fontSize: 12,
              color: "var(--c-danger, #d44)",
              background: "var(--c-srf)",
              border: "1px solid var(--c-brd)",
              borderRadius: 7,
              padding: "8px 10px",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button onClick={onClose} style={btnSecondary}>
            Cancel
          </button>
          <button onClick={submit} disabled={!valid || saving} style={btnPrimary(valid && !saving)}>
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--c-med)" }}>
        {label}
        {hint && (
          <span style={{ fontWeight: 400, color: "var(--c-dim)", marginLeft: 6 }}>{hint}</span>
        )}
      </span>
      {children}
    </label>
  );
}

/**
 * Multi-select dropdown for the provider scope. Replaces the old inline
 * toggle-pill row: a single trigger that shows the picked providers (logo
 * + name chips) and opens a checkable list below. Selecting a row toggles
 * it WITHOUT closing the menu, so several providers can be picked in one
 * pass; an outside click (or Escape) closes it. Matches the modal's input
 * chrome so it reads as one more field.
 */
function ProviderMultiSelect({
  allowed,
  selected,
  onToggle,
}: {
  allowed: string[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click + Escape — same pattern as the app's other
  // popovers (branch picker, PR switcher).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          ...inputStyle,
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 36,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, flex: 1, minWidth: 0 }}>
          {selected.length === 0 ? (
            <span style={{ color: "var(--c-dim)", fontSize: 13 }}>Select providers…</span>
          ) : (
            selected.map((id) => (
              <span
                key={id}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  padding: "2px 7px", borderRadius: 6, fontSize: 12,
                  background: "var(--c-srf)", color: "var(--c-high)",
                  border: "1px solid var(--c-brd)",
                }}
              >
                <ProviderLogo tool={id} size={13} />
                {providerName(id)}
              </span>
            ))
          )}
        </div>
        <ChevronDown
          size={15}
          style={{
            color: "var(--c-dim)", flexShrink: 0,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.15s",
          }}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
            zIndex: 20,
            maxHeight: 240, overflowY: "auto",
            background: "var(--popover, var(--card))",
            border: "1px solid var(--c-brd)",
            borderRadius: 8,
            boxShadow: "0 10px 30px rgba(0,0,0,0.30)",
            padding: 4,
            display: "flex", flexDirection: "column", gap: 2,
          }}
        >
          {allowed.map((id) => {
            const on = selected.includes(id);
            return (
              <button
                key={id}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onToggle(id)}
                style={{
                  display: "flex", alignItems: "center", gap: 9,
                  width: "100%", padding: "7px 9px",
                  borderRadius: 6, border: "none", outline: "none",
                  background: on ? "var(--c-srf)" : "transparent",
                  color: on ? "var(--c-high)" : "var(--c-med)",
                  fontSize: 13, cursor: "pointer", textAlign: "left",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--c-srf)"; }}
                onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}
              >
                <ProviderLogo tool={id} size={15} />
                <span style={{ flex: 1 }}>{providerName(id)}</span>
                {on && <Check size={14} strokeWidth={2.5} style={{ color: "var(--c-high)", flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  fontSize: 13,
  borderRadius: 7,
  border: "1px solid var(--c-brd)",
  background: "var(--sidebar)",
  color: "var(--c-high)",
  outline: "none",
  boxSizing: "border-box",
};

const btnSecondary: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 12.5,
  fontWeight: 600,
  background: "none",
  color: "var(--c-med)",
  border: "1px solid var(--c-brd)",
  borderRadius: 7,
  cursor: "pointer",
};

function btnPrimary(enabled: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    fontSize: 12.5,
    fontWeight: 600,
    background: enabled ? "var(--c-high)" : "var(--c-srf)",
    color: enabled ? "var(--card)" : "var(--c-dim)",
    border: "none",
    borderRadius: 7,
    cursor: enabled ? "pointer" : "default",
  };
}
