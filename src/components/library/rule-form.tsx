/**
 * RuleForm — the Library "Rules" create/edit modal. Distinct from the generic
 * CreateItemDialog because a rule has three on-disk *shapes* (tabs) plus a
 * Global/Folder scope:
 *   • General — markdown merged into CLAUDE.md / GEMINI.md / AGENTS.md (a
 *     provider multi-select).
 *   • Cursor CLI — a `.mdc` whose frontmatter follows the rule type
 *     (Always / Apply Intelligently / Apply to Specific Files / Manual).
 *   • GitHub Copilot CLI — `copilot-instructions.md`, or a
 *     `.github/instructions/<slug>.instructions.md` path file when `applyTo`
 *     globs are given.
 * Scope is shared across the tabs: Global writes to your home rule files;
 * Folder writes into a chosen project directory's rule files.
 */
import { useMemo, useState } from "react";
import { X, FolderOpen } from "lucide-react";
import { useLibraryStore } from "@/stores/library-store";
import {
  PROVIDERS_FOR_KIND,
  SLUG_RE,
  slugify,
  CURSOR_RULE_TYPES,
  type LibraryItem,
  type RuleFormat,
  type RuleScope,
  type CursorRuleType,
} from "@/lib/library-api";
import {
  Field,
  ProviderMultiSelect,
  inputStyle,
  btnPrimary,
  btnSecondary,
} from "./create-item-dialog";

const TABS: { id: RuleFormat; label: string }[] = [
  { id: "general", label: "General" },
  { id: "cursor", label: "Cursor CLI" },
  { id: "copilot", label: "GitHub Copilot CLI" },
];

