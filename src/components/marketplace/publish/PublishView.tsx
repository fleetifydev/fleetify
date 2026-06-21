/**
 * PublishView — "Create your own plugin" surface.
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ Identity      (name · version · description · author)  │
 *   │ Providers     (which CLIs the plugin targets)          │
 *   │ Components    (which artefacts to scaffold stubs for)  │
 *   │ MCP server    (conditional — command + args + envs)    │
 *   │ Secrets       (the env vars the plugin needs at runtime)│
 *   │ Tags / etc                                             │
 *   │                                                        │
 *   │  [Cancel]                       [Scaffold plugin →]    │
 *   └────────────────────────────────────────────────────────┘
 *
 * On submit:
 *   1. validateScaffoldInput → friendly error if anything's off.
 *   2. openFolderDialog → user picks where the plugin folder lands.
 *   3. generateScaffold → file map.
 *   4. electronAPI.scaffoldPlugin → writes the folder.
 *   5. Success view with the absolute path + next-steps instructions.
 */
import { useMemo, useState } from "react";
import { Plus, PackagePlus, X, FolderOpen, ExternalLink, Check, ArrowLeft } from "lucide-react";
import {
  generateScaffold,
  validateScaffoldInput,
  type ScaffoldInput,
} from "@/lib/plugin-scaffolder";

interface Props {
  onClose: () => void;
}

const PROVIDERS: { id: "claude-code" | "codex-cli"; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex-cli",  label: "Codex"  },
];

const COMPONENTS: { key: keyof ScaffoldInput["components"]; label: string; hint: string }[] = [
  { key: "mcp_server", label: "MCP server",      hint: "Connect to an external API or service via Model Context Protocol." },
  { key: "skill",      label: "Skill",           hint: "Markdown guidance the agent loads when invoking this skill." },
  { key: "template",   label: "Agent template",  hint: "Preset agent role with its own system prompt + tool surface." },
  { key: "hook",       label: "Hook",            hint: "Run a shell action on pre_send / post_response events." },
  { key: "workflow",   label: "Workflow",        hint: "Multi-step recipe the agent can execute end-to-end." },
];

type Result =
  | { kind: "idle" }
  | { kind: "scaffolding" }
  | { kind: "ok"; path: string; written: string[] }
  | { kind: "error"; message: string };

