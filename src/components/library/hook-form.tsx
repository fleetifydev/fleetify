/**
 * HookForm — the Library "Hooks" create/edit modal. Provider-specific: pick
 * provider(s) at top, then inputs shaped to the chosen providers. Three modes:
 *   • Command — trigger + matcher + command (+ optional handler file), merged
 *     into / written as each provider's native hook config. Multi-provider; the
 *     trigger list is the intersection of native events.
 *   • Plugin  — OpenCode only (exclusive): attach a .ts plugin, copied to
 *     ~/.config/opencode/plugin/<slug>.ts.
 *   • Gateway — Hermes only (exclusive): attach handler.py + pick events →
 *     ~/.hermes/hooks/<slug>/{HOOK.yaml,handler.py}.
 * Scope (Global/Folder) is shared like the Rules modal.
 */
import { useMemo, useRef, useState } from "react";
import { X, FolderOpen, Upload } from "lucide-react";
import { useLibraryStore } from "@/stores/library-store";
import {
  PROVIDERS_FOR_KIND,
  SLUG_RE,
  slugify,
  type LibraryItem,
  type HookMode,
  type HookScope,
} from "@/lib/library-api";
import {
  triggersFor,
  triggerDisplay,
  defaultCommandFor,
  HERMES_GATEWAY_EVENTS,
} from "@/lib/hook-triggers";
import {
  Field,
  ProviderMultiSelect,
  inputStyle,
  btnPrimary,
  btnSecondary,
} from "./create-item-dialog";

/** Resolve the mode implied by the selected providers. opencode/hermes-gateway
 *  are exclusive — selecting one forces Plugin/Gateway. */
