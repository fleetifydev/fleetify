/**
 * AccountsManager — manage the multiple logins/keys a provider or CLI agent
 * can have. Shared by Settings → Agents (CLI: config-dir / HOME-isolated logins
 * via a PTY `… login` flow) and Settings → Models (HTTP: labeled keychain API
 * keys).
 *
 * The synthetic "System" account (the user's pre-existing login / legacy key)
 * is always listed first and can't be removed. Auto-detected config dirs
 * (`~/.claude-2`, …) appear read-only. Exactly one account is the provider's
 * default; new sessions use it unless they pick another.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2, Plus, TerminalSquare } from "lucide-react";
import { providers as providersApi, type AccountInfo } from "@/lib/providers-api";
import { LoginTerminalModal } from "./login-terminal-modal";

/** First letter for the monogram avatar (email → "G", label → first char). */
function initial(s: string): string {
  const t = s.trim();
  return t ? t[0]!.toUpperCase() : "?";
}

interface Props {
  providerId: string;
  kind: "cli" | "http";
  /** Display name for the sign-in dialog ("Claude Code"). */
  providerName?: string;
  /** Called after any change so the parent can refresh its own auth pill. */
  onChanged?: () => void;
}

export function AccountsManager({ providerId, kind, providerName, onChanged }: Props) {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [login, setLogin] = useState<{ ptyId: string; label: string } | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});

  // Only the first load shows "Loading…"; later reloads keep the rows on
  // screen so an open sign-in dialog (and the user's place) survives.
  const load = useCallback(async () => {
    const list = await providersApi.listAccounts(providerId);
    setAccounts(list);
    setLoading(false);
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  async function addAccount() {
    const label = newLabel.trim();
    if (!label) return;
    setBusy("__add__");
    const res = await providersApi.createAccount(providerId, label, kind);
    setBusy(null);
    setNewLabel("");
    if (res.ok && res.account) {
      // Open the sign-in first: the new row shows up on the next load, and
      // the parent hears about it when the dialog closes.
      if (kind === "cli") await startLogin(res.account.id, label);
      await (kind === "cli" ? load() : refresh());
    }
  }

  async function startLogin(accountId: string, label: string) {
    setLoginError(null);
    const res = await providersApi.openAccountLogin(providerId, accountId);
    if (res.ok) setLogin({ ptyId: res.pty_id, label });
    else setLoginError(res.error || "The sign-in couldn't start.");
  }

  async function makeDefault(acc: AccountInfo) {
    if (
      kind === "cli" &&
      !acc.authenticated &&
      !window.confirm(
        `"${acc.label}" isn't signed in. Make it the main account anyway? New sessions will ask you to sign in first.`,
      )
    ) {
      return;
    }
    const accountId = acc.id;
    setBusy(accountId);
    await providersApi.setDefaultAccount(providerId, accountId);
    setBusy(null);
    await refresh();
  }

  async function remove(acc: AccountInfo) {
    setBusy(acc.id);
    let res = await providersApi.deleteAccount(providerId, acc.id);
    if (!res.ok && res.error === "in_use") {
      const go = window.confirm(
        `${res.sessions ?? "Some"} session(s) still use "${acc.label}". Delete anyway and fall them back to System?`,
      );
      if (!go) {
        setBusy(null);
        return;
      }
      res = await providersApi.deleteAccount(providerId, acc.id, true);
    }
    if (res.ok && kind === "http") await providersApi.deleteAccountKey(providerId, acc.id);
    setBusy(null);
    await refresh();
  }

  async function saveKey(accountId: string) {
    const key = (keyDraft[accountId] ?? "").trim();
    if (!key) return;
    setBusy(accountId);
    await providersApi.setAccountKey(providerId, accountId, key);
    setBusy(null);
    setKeyDraft((d) => ({ ...d, [accountId]: "" }));
    await refresh();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <style>{accountsCss}</style>
      <div className="acct-head">Accounts</div>

      {loading ? (
        <div className="acct-loading">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {accounts.map((acc) => {
            const managed = !acc.system && !acc.id.startsWith("dir:");
            return (
              <div key={acc.id} className={`acct-row${acc.is_default ? " is-default" : ""}`}>
                <div className={`acct-avatar${acc.authenticated ? "" : " off"}`}>
                  {initial(acc.label)}
                  <span className={`acct-presence${acc.authenticated ? " on" : ""}`} />
                </div>

                <div className="acct-meta">
                  <div className="acct-name-row">
                    <span className="acct-name">{acc.label}</span>
                    {acc.is_default && <span className="acct-main">Main</span>}
                  </div>
                  {(acc.detail || !acc.authenticated) && (
                    <span className="acct-detail">
                      {acc.detail}
                      {!acc.authenticated && (acc.detail ? " · not signed in" : "Not signed in")}
                    </span>
                  )}
                </div>

                <div className="acct-actions">
                  {kind === "http" && managed && (
                    <>
                      <input
                        type="password"
                        className="acct-key"
                        placeholder={acc.authenticated ? "Replace key…" : "API key…"}
                        value={keyDraft[acc.id] ?? ""}
                        onChange={(e) => setKeyDraft((d) => ({ ...d, [acc.id]: e.target.value }))}
                      />
                      <button className="acct-btn" disabled={busy === acc.id} onClick={() => void saveKey(acc.id)}>
                        {busy === acc.id ? <Loader2 size={12} className="animate-spin" /> : "Save"}
                      </button>
                    </>
                  )}

                  {kind === "cli" && (
                    <button className="acct-btn" onClick={() => void startLogin(acc.id, acc.label)}>
                      <TerminalSquare size={13} />
                      {acc.authenticated ? "Re-login" : "Sign in"}
                    </button>
                  )}

                  {!acc.is_default && (
                    <button className="acct-btn" disabled={busy === acc.id} onClick={() => void makeDefault(acc)}>
                      Set main
                    </button>
                  )}

                  {managed && (
                    <button
                      className="acct-btn danger"
                      disabled={busy === acc.id}
                      onClick={() => void remove(acc)}
                      title="Remove account"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add a new account. */}
      <div className="acct-add">
        <input
          className="acct-add-input"
          placeholder={kind === "cli" ? "Add another login (e.g. Work)" : "Add another account (e.g. Personal)"}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addAccount();
          }}
        />
        <button className="acct-btn primary" disabled={busy === "__add__" || !newLabel.trim()} onClick={() => void addAccount()}>
          {busy === "__add__" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={13} />}
          Add
        </button>
      </div>

      {loginError && (
        <div className="acct-error" role="alert">
          {loginError}
        </div>
      )}

      {/* CLI login terminal. A login can also finish in the browser after the
          process is gone, so closing the dialog refreshes too. */}
      {login && (
        <LoginTerminalModal
          ptyId={login.ptyId}
          title={providerName ? `${providerName} · ${login.label}` : login.label}
          onExit={() => void refresh()}
          onClose={() => {
            setLogin(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

const accountsCss = `
.acct-head {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--c-dim); margin-top: 2px;
}
.acct-loading { display: flex; align-items: center; gap: 6px; color: var(--c-dim); font-size: 12px; }

.acct-row {
  display: flex; align-items: center; gap: 11px;
  padding: 8px 10px; border-radius: 10px;
  border: 1px solid transparent; transition: background .12s, border-color .12s;
}
.acct-row:hover { background: var(--c-srf); }
.acct-row.is-default { background: var(--c-srf); border-color: var(--c-brd); }

.acct-avatar {
  position: relative; flex-shrink: 0;
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; color: var(--c-med);
  background: var(--c-srf2); user-select: none;
}
.acct-avatar.off { opacity: 0.55; }
.acct-presence {
  position: absolute; right: -1px; bottom: -1px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--c-ghost); border: 2px solid var(--card, #0C0C0C);
}
.acct-presence.on { background: rgb(64,180,120); }

.acct-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.acct-name-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
.acct-name {
  font-size: 13px; font-weight: 500; color: var(--c-high);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.acct-main {
  font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 1.5px 6px; border-radius: 5px;
  background: rgba(64,180,120,0.14); color: rgb(64,180,120); flex-shrink: 0;
}
.acct-detail { font-size: 11px; color: var(--c-dim); white-space: nowrap; }

.acct-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }

.acct-btn {
  font-family: inherit; cursor: pointer; outline: none;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px; border-radius: 7px; font-size: 12px; font-weight: 500;
  background: transparent; color: var(--c-dim); border: 1px solid transparent;
  transition: background .12s, color .12s, border-color .12s;
}
.acct-btn:hover { background: var(--c-srf2); color: var(--c-high); }
.acct-btn:disabled { opacity: 0.5; cursor: default; }
.acct-btn.danger:hover { color: rgb(248,113,113); background: rgba(248,113,113,0.10); }
.acct-btn.primary {
  background: var(--c-srf2); color: var(--c-high); border-color: var(--c-brd);
}
.acct-btn.primary:hover { background: var(--c-brd2); }

.acct-key {
  font-family: inherit; font-size: 12px; padding: 5px 9px; width: 150px;
  border-radius: 7px; background: var(--card, #0C0C0C);
  border: 1px solid var(--c-brd); color: var(--c-high); outline: none;
}
.acct-key:focus { border-color: var(--c-brd2); }

.acct-add { display: flex; gap: 6px; margin-top: 2px; }
.acct-add-input {
  font-family: inherit; font-size: 12.5px; padding: 7px 11px; flex: 1;
  border-radius: 8px; background: var(--card, #0C0C0C);
  border: 1px solid var(--c-brd); color: var(--c-high); outline: none;
  transition: border-color .12s;
}
.acct-add-input:focus { border-color: var(--c-brd2); }
.acct-add-input::placeholder { color: var(--c-ghost); }

.acct-error { font-size: 11.5px; color: rgb(248,113,113); }
`;