export function PublishView({ onClose }: Props) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const [description, setDescription] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorUrl, setAuthorUrl] = useState("");
  const [homepage, setHomepage] = useState("");
  const [license, setLicense] = useState("MIT");
  const [tagsRaw, setTagsRaw] = useState("");
  const [providers, setProviders] = useState<("claude-code" | "codex-cli")[]>(["claude-code", "codex-cli"]);
  const [components, setComponents] = useState({
    mcp_server: true,
    skill: false,
    template: false,
    hook: false,
    workflow: false,
  });
  const [mcpCommand, setMcpCommand] = useState("npx");
  const [mcpArgsRaw, setMcpArgsRaw] = useState("-y, @your-org/your-mcp-server");
  const [mcpEnvsRaw, setMcpEnvsRaw] = useState("");
  const [secrets, setSecrets] = useState<{ key: string; label: string; url: string }[]>([]);
  const [result, setResult] = useState<Result>({ kind: "idle" });

  const input: ScaffoldInput = useMemo(() => ({
    name: name.trim(),
    displayName: displayName.trim() || undefined,
    version: version.trim(),
    description: description.trim(),
    authorName: authorName.trim(),
    authorUrl: authorUrl.trim() || undefined,
    homepage: homepage.trim() || undefined,
    license: license.trim() || undefined,
    tags: tagsRaw.split(",").map(t => t.trim()).filter(Boolean),
    providers,
    components,
    mcp: components.mcp_server ? {
      command: mcpCommand.trim(),
      args: mcpArgsRaw.split(",").map(a => a.trim()).filter(Boolean),
      envVars: mcpEnvsRaw.split(",").map(e => e.trim()).filter(Boolean),
    } : undefined,
    secrets: secrets.filter(s => s.key.trim()).map(s => ({
      key: s.key.trim(),
      label: s.label.trim(),
      url: s.url.trim() || undefined,
    })),
  }), [name, displayName, version, description, authorName, authorUrl, homepage, license, tagsRaw, providers, components, mcpCommand, mcpArgsRaw, mcpEnvsRaw, secrets]);

  const validationError = useMemo(() => validateScaffoldInput(input), [input]);

  const onSubmit = async () => {
    const err = validateScaffoldInput(input);
    if (err) {
      setResult({ kind: "error", message: err });
      return;
    }
    if (!window.electronAPI?.openFolderDialog || !window.electronAPI?.scaffoldPlugin) {
      setResult({ kind: "error", message: "Scaffolder is only available in the desktop app." });
      return;
    }
    const parent = await window.electronAPI.openFolderDialog();
    if (!parent) return; // user cancelled — silent, not an error

    setResult({ kind: "scaffolding" });
    const { files } = generateScaffold(input);
    const res = await window.electronAPI.scaffoldPlugin({
      parentFolder: parent,
      pluginSlug: input.name,
      files,
    });
    if (res?.error || !res?.path) {
      setResult({ kind: "error", message: res?.error || "Scaffold failed for an unknown reason." });
      return;
    }
    setResult({ kind: "ok", path: res.path, written: res.written ?? [] });
  };

  if (result.kind === "ok") {
    return <SuccessView path={result.path} written={result.written} onClose={onClose} />;
  }

  const toggleProvider = (id: "claude-code" | "codex-cli") => {
    setProviders(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };
  const toggleComponent = (k: keyof typeof components) => {
    setComponents(prev => ({ ...prev, [k]: !prev[k] }));
  };

  return (
    <div>
      <BackBar onClick={onClose} />

      {/* Hero */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "16px 18px",
        background: "var(--sidebar)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 10,
        marginBottom: 18,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: "var(--c-srf)",
          color: "var(--c-med)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <PackagePlus size={16} strokeWidth={1.9} />
        </div>
        <div>
          <h2 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: "var(--c-high)" }}>
            Publish a plugin
          </h2>
          <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--c-dim)", lineHeight: 1.45 }}>
            Fleet scaffolds a working plugin folder you can push to GitHub.
            Add it back as a source to see it in Discover.
          </p>
        </div>
      </div>

      {/* Identity */}
      <Section title="Identity">
        <Grid>
          <Field label="Name" hint="kebab-case, lowercase">
            <Input
              value={name}
              onChange={e => setName(e.target.value.toLowerCase())}
              placeholder="my-plugin"
              autoFocus
            />
          </Field>
          <Field label="Version" hint="semver, e.g. 0.1.0">
            <Input
              value={version}
              onChange={e => setVersion(e.target.value)}
              placeholder="0.1.0"
            />
          </Field>
        </Grid>
        <Field label="Display name" hint={`optional · ${displayName.length}/80 · falls back to Name`}>
          <Input
            value={displayName}
            onChange={e => setDisplayName(e.target.value.slice(0, 80))}
            placeholder="My Plugin"
          />
        </Field>
        <Field label="Description" hint={`${description.length}/200`}>
          <Input
            value={description}
            onChange={e => setDescription(e.target.value.slice(0, 200))}
            placeholder="One line on what this plugin does."
          />
        </Field>
        <Grid>
          <Field label="Author name">
            <Input
              value={authorName}
              onChange={e => setAuthorName(e.target.value)}
              placeholder="Your name or org"
            />
          </Field>
          <Field label="Author URL" hint="optional">
            <Input
              value={authorUrl}
              onChange={e => setAuthorUrl(e.target.value)}
              placeholder="https://your.site"
              type="url"
            />
          </Field>
        </Grid>
        <Grid>
          <Field label="Homepage" hint="optional">
            <Input
              value={homepage}
              onChange={e => setHomepage(e.target.value)}
              placeholder="https://github.com/you/my-plugin"
              type="url"
            />
          </Field>
          <Field label="License" hint="SPDX identifier">
            <Input
              value={license}
              onChange={e => setLicense(e.target.value)}
              placeholder="MIT"
            />
          </Field>
        </Grid>
        <Field label="Tags" hint="comma-separated, lowercase">
          <Input
            value={tagsRaw}
            onChange={e => setTagsRaw(e.target.value)}
            placeholder="productivity, infrastructure"
          />
        </Field>
      </Section>

      {/* Providers */}
      <Section
        title="Supported providers"
        subtitle="Which CLIs can use this plugin. Pick at least one."
      >
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PROVIDERS.map(p => (
            <Chip
              key={p.id}
              active={providers.includes(p.id)}
              onClick={() => toggleProvider(p.id)}
              label={p.label}
            />
          ))}
        </div>
      </Section>

      {/* Components */}
      <Section
        title="Components"
        subtitle="What this plugin will contribute. Stubs for each picked component get generated; edit the files after scaffolding."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {COMPONENTS.map(c => (
            <Toggle
              key={c.key}
              checked={components[c.key]}
              onChange={() => toggleComponent(c.key)}
              label={c.label}
              hint={c.hint}
            />
          ))}
        </div>
      </Section>

      {/* MCP-specific */}
      {components.mcp_server && (
        <Section
          title="MCP server"
          subtitle="Generates mcp.json. The command + args here are what Fleet runs to start the server."
        >
          <Field label="Command" hint="e.g. npx, uvx, python">
            <Input
              value={mcpCommand}
              onChange={e => setMcpCommand(e.target.value)}
              placeholder="npx"
            />
          </Field>
          <Field label="Args" hint="comma-separated">
            <Input
              value={mcpArgsRaw}
              onChange={e => setMcpArgsRaw(e.target.value)}
              placeholder="-y, @your-org/your-mcp-server"
            />
          </Field>
          <Field label="Env vars to forward" hint="comma-separated, optional">
            <Input
              value={mcpEnvsRaw}
              onChange={e => setMcpEnvsRaw(e.target.value)}
              placeholder="GITHUB_TOKEN, ANOTHER_KEY"
            />
          </Field>
        </Section>
      )}

      {/* Secrets */}
      <Section
        title="Required secrets"
        subtitle="Env vars the plugin asks the user for at install time."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {secrets.map((s, i) => (
            <div key={i} style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr auto",
              gap: 8,
              alignItems: "center",
            }}>
              <Input
                value={s.key}
                onChange={e => setSecrets(updateSecret(secrets, i, { key: e.target.value.toUpperCase() }))}
                placeholder="GITHUB_TOKEN"
              />
              <Input
                value={s.label}
                onChange={e => setSecrets(updateSecret(secrets, i, { label: e.target.value }))}
                placeholder="GitHub Personal Access Token"
              />
              <Input
                value={s.url}
                onChange={e => setSecrets(updateSecret(secrets, i, { url: e.target.value }))}
                placeholder="https://github.com/settings/tokens"
                type="url"
              />
              <button
                onClick={() => setSecrets(secrets.filter((_, j) => j !== i))}
                title="Remove"
                style={iconBtn}
              ><X size={12} /></button>
            </div>
          ))}
          <button
            onClick={() => setSecrets([...secrets, { key: "", label: "", url: "" }])}
            style={addBtn}
          >
            <Plus size={11} /> Add secret
          </button>
        </div>
      </Section>

      {/* Footer */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 12,
        marginTop: 18, paddingTop: 16,
        borderTop: "1px solid var(--sidebar-border)",
      }}>
        <div style={{
          fontSize: 11, color: result.kind === "error" ? "#f87171" : "var(--c-dim)",
          minWidth: 0, flex: 1,
        }}>
          {result.kind === "error" ? result.message : (validationError ?? "Ready to scaffold.")}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button
            onClick={onSubmit}
            disabled={!!validationError || result.kind === "scaffolding"}
            style={{
              ...primaryBtn,
              opacity: (!!validationError || result.kind === "scaffolding") ? 0.5 : 1,
              cursor: validationError ? "not-allowed" : "pointer",
            }}
          >
            {result.kind === "scaffolding" ? "Scaffolding…" : (
              <>
                <FolderOpen size={11} /> Scaffold plugin
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SuccessView({ path, written, onClose }: { path: string; written: string[]; onClose: () => void }) {
  const openInFolder = () => {
    if (window.electronAPI?.showItemInFolder) {
      window.electronAPI.showItemInFolder(path);
    }
  };
  return (
    <div>
      <BackBar onClick={onClose} />
      <div style={{
        borderRadius: 12,
        border: "1px solid var(--sidebar-border)",
        background: "var(--sidebar)",
        padding: 22,
        display: "flex", flexDirection: "column", gap: 16,
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: "rgba(74,222,128,0.12)",
          color: "#4ade80",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Check size={16} strokeWidth={2.4} />
        </div>
        <div>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--c-high)" }}>
            Plugin scaffolded
          </h2>
          <div style={{
            margin: "2px 0 0", fontSize: 11.5, color: "var(--c-dim)",
            fontFamily: "var(--font-mono)",
          }}>{path}</div>
        </div>
      </div>

      <div>
        <SectionLabel>Files written</SectionLabel>
        <div style={{
          padding: "10px 12px",
          background: "var(--c-srf)",
          border: "1px solid var(--sidebar-border)",
          borderRadius: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          color: "var(--c-med)",
          maxHeight: 180, overflowY: "auto",
          lineHeight: 1.6,
        }}>
          {written.map(p => <div key={p}>{p}</div>)}
        </div>
      </div>

      <div>
        <SectionLabel>Next steps</SectionLabel>
        <ol style={{
          margin: 0, paddingLeft: 18,
          fontSize: 12.5, color: "var(--c-med)",
          lineHeight: 1.7,
        }}>
          <li>Edit the stub files to make the plugin do something real.</li>
          <li>
            <code style={mono}>cd</code> into the folder and push it to a GitHub repository:
            <pre style={pre}>git init
git add .
git commit -m "init plugin"
git remote add origin git@github.com:you/your-plugin.git
git push -u origin main</pre>
          </li>
          <li>In Fleet: <strong>Marketplace → Sources → Add source</strong>, paste the repo URL.</li>
          <li>
            Want it in Fleet Official? Open a PR against{" "}
            <a
              href="#"
              onClick={e => {
                e.preventDefault();
                window.electronAPI?.openExternal?.("https://github.com/fleetifydev/marketplace");
              }}
              style={{
                color: "var(--c-high)",
                display: "inline-flex", alignItems: "center", gap: 3,
                textDecoration: "none",
                borderBottom: "1px dotted var(--c-dim)",
              }}
            >
              fleetifydev/marketplace <ExternalLink size={10} />
            </a>.
          </li>
        </ol>
      </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={ghostBtn}>Done</button>
          <button onClick={openInFolder} style={primaryBtn}>
            <FolderOpen size={11} /> Open folder
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function BackBar({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 8px 5px 6px",
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "var(--c-med)",
        fontSize: 12.5, fontWeight: 500,
        cursor: "pointer",
        marginBottom: 14,
        transition: "background 0.08s, color 0.08s",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = "var(--c-srf)";
        (e.currentTarget as HTMLElement).style.color = "var(--c-high)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
        (e.currentTarget as HTMLElement).style.color = "var(--c-med)";
      }}
    >
      <ArrowLeft size={13} /> Back to Marketplace
    </button>
  );
}

type SecretRow = { key: string; label: string; url: string };

function updateSecret(list: SecretRow[], i: number, patch: Partial<SecretRow>): SecretRow[] {
  const next = list.slice();
  const current = next[i];
  if (!current) return list;
  next[i] = { ...current, ...patch };
  return next;
}

/* ── Primitives ──────────────────────────────────────────────────── */

function Section({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{
      padding: "16px 18px",
      borderRadius: 10,
      border: "1px solid var(--sidebar-border)",
      background: "var(--sidebar)",
      marginBottom: 12,
    }}>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{
          margin: 0, fontSize: 10.5, fontWeight: 600,
          color: "var(--c-ghost)",
          letterSpacing: "0.10em", textTransform: "uppercase",
        }}>{title}</h3>
        {subtitle && (
          <div style={{
            marginTop: 4, fontSize: 11.5, color: "var(--c-low)",
            lineHeight: 1.45,
          }}>{subtitle}</div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
    </section>
  );
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
        gap: 8,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 500, color: "var(--c-med)",
        }}>{label}</span>
        {hint && (
          <span style={{
            fontSize: 10.5, color: "var(--c-ghost)",
            fontFamily: "var(--font-mono)",
          }}>{hint}</span>
        )}
      </div>
      {children}
    </label>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      gap: 10,
    }}>{children}</div>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: "100%", padding: "7px 10px",
        background: "var(--c-srf)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 6,
        color: "var(--c-high)",
        fontSize: 12,
        fontFamily: props.type === "url" || props.placeholder?.startsWith("http") ? "var(--font-mono)" : "inherit",
        outline: "none",
        boxSizing: "border-box",
        transition: "border-color 0.10s",
        ...(props.style ?? {}),
      }}
      onFocus={e => (e.currentTarget.style.borderColor = "var(--c-brd)")}
      onBlur={e => (e.currentTarget.style.borderColor = "var(--sidebar-border)")}
    />
  );
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      type="button"
      style={{
        padding: "5px 12px",
        background: active ? "var(--c-srf2)" : "transparent",
        border: "1px solid",
        borderColor: active ? "var(--c-brd)" : "var(--sidebar-border)",
        borderRadius: 6,
        color: active ? "var(--c-high)" : "var(--c-med)",
        fontSize: 11.5, fontWeight: 500,
        cursor: "pointer",
        transition: "background 0.08s, color 0.08s, border-color 0.08s",
      }}
    >{label}</button>
  );
}

