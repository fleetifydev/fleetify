import { useEffect, useState, useCallback } from "react";
import { Sparkles, PanelLeft, RefreshCw } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { isWindowsPlatform } from "@/lib/utils";
import { studioApi, type StudioToolStatus, type HfAccount } from "@/lib/studio-api";
import { ModelBrowser } from "./ModelBrowser";

/** Studio mode landing surface — live Higgsfield status + model browser. */
export function StudioHub() {
  const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed);
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  const isWindows = isWindowsPlatform();

  const [tools, setTools] = useState<StudioToolStatus[] | null>(null);
  const [account, setAccount] = useState<HfAccount | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const t = await studioApi.getTools();
      setTools(t);
      const hf = t.find(x => x.id === "higgsfield");
      if (hf?.authenticated) {
        try { setAccount(await studioApi.getAccount()); } catch { setAccount(null); }
      } else { setAccount(null); }
    } catch { setTools([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const hf = tools?.find(t => t.id === "higgsfield");

  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--card)" }}>
      <div className="drag-region" style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", padding: "0 16px", background: "var(--card)" }}>
        {!isWindows && sidebarCollapsed && (
          <div className="no-drag" style={{ display: "flex", alignItems: "center", paddingLeft: 84 }}>
            <button onClick={toggleSidebar} title="Show sidebar" style={{ width: 22, height: 22, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)" }}>
              <PanelLeft size={14} />
            </button>
          </div>
        )}
      </div>
      <div style={{ padding: "0 24px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: "var(--c-high)", margin: 0 }}>Studio</h1>
          <button onClick={() => void load()} title="Refresh" style={{ display: "flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", color: "var(--c-dim)" }}>
            <RefreshCw size={13} />
          </button>
        </div>
        <p style={{ fontSize: 13, color: "var(--c-med)", marginTop: 6, marginBottom: 20 }}>
          Generate images and video with creative tools.
        </p>

        <div style={{ maxWidth: 560, padding: "14px 16px", borderRadius: 8, border: "1px solid var(--c-brd)", background: "var(--c-srf)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Sparkles size={18} style={{ color: "var(--c-high)", flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--c-high)" }}>Higgsfield</div>
              <div style={{ fontSize: 11.5, color: "var(--c-dim)" }}>image · video</div>
            </div>
            {hf && account && (
              <div style={{ fontSize: 11.5, color: "var(--c-med)" }}>{account.credits} credits · {account.subscription_plan_type}</div>
            )}
          </div>
          {loading && <div style={{ fontSize: 12, color: "var(--c-dim)", marginTop: 10 }}>Checking…</div>}
          {!loading && hf && !hf.installed && (
            <div style={{ fontSize: 12, color: "var(--c-med)", marginTop: 10 }}>
              Not installed. Run <code style={{ color: "var(--c-high)" }}>{hf.install_hint}</code>
            </div>
          )}
          {!loading && hf && hf.installed && !hf.authenticated && (
            <div style={{ fontSize: 12, color: "var(--c-med)", marginTop: 10 }}>
              Installed but not connected. Run <code style={{ color: "var(--c-high)" }}>hf auth login</code> in your terminal, then Refresh.
            </div>
          )}
        </div>

        {!loading && hf?.authenticated && (
          <div style={{ marginTop: 20 }}><ModelBrowser /></div>
        )}
      </div>
    </div>
  );
}