export function RuleForm({
  editing,
  onClose,
}: {
  editing?: LibraryItem;
  onClose: () => void;
}) {
  const create = useLibraryStore((s) => s.create);
  const update = useLibraryStore((s) => s.update);

  const initSpec = editing?.rule_spec;
  const [tab, setTab] = useState<RuleFormat>(initSpec?.format ?? "general");
  const [scope, setScope] = useState<RuleScope>(initSpec?.scope ?? "global");
  const [folder, setFolder] = useState(initSpec?.folder ?? "");

  const [name, setName] = useState(editing?.name ?? "");
  const [slug, setSlug] = useState(editing?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(!!editing);
  const [body, setBody] = useState("");
  const [description, setDescription] = useState(editing?.description ?? "");

  const [providers, setProviders] = useState<string[]>(
    initSpec && initSpec.format !== "general" ? [] : (editing?.providers ?? []),
  );
  const [cursorRuleType, setCursorRuleType] = useState<CursorRuleType>(
    initSpec?.cursor_rule_type ?? "always",
  );
  const [globs, setGlobs] = useState(initSpec?.globs ?? "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const slugValid = SLUG_RE.test(effectiveSlug);

  const cursorMeta = CURSOR_RULE_TYPES.find((t) => t.value === cursorRuleType)!;
  const cursorNeedsDesc = tab === "cursor" && cursorMeta.needs === "description";
  const cursorNeedsGlobs = tab === "cursor" && cursorMeta.needs === "globs";

  const valid = useMemo(() => {
    if (!name.trim() || !slugValid) return false;
    if (!editing && !body.trim()) return false;
    if (scope === "folder" && !folder.trim()) return false;
    if (tab === "general" && providers.length === 0) return false;
    if (cursorNeedsDesc && !description.trim()) return false;
    if (cursorNeedsGlobs && !globs.trim()) return false;
    return true;
  }, [
    name, slugValid, editing, body, scope, folder, tab, providers,
    cursorNeedsDesc, description, cursorNeedsGlobs, globs,
  ]);

  const toggleProvider = (id: string) =>
    setProviders((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const chooseFolder = async () => {
    // Same path the session toolbar uses: the Tauri/Electron native folder
    // dialog, with a text-prompt fallback when it isn't available.
    const w = window as unknown as {
      electronAPI?: { openFolderDialog?: () => Promise<string | null> };
    };
    try {
      if (w.electronAPI?.openFolderDialog) {
        const p = await w.electronAPI.openFolderDialog();
        if (p) setFolder(p);
        return;
      }
    } catch {
      /* fall through to the prompt */
    }
    const p = window.prompt("Folder path", folder || undefined);
    if (p && p.trim()) setFolder(p.trim());
  };

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    const providersForTab =
      tab === "general" ? providers : tab === "cursor" ? ["cursor"] : ["github-copilot"];
    const sendGlobs =
      (tab === "cursor" && cursorNeedsGlobs) || tab === "copilot"
        ? globs.trim() || undefined
        : undefined;
    try {
      const payload = {
        kind: "rule" as const,
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || undefined,
        providers: providersForTab,
        body,
        rule_format: tab,
        scope,
        folder: scope === "folder" ? folder.trim() : undefined,
        cursor_rule_type: tab === "cursor" ? cursorRuleType : undefined,
        globs: sendGlobs,
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
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--c-high)" }}>
            {editing ? "Edit" : "New"} Rule
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)", display: "flex" }}>
            <X size={16} />
          </button>
        </div>

        {/* ── Scope bar — shared across tabs ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Segmented
            value={scope}
            onChange={(v) => setScope(v)}
            options={[
              { value: "global", label: "Global" },
              { value: "folder", label: "Folder" },
            ]}
          />
          {scope === "global" ? (
            <span style={{ fontSize: 11.5, color: "var(--c-dim)" }}>
              Writes to your home rule files (~/.claude/CLAUDE.md, …).
            </span>
          ) : (
            <button type="button" onClick={chooseFolder}
              title={folder || "Choose a folder"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                maxWidth: 320, padding: "5px 10px", fontSize: 12,
                background: "var(--sidebar)", color: folder ? "var(--c-high)" : "var(--c-dim)",
                border: "1px solid var(--c-brd)", borderRadius: 7, cursor: "pointer",
              }}>
              <FolderOpen size={13} style={{ flexShrink: 0, color: "var(--c-dim)" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: folder ? "var(--font-mono)" : undefined }}>
                {folder || "Choose folder…"}
              </span>
            </button>
          )}
        </div>

        {/* ── Tabs ── */}
        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--c-brd)" }}>
          {TABS.map((t) => {
            const on = t.id === tab;
            return (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                style={{
                  padding: "8px 12px", fontSize: 12.5, fontWeight: on ? 600 : 500,
                  background: "none", border: "none", cursor: "pointer",
                  color: on ? "var(--c-high)" : "var(--c-med)",
                  borderBottom: `2px solid ${on ? "var(--c-high)" : "transparent"}`,
                  marginBottom: -1,
                }}>
                {t.label}
              </button>
            );
          })}
        </div>

        <Field label="Name">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="My rule" style={inputStyle} />
        </Field>

        <Field label="Slug" hint="lowercase, digits, hyphens">
          <input value={effectiveSlug} disabled={!!editing}
            onChange={(e) => { setSlugEdited(true); setSlug(e.target.value); }}
            style={{ ...inputStyle, borderColor: effectiveSlug && !slugValid ? "var(--c-danger, #d44)" : "var(--c-brd)" }} />
          {effectiveSlug && !slugValid && (
            <div style={{ fontSize: 11, color: "var(--c-danger, #d44)", marginTop: 4 }}>
              Must match ^[a-z0-9][a-z0-9-]*$
            </div>
          )}
        </Field>

        {/* ── Tab-specific fields ── */}
        {tab === "general" && (
          <Field label="Providers" hint="CLAUDE.md / GEMINI.md / AGENTS.md">
            <ProviderMultiSelect allowed={PROVIDERS_FOR_KIND.rule} selected={providers} onToggle={toggleProvider} />
          </Field>
        )}

        {tab === "cursor" && (
          <>
            <Field label="Rule type" hint={cursorMeta.hint}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {CURSOR_RULE_TYPES.map((rt) => {
                  const on = rt.value === cursorRuleType;
                  return (
                    <button key={rt.value} type="button" onClick={() => setCursorRuleType(rt.value)}
                      style={{
                        padding: "5px 11px", fontSize: 12, fontWeight: on ? 600 : 500,
                        borderRadius: 7, cursor: "pointer",
                        background: on ? "var(--c-srf)" : "transparent",
                        color: on ? "var(--c-high)" : "var(--c-med)",
                        border: `1px solid ${on ? "var(--c-brd2)" : "var(--c-brd)"}`,
                      }}>
                      {rt.label}
                    </button>
                  );
                })}
              </div>
            </Field>
            {cursorNeedsDesc && (
              <Field label="Description" hint="required · how the agent decides to apply this">
                <input value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Backend RPC service conventions" style={inputStyle} />
              </Field>
            )}
            {cursorNeedsGlobs && (
              <Field label="Globs" hint="required · comma-separated file patterns">
                <input value={globs} onChange={(e) => setGlobs(e.target.value)}
                  placeholder="src/components/**/*.tsx" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
              </Field>
            )}
          </>
        )}

        {tab === "copilot" && (
          <Field label="Applies to (globs)" hint="optional · path-specific rule">
            <input value={globs} onChange={(e) => setGlobs(e.target.value)}
              placeholder="**/*.ts,**/*.tsx — blank = repo-wide copilot-instructions.md"
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
            {globs.trim() && scope !== "folder" && (
              <div style={{ fontSize: 11, color: "var(--c-dim)", marginTop: 4 }}>
                Path rules are repo-relative — pick Folder scope, or this falls back to the plain file.
              </div>
            )}
          </Field>
        )}

        <Field label="Body" hint={editing ? "leave blank to keep current" : "the rule text"}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7}
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }} />
        </Field>

        {error && (
          <div style={{ fontSize: 12, color: "var(--c-danger, #d44)", background: "var(--c-srf)", border: "1px solid var(--c-brd)", borderRadius: 7, padding: "8px 10px" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={submit} disabled={!valid || saving} style={btnPrimary(valid && !saving)}>
            {saving ? (editing ? "Saving…" : "Creating…") : editing ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "inline-flex", padding: 2, gap: 2, background: "var(--c-srf)", border: "1px solid var(--c-brd)", borderRadius: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" onClick={() => onChange(o.value)}
            style={{
              padding: "5px 14px", fontSize: 12, fontWeight: 600,
              border: "none", borderRadius: 6, cursor: "pointer",
              background: on ? "var(--card)" : "transparent",
              color: on ? "var(--c-high)" : "var(--c-med)",
              boxShadow: on ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
            }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 1000, padding: 24,
};

const card: React.CSSProperties = {
  width: 600, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto",
  background: "var(--card)", border: "1px solid var(--c-brd)", borderRadius: 12,
  padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14,
};