function Toggle({
  checked, onChange, label, hint,
}: { checked: boolean; onChange: () => void; label: string; hint?: string }) {
  return (
    <label style={{
      display: "flex", alignItems: "flex-start", gap: 10,
      padding: "9px 11px",
      background: checked ? "var(--c-srf)" : "transparent",
      border: "1px solid",
      borderColor: checked ? "var(--c-brd)" : "var(--sidebar-border)",
      borderRadius: 7,
      cursor: "pointer",
      transition: "background 0.08s, border-color 0.08s",
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        style={{
          marginTop: 1,
          accentColor: "var(--c-high)",
          flexShrink: 0,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: "var(--c-high)", fontWeight: 500, lineHeight: 1.3 }}>
          {label}
        </div>
        {hint && (
          <div style={{
            fontSize: 11, color: "var(--c-dim)", marginTop: 2,
            lineHeight: 1.45,
          }}>{hint}</div>
        )}
      </div>
    </label>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600,
      color: "var(--c-ghost)",
      textTransform: "uppercase",
      letterSpacing: "0.10em",
      marginBottom: 8,
    }}>{children}</div>
  );
}

const primaryBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "7px 16px",
  background: "var(--c-high)",
  color: "var(--card)",
  border: "none",
  borderRadius: 7,
  fontSize: 12, fontWeight: 600,
  cursor: "pointer",
  transition: "opacity 0.12s",
};

const ghostBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "7px 14px",
  background: "transparent",
  border: "1px solid var(--sidebar-border)",
  borderRadius: 7,
  color: "var(--c-med)",
  fontSize: 12, fontWeight: 500,
  cursor: "pointer",
};

const iconBtn: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 6,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "none",
  border: "1px solid var(--sidebar-border)",
  cursor: "pointer",
  color: "var(--c-dim)",
};

const addBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "6px 12px",
  background: "transparent",
  border: "1px dashed var(--sidebar-border)",
  borderRadius: 7,
  color: "var(--c-med)",
  fontSize: 12, fontWeight: 500,
  cursor: "pointer",
  alignSelf: "flex-start",
};

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
  padding: "1px 5px",
  background: "var(--c-srf)",
  borderRadius: 3,
  color: "var(--c-med)",
};

const pre: React.CSSProperties = {
  margin: "6px 0 0",
  padding: "8px 10px",
  background: "var(--c-srf)",
  border: "1px solid var(--sidebar-border)",
  borderRadius: 6,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--c-med)",
  whiteSpace: "pre-wrap",
  lineHeight: 1.55,
};
