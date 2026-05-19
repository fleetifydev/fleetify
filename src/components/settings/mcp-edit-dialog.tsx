import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { MCPConfig, MCPServerRow, MCPType } from "@/lib/mcp-api";

interface Props {
  open: boolean;
  initial?: MCPServerRow | null;
  onClose: () => void;
  onSubmit: (name: string, config: MCPConfig) => Promise<void>;
}

type KV = { k: string; v: string };

function kvFromRecord(r: Record<string, string> | undefined): KV[] {
  return Object.entries(r ?? {}).map(([k, v]) => ({ k, v }));
}

function kvToRecord(kvs: KV[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { k, v } of kvs) {
    const key = k.trim();
    if (key) out[key] = v;
  }
  return out;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,47}$/;

export function MCPEditDialog({ open, initial, onClose, onSubmit }: Props) {
  const editing = !!initial;

  const [name, setName] = useState("");
  const [type, setType] = useState<MCPType>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState<KV[]>([]);
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<KV[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setType(initial.config.type);
      if (initial.config.type === "stdio") {
        setCommand(initial.config.command);
        setArgs((initial.config.args ?? []).join("\n"));
        setEnv(kvFromRecord(initial.config.env));
      } else {
        setUrl(initial.config.url);
        setHeaders(kvFromRecord(initial.config.headers));
      }
    } else {
      setName(""); setType("stdio");
      setCommand(""); setArgs(""); setEnv([]);
      setUrl(""); setHeaders([]);
    }
    setError(null);
  }, [open, initial]);

  if (!open) return null;

  async function handleSave() {
    setError(null);
    if (!NAME_RE.test(name)) {
      setError("Name must be 2–48 chars, lowercase letters/digits/_/-");
      return;
    }
    let config: MCPConfig;
    if (type === "stdio") {
      if (!command.trim()) { setError("Command is required"); return; }
      config = {
        type: "stdio",
        command: command.trim(),
        args: args.split("\n").map(s => s.trim()).filter(Boolean),
        env: kvToRecord(env),
      };
    } else {
      if (!url.trim()) { setError("URL is required"); return; }
      config = { type, url: url.trim(), headers: kvToRecord(headers) };
    }
    setSubmitting(true);
    try {
      await onSubmit(name, config);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="mcp-edit-dialog"
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 520, maxHeight: "85vh", overflow: "auto",
          background: "var(--card)", borderRadius: 12,
          border: "1px solid var(--c-brd)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--c-high)" }}>
            {editing ? "Edit MCP server" : "Add MCP server"}
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)" }}
          >
            <X size={16} />
          </button>
        </div>

        <Field label="Name">
          <input
            data-testid="mcp-name"
            value={name}
            disabled={editing}
            onChange={e => setName(e.target.value)}
            placeholder="filesystem"
            style={inputStyle}
          />
        </Field>

        <Field label="Type">
          <div style={{ display: "flex", gap: 6 }}>
            {(["stdio", "http", "sse"] as MCPType[]).map(t => (
              <button
                key={t}
                data-testid={`mcp-type-${t}`}
                onClick={() => setType(t)}
                style={{
                  padding: "5px 12px", borderRadius: 7,
                  background: type === t ? "var(--c-high)" : "var(--c-srf)",
                  color: type === t ? "var(--card)" : "var(--c-med)",
                  border: "1px solid var(--c-brd)",
                  cursor: "pointer", fontSize: 12, fontWeight: 500,
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        {type === "stdio" ? (
          <>
            <Field label="Command">
              <input data-testid="mcp-command" value={command} onChange={e => setCommand(e.target.value)} placeholder="npx" style={inputStyle} />
            </Field>
            <Field label="Args (one per line)">
              <textarea
                data-testid="mcp-args"
                value={args}
                onChange={e => setArgs(e.target.value)}
                rows={3}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
              />
            </Field>
            <KVEditor label="Env" kvs={env} onChange={setEnv} testId="mcp-env" />
          </>
        ) : (
          <>
            <Field label="URL">
              <input
                data-testid="mcp-url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                style={inputStyle}
              />
            </Field>
            <KVEditor label="Headers" kvs={headers} onChange={setHeaders} testId="mcp-headers" />
          </>
        )}

        {error && (
          <div style={{
            margin: "10px 0", padding: "8px 10px", borderRadius: 7,
            background: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: 12,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={outlineBtn}>Cancel</button>
          <button
            data-testid="mcp-submit"
            disabled={submitting}
            onClick={handleSave}
            style={primaryBtn}
          >
            {submitting ? "Saving…" : editing ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 11.5, fontWeight: 500, color: "var(--c-med)",
        marginBottom: 5, letterSpacing: "0.02em",
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function KVEditor({ kvs, onChange, label, testId }: {
  kvs: KV[]; onChange: (kvs: KV[]) => void; label: string; testId: string;
}) {
  return (
    <Field label={label}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {kvs.map((kv, i) => (
          <div key={i} style={{ display: "flex", gap: 6 }}>
            <input
              data-testid={`${testId}-key-${i}`}
              value={kv.k}
              onChange={e => onChange(kvs.map((x, j) => j === i ? { ...x, k: e.target.value } : x))}
              placeholder="KEY"
              style={{ ...inputStyle, flex: 1 }}
            />
            <input
              data-testid={`${testId}-val-${i}`}
              value={kv.v}
              onChange={e => onChange(kvs.map((x, j) => j === i ? { ...x, v: e.target.value } : x))}
              placeholder="value"
              style={{ ...inputStyle, flex: 2 }}
            />
            <button
              onClick={() => onChange(kvs.filter((_, j) => j !== i))}
              style={{ ...outlineBtn, padding: "4px 10px" }}
            >×</button>
          </div>
        ))}
        <button
          data-testid={`${testId}-add`}
          onClick={() => onChange([...kvs, { k: "", v: "" }])}
          style={{ ...outlineBtn, alignSelf: "flex-start" }}
        >+ add</button>
      </div>
    </Field>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  background: "var(--c-srf)", border: "1px solid var(--c-brd)",
  borderRadius: 7, padding: "7px 10px",
  fontSize: 13, color: "var(--c-high)", fontFamily: "inherit", outline: "none",
};

const outlineBtn: React.CSSProperties = {
  background: "none", border: "1px solid var(--c-brd2)",
  color: "var(--c-med)", borderRadius: 7,
  fontSize: 12, padding: "5px 12px", cursor: "pointer",
};

const primaryBtn: React.CSSProperties = {
  background: "var(--c-high)", border: "none",
  color: "var(--card)", borderRadius: 7,
  fontSize: 12, padding: "5px 14px", cursor: "pointer", fontWeight: 600,
};
