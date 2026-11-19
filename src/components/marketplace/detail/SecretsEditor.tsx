import React, { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { getPluginSecrets, setPluginSecrets } from "@/lib/plugin-api";
import type { SecretRequirement, SecretStatus } from "@/types/plugin";
import { safeExternalUrl } from "@/lib/utils";
import { followLink } from "@/components/markdown-link";

/** Write-only secret editor for an installed plugin. Loads set-status
 *  (never values) and writes only changed keys. An empty field clears
 *  that secret. */
export function SecretsEditor({
  installId, requiresSecrets,
}: { installId: string; requiresSecrets: SecretRequirement[] }) {
  const [status, setStatus] = useState<SecretStatus[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getPluginSecrets(installId)
      .then(s => { if (alive) setStatus(s); })
      .catch(() => { /* fall back to declared list below */ });
    return () => { alive = false; };
  }, [installId]);

  const rows: SecretStatus[] = status.length
    ? status
    : requiresSecrets.map(r => ({ key: r.key, label: r.label, url: r.url, set: false }));

  if (rows.length === 0) {
    return <div style={empty}>This plugin has no configurable secrets.</div>;
  }

  const save = async () => {
    const changed = edited;
    if (Object.keys(changed).length === 0) { setFeedback("No changes"); setTimeout(() => setFeedback(null), 2000); return; }
    setSaving(true);
    try {
      const next = await setPluginSecrets(installId, changed);
      setStatus(next);
      setEdited({});
      setFeedback("Saved");
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
      setTimeout(() => setFeedback(null), 2000);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 12.5, color: "var(--c-low)", lineHeight: 1.6 }}>
        Edit this plugin's secrets. Values are write-only — a stored secret is
        marked below; leave a field blank to keep it, or clear a stored one to
        remove it.
      </div>
      {rows.map(row => {
        const safe = safeExternalUrl(row.url);
        return (
          <div key={row.key}>
            <label style={lbl}>
              <span>{row.label}</span>
              {row.set && <span style={savedPill}>saved</span>}
              {safe && (
                <a href={safe} rel="noreferrer" onClick={(e) => followLink(e, safe)} style={getLink}>
                  Get <ExternalLink size={9} />
                </a>
              )}
            </label>
            <input
              type="password"
              value={edited[row.key] ?? ""}
              onChange={e => setEdited({ ...edited, [row.key]: e.target.value })}
              placeholder={row.key}
              style={input}
            />
          </div>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={() => void save()} disabled={saving} style={saveBtn(saving)}>
          {saving ? "Saving…" : "Save"}
        </button>
        {feedback && <span style={{ fontSize: 11.5, color: "var(--c-low)" }}>{feedback}</span>}
      </div>
    </div>
  );
}

const empty: React.CSSProperties = {
  padding: "16px 18px", borderRadius: 10, border: "1px solid var(--sidebar-border)",
  background: "var(--sidebar)", fontSize: 12.5, color: "var(--c-low)", lineHeight: 1.55,
};
const lbl: React.CSSProperties = {
  fontSize: 12, color: "var(--c-med)", display: "flex", alignItems: "center",
  gap: 6, marginBottom: 5,
};
const savedPill: React.CSSProperties = {
  fontSize: 10, color: "rgb(72 199 142)", border: "1px solid rgba(72,199,142,0.4)",
  borderRadius: 4, padding: "0 5px",
};
const getLink: React.CSSProperties = {
  fontSize: 11, color: "var(--c-dim)", display: "inline-flex", alignItems: "center",
  gap: 3, textDecoration: "none",
};
const input: React.CSSProperties = {
  width: "100%", padding: "7px 11px", background: "var(--c-srf)",
  border: "1px solid var(--sidebar-border)", borderRadius: 6, color: "var(--c-high)",
  fontSize: 12, fontFamily: "var(--font-mono)", outline: "none", boxSizing: "border-box",
};
const saveBtn = (disabled: boolean): React.CSSProperties => ({
  height: 28, padding: "0 14px", borderRadius: 6,
  fontSize: 12, fontWeight: 600,
  background: disabled ? "transparent" : "var(--c-high)",
  border: `1px solid ${disabled ? "var(--c-brd)" : "var(--c-high)"}`,
  color: disabled ? "var(--c-dim)" : "var(--c-bg, #000)",
  cursor: disabled ? "default" : "pointer", fontFamily: "inherit",
});