function modeForProviders(providers: string[], hermesGateway: boolean): HookMode {
  if (providers.includes("opencode")) return "plugin";
  if (providers.includes("hermes-agent") && hermesGateway) return "gateway";
  return "command";
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function HookForm({ editing, onClose }: { editing?: LibraryItem; onClose: () => void }) {
  const create = useLibraryStore((s) => s.create);
  const update = useLibraryStore((s) => s.update);
  const init = editing?.hook_spec;

  const [providers, setProviders] = useState<string[]>(editing?.providers ?? []);
  const [hermesGateway, setHermesGateway] = useState(init?.mode === "gateway");
  const mode = modeForProviders(providers, hermesGateway);

  const [name, setName] = useState(editing?.name ?? "");
  const [slug, setSlug] = useState(editing?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(!!editing);
  const [description, setDescription] = useState(editing?.description ?? "");

  const [scope, setScope] = useState<HookScope>(init?.scope ?? "global");
  const [folder, setFolder] = useState(init?.folder ?? "");
  const [trigger, setTrigger] = useState(init?.trigger ?? "");
  const [matcher, setMatcher] = useState(init?.matcher ?? "");
  const [command, setCommand] = useState(init?.command ?? "");
  const [timeout, setTimeoutVal] = useState<string>(init?.timeout ? String(init.timeout) : "");
  const [events, setEvents] = useState<string[]>(init?.events ?? []);
  const [handler, setHandler] = useState<{ name: string; base64: string } | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const slugValid = SLUG_RE.test(effectiveSlug);
  const available = useMemo(() => triggersFor(providers), [providers]);
  const selectedTrigger = available.find((t) => t.id === trigger);
  // Filter the stored trigger to what the current provider set supports
  // (render-derived — changing providers needs no state-resetting effect, and
  // the user's pick is preserved if they re-widen the selection).
  const effectiveTrigger = selectedTrigger ? trigger : "";

  // Selecting opencode (plugin) or hermes-gateway makes that provider exclusive.
  const toggleProvider = (id: string) => {
    setProviders((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (id === "opencode") return ["opencode"];
      if (id === "hermes-agent" && hermesGateway) return ["hermes-agent"];
      // Adding a normal provider drops the exclusive opencode.
      return [...prev.filter((x) => x !== "opencode"), id];
    });
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const base64 = await fileToBase64(file);
    setHandler({ name: file.name, base64 });
    if (mode === "command" && !command.trim()) setCommand(defaultCommandFor(file.name));
    e.target.value = "";
  };

  const chooseFolder = async () => {
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
      /* fall through */
    }
    const p = window.prompt("Folder path", folder || undefined);
    if (p && p.trim()) setFolder(p.trim());
  };

  const toggleEvent = (e: string) =>
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));

  const valid = useMemo(() => {
    if (!name.trim() || !slugValid || providers.length === 0) return false;
    if (scope === "folder" && !folder.trim()) return false;
    if (mode === "command") {
      if (!effectiveTrigger) return false;
      if (!command.trim() && !handler) return false;
    }
    if (mode === "plugin" && !handler && !editing) return false;
    if (mode === "gateway" && ((!handler && !editing) || events.length === 0)) return false;
    return true;
  }, [name, slugValid, providers, scope, folder, mode, effectiveTrigger, command, handler, events, editing]);

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        kind: "hook" as const,
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || undefined,
        providers,
        body: "",
        hook_mode: mode,
        hook_trigger: mode === "command" ? effectiveTrigger : undefined,
        hook_events: mode === "gateway" ? events : undefined,
        hook_matcher:
          mode === "command" && selectedTrigger?.toolScoped ? matcher.trim() || undefined : undefined,
        command: mode === "command" ? command.trim() || undefined : undefined,
        timeout: timeout.trim() ? Number(timeout) : undefined,
        scope,
        folder: scope === "folder" ? folder.trim() : undefined,
        handler_file: handler ? { name: handler.name, content_base64: handler.base64 } : undefined,
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
            {editing ? "Edit" : "New"} Hook
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)", display: "flex" }}
          >
            <X size={16} />
          </button>
        </div>

        <Field label="Providers" hint="where this hook is installed">
          <ProviderMultiSelect allowed={PROVIDERS_FOR_KIND.hook} selected={providers} onToggle={toggleProvider} />
        </Field>

        {providers.includes("hermes-agent") && (
          <Field label="Hermes hook type">
            <Segmented
              value={hermesGateway ? "gateway" : "shell"}
              onChange={(v) => setHermesGateway(v === "gateway")}
              options={[
                { value: "gateway", label: "Gateway (handler.py)" },
                { value: "shell", label: "Shell — n/a v1", disabled: true },
              ]}
            />
          </Field>
        )}

        <Field label="Name">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="My hook" style={inputStyle} />
        </Field>
        <Field label="Slug" hint="lowercase, digits, hyphens">
          <input
            value={effectiveSlug}
            disabled={!!editing}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value);
            }}
            style={{ ...inputStyle, borderColor: effectiveSlug && !slugValid ? "var(--c-danger, #d44)" : "var(--c-brd)" }}
          />
        </Field>

        <Field label="Scope">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Segmented
              value={scope}
              onChange={(v) => setScope(v as HookScope)}
              options={[
                { value: "global", label: "Global" },
                { value: "folder", label: "Folder" },
              ]}
            />
            {scope === "folder" && (
              <button
                type="button"
                onClick={chooseFolder}
                title={folder || "Choose a folder"}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 320, padding: "5px 10px",
                  fontSize: 12, background: "var(--sidebar)", color: folder ? "var(--c-high)" : "var(--c-dim)",
                  border: "1px solid var(--c-brd)", borderRadius: 7, cursor: "pointer",
                }}
              >
                <FolderOpen size={13} style={{ flexShrink: 0, color: "var(--c-dim)" }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {folder || "Choose folder…"}
                </span>
              </button>
            )}
          </div>
        </Field>

        {mode === "command" && (
          <>
            <Field label="Trigger" hint={providers.length > 1 ? "events all selected providers share" : "native event"}>
              {available.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--c-dim)" }}>
                  These providers share no common trigger — pick a smaller set.
                </div>
              ) : (
                <select value={effectiveTrigger} onChange={(e) => setTrigger(e.target.value)} style={inputStyle}>
                  <option value="">Select a trigger…</option>
                  {available.map((t) => (
                    <option key={t.id} value={t.id}>
                      {triggerDisplay(t, providers)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {selectedTrigger?.toolScoped && (
              <Field label="Matcher" hint="optional · tool-name regex (e.g. Bash, Edit|Write)">
                <input
                  value={matcher}
                  onChange={(e) => setMatcher(e.target.value)}
                  placeholder="Bash"
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                />
              </Field>
            )}
            <Field label="Handler file" hint="optional · copied into the hooks dir; sets ${file}">
              <HandlerPicker handler={handler} onPick={() => fileRef.current?.click()} onClear={() => setHandler(null)} />
            </Field>
            <Field label="Command" hint="${file} = the copied handler's path">
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx prettier --write ${file}"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <Field label="Timeout" hint="optional · seconds">
              <input
                value={timeout}
                onChange={(e) => setTimeoutVal(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="30"
                style={inputStyle}
              />
            </Field>
          </>
        )}

        {mode === "plugin" && (
          <Field label="Plugin file" hint="required · the .ts plugin copied to ~/.config/opencode/plugin/">
            <HandlerPicker handler={handler} onPick={() => fileRef.current?.click()} onClear={() => setHandler(null)} />
          </Field>
        )}

        {mode === "gateway" && (
          <>
            <Field label="Events" hint="required · gateway events the handler subscribes to">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {HERMES_GATEWAY_EVENTS.map((e) => {
                  const on = events.includes(e);
                  return (
                    <button
                      key={e}
                      type="button"
                      onClick={() => toggleEvent(e)}
                      style={{
                        padding: "5px 11px", fontSize: 12, fontWeight: on ? 600 : 500, borderRadius: 7,
                        cursor: "pointer", background: on ? "var(--c-srf)" : "transparent",
                        color: on ? "var(--c-high)" : "var(--c-med)",
                        border: `1px solid ${on ? "var(--c-brd2)" : "var(--c-brd)"}`, fontFamily: "var(--font-mono)",
                      }}
                    >
                      {e}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Handler" hint="required · handler.py copied to ~/.hermes/hooks/<slug>/">
              <HandlerPicker handler={handler} onPick={() => fileRef.current?.click()} onClear={() => setHandler(null)} />
            </Field>
          </>
        )}

        <Field label="Description" hint="optional">
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
        </Field>

        <input ref={fileRef} type="file" onChange={onPickFile} style={{ display: "none" }} />

        {error && (
          <div
            style={{
              fontSize: 12, color: "var(--c-danger, #d44)", background: "var(--c-srf)",
              border: "1px solid var(--c-brd)", borderRadius: 7, padding: "8px 10px",
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
            {saving ? (editing ? "Saving…" : "Creating…") : editing ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function HandlerPicker({
  handler,
  onPick,
  onClear,
}: {
  handler: { name: string } | null;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        onClick={onPick}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", fontSize: 12,
          background: "var(--sidebar)", color: "var(--c-med)", border: "1px solid var(--c-brd)",
          borderRadius: 7, cursor: "pointer",
        }}
      >
        <Upload size={13} /> {handler ? "Replace file" : "Choose file…"}
      </button>
      {handler && (
        <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--c-high)" }}>
          {handler.name}
          <button
            type="button"
            onClick={onClear}
            aria-label="Remove"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)", marginLeft: 6 }}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "inline-flex", padding: 2, gap: 2, background: "var(--c-srf)", border: "1px solid var(--c-brd)", borderRadius: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={o.disabled}
            onClick={() => !o.disabled && onChange(o.value)}
            style={{
              padding: "5px 14px", fontSize: 12, fontWeight: 600, border: "none", borderRadius: 6,
              cursor: o.disabled ? "not-allowed" : "pointer", opacity: o.disabled ? 0.4 : 1,
              background: on ? "var(--card)" : "transparent", color: on ? "var(--c-high)" : "var(--c-med)",
              boxShadow: on ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
};
const card: React.CSSProperties = {
  width: 600, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto",
  background: "var(--card)", border: "1px solid var(--c-brd)", borderRadius: 12,
  padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14,
};
