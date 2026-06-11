/**
 * Create-item dialog for the Library. One form, parameterized by `kind`:
 * name → auto-slug, description, a provider multi-select gated to the kind's
 * allowed set (hidden for the provider-agnostic `prompt`), and the authored
 * body (SKILL.md text for skills, command/prompt markdown otherwise). On
 * submit it POSTs via `useLibraryStore().create`, surfacing the backend's
 * 400 (invalid slug / no providers) and 409 (slug exists) inline.
 */
import { useMemo, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
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
  command: "Command",
  hook: "Hook",
  template: "Template",
};

const BODY_HINT: Record<LibraryKind, string> = {
  prompt: "The reusable prompt text. Available to every agent.",
  skill: "SKILL.md content. Frontmatter is optional — the name is set for you.",
  command: "The slash-command body (markdown).",
  hook: "",
  template: "The system prompt for this agent preset.",
};

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
    return true;
  }, [editing, name, slugValid, body, providerScoped, providers]);

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

        <Field label="Description" hint="optional">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={inputStyle}
          />
        </Field>

        {providerScoped && (
          <Field label="Providers" hint="where this materializes">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {allowedProviders.map((id) => {
                const on = providers.includes(id);
                return (
                  <button
                    key={id}
                    onClick={() => toggleProvider(id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 9px",
                      borderRadius: 7,
                      fontSize: 12,
                      cursor: "pointer",
                      border: "1px solid",
                      borderColor: on ? "var(--c-high)" : "var(--c-brd)",
                      background: on ? "var(--c-srf)" : "transparent",
                      color: on ? "var(--c-high)" : "var(--c-med)",
                    }}
                  >
                    <ProviderLogo tool={id} size={13} />
                    {providerName(id)}
                  </button>
                );
              })}
            </div>
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
