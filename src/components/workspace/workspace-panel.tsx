import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } from "react";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import {
  ChevronRight, ChevronDown,
  Code2, Terminal as TerminalIcon, GitBranch, GitCompareArrows,
  Globe, ListTodo, NotebookText, Activity,
  RefreshCw, X, Search, FilePlus, FolderPlus, Trash2, Pencil,
  FileCode, FileText, FileJson, Check, Copy, FolderOpen,
  AlertTriangle, AlertCircle, CheckCircle2, Eye, CheckSquare, Layers, Folder,
  Plus, ArrowRight,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAppStore, type WorkspaceView } from "@/stores/app-store";
import { usePaneSessionId, useIsInPane } from "@/components/chat/pane-session-context";
import {
  fetchSessionMemory, createSessionMemory, deleteSessionMemory,
  fetchMessages,
  type SessionMemoryItem,
} from "@/lib/api";
import { XtermShell } from "@/components/workspace/xterm-shell";
import { useChatStore, selectSession, type ProcessEvent } from "@/stores/chat-store";
import { MessageContent, StreamingMessage } from "@/components/chat/message-content";
import { wsManager } from "@/services/ws-manager";
import { useThemeStore } from "@/stores/theme-store";
import { getTheme } from "@/lib/themes";
import { EXT_ICON_URL, FILE_ICON_URL } from "@/assets/file-icons";
import folderBaseUrl     from "@/assets/file-icons/folder-base.svg?url";
import folderBaseOpenUrl from "@/assets/file-icons/folder-base-open.svg?url";

/* ─── Design tokens ─── */
const C = {
  treeBg:        "var(--sidebar)",
  treeHover:     "var(--c-srf)",
  treeActive:    "var(--c-srf2)",
  treeActiveBdr: "var(--c-med)",
  treeFg:        "var(--card-foreground)",
  treeFgDim:     "var(--muted-foreground)",
  editorBg:      "var(--card)",
  tabBg:         "var(--sidebar)",
  border:        "var(--c-brd)",
  accent:        "var(--c-srf)",
  gitM: "#E2C08D", gitU: "#73C991", gitA: "#73C991", gitD: "#F14C4C",
};
const MONO = "'SF Mono','Menlo','Monaco','Consolas',monospace";
const SANS = "-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif";

/* ─── Types ─── */
interface FsEntry  { name: string; path: string; type: "file" | "folder" }
interface GitInfo  { branch?: string; staged?: string[]; modified?: string[]; untracked?: string[]; commits?: { hash: string; msg: string }[]; error?: string }
interface OpenTab  { id: string; name: string; path: string; type: "file" }
type GitStatus = "M" | "U" | "A" | "D" | null;

/* ─── API ─── */
async function apiDir(p: string): Promise<FsEntry[]> {
  try { const r = await fetch(`/api/fs/dir?path=${encodeURIComponent(p)}`); return r.ok ? r.json() : []; } catch { return []; }
}

/* Folders first, alphabetical within each kind. Mirrors VS Code's
   default explorer order — most users come in with that mental
   model. Extracted so the initial-fetch path and the background
   poll path can share the same canonical order. */
function sortEntries(list: FsEntry[]): FsEntry[] {
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/* Deep-equal-ish check for two entry arrays. Compares the shape
   that affects rendering: count, names, types, paths. Used by the
   background poll so unchanged trees don't trigger re-renders
   (which would flicker the chevrons / collapse open subfolders). */
function entriesEqual(a: FsEntry[] | null, b: FsEntry[]): boolean {
  if (a === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (!x || !y) return false;
    if (x.name !== y.name || x.type !== y.type || x.path !== y.path) return false;
  }
  return true;
}
async function apiFile(p: string): Promise<{ content?: string; error?: string }> {
  try { const r = await fetch(`/api/fs/file?path=${encodeURIComponent(p)}`); return r.ok ? r.json() : { error: "Failed" }; } catch { return { error: "Failed" }; }
}
async function apiGit(p: string): Promise<GitInfo> {
  try { const r = await fetch(`/api/fs/git?path=${encodeURIComponent(p)}`); return r.ok ? r.json() : {}; } catch { return {}; }
}
type DiffScope = "auto" | "working" | "branch";
type DiffResult = {
  diff?: string;
  untracked?: boolean;
  scope?: "working" | "branch" | "empty";
  baseBranch?: string | null;
  error?: string;
};
async function apiGitDiff(p: string, file?: string, scope: DiffScope = "auto"): Promise<DiffResult> {
  try {
    const params = new URLSearchParams({ path: p });
    if (file) params.set("file", file);
    if (scope !== "auto") params.set("scope", scope);
    const r = await fetch(`/api/fs/git/diff?${params.toString()}`);
    return r.ok ? r.json() : { error: "Failed" };
  } catch { return { error: "Failed" }; }
}
async function apiCreate(path: string, type: "file" | "folder"): Promise<boolean> {
  try { const r = await fetch("/api/fs/create", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ path, type }) }); return r.ok; } catch { return false; }
}
async function apiDelete(path: string): Promise<boolean> {
  try { const r = await fetch(`/api/fs/delete?path=${encodeURIComponent(path)}`, { method:"DELETE" }); return r.ok; } catch { return false; }
}
async function apiRename(path: string, name: string): Promise<{ ok: boolean; path?: string }> {
  try { const r = await fetch("/api/fs/rename", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ path, name }) }); return r.ok ? r.json() : { ok: false }; } catch { return { ok: false }; }
}

/* ─── Context Menu ─── */
interface CtxItem { label: string; icon?: React.ReactNode; danger?: boolean; onClick: () => void }
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: CtxItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("keydown", esc); };
  }, [onClose]);

  // Adjust position to stay in viewport
  const menuW = 180, menuH = items.length * 26 + 8;
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top  = Math.min(y, window.innerHeight - menuH - 8);

  return (
    <div ref={ref} style={{
      position:"fixed", left, top, zIndex:9999,
      background:"var(--popover)", border:"1px solid var(--c-brd)",
      borderRadius:8, padding:"4px 0", minWidth:menuW,
      boxShadow:"0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)",
    }}>
      {items.map((item, i) =>
        item.label === "---" ? (
          <div key={i} style={{ height:1, background:"var(--c-brd)", margin:"3px 0" }}/>
        ) : (
          <div key={i} onClick={() => { item.onClick(); onClose(); }} style={{
            display:"flex", alignItems:"center", gap:8,
            padding:"0 12px", height:26, cursor:"pointer",
            fontSize:12, fontFamily:SANS,
            color: item.danger ? "#f87171" : "var(--c-med)",
            transition:"background 0.08s",
          }}
            onMouseEnter={e => (e.currentTarget.style.background = item.danger ? "rgba(248,113,113,0.1)" : "var(--c-srf)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
          >
            {item.icon && <span style={{ opacity:0.6, display:"flex" }}>{item.icon}</span>}
            {item.label}
          </div>
        )
      )}
    </div>
  );
}

/* ─── Inline Name Input ─── */
function NameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.select(); }, []);
  return (
    <input
      ref={ref} value={val}
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => {
        if (e.key === "Enter") { e.stopPropagation(); if (val.trim()) onCommit(val.trim()); else onCancel(); }
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => { if (val.trim()) onCommit(val.trim()); else onCancel(); }}
      onClick={e => e.stopPropagation()}
      style={{
        flex:1, fontSize:12, fontFamily:SANS,
        background:"var(--c-srf2)", border:"1px solid var(--c-brd2)",
        borderRadius:3, padding:"1px 5px", color:"var(--foreground)", outline:"none",
        minWidth:0,
      }}
    />
  );
}

/* ─── Language display names (for status bar) ─── */
const EXT_LANG: Record<string, string> = {
  py:"Python", pyw:"Python", js:"JavaScript", jsx:"JSX", mjs:"JavaScript",
  ts:"TypeScript", tsx:"TSX", json:"JSON", jsonc:"JSON",
  md:"Markdown", mdx:"MDX", html:"HTML", htm:"HTML",
  css:"CSS", scss:"SCSS", sass:"Sass", rs:"Rust", go:"Go",
  sh:"Shell", bash:"Bash", zsh:"Zsh",
  yml:"YAML", yaml:"YAML", toml:"TOML", sql:"SQL",
  java:"Java", kt:"Kotlin", swift:"Swift", rb:"Ruby", php:"PHP",
  c:"C", cpp:"C++", cs:"C#",
};

/* ─── File Icons — Material Icon Theme (local bundle) ─── */

function FolderIcon({ open }: { open?: boolean }) {
  return (
    <img
      src={open ? folderBaseOpenUrl : folderBaseUrl}
      width={16} height={16}
      style={{ flexShrink:0 }}
      draggable={false}
    />
  );
}

// Generic fallback icon (used when no match found)
function FallbackFileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink:0 }}>
      <path d="M14 2H6C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6z" fill="#6b7280"/>
      <path d="M14 2v6h6" fill="none" stroke="#4b5563" strokeWidth="1"/>
    </svg>
  );
}

function FileIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  const ext   = lower.includes(".") ? lower.split(".").pop()! : "";
  const url   = FILE_ICON_URL[lower] ?? EXT_ICON_URL[ext];
  if (!url) return <FallbackFileIcon/>;
  return <img src={url} width={16} height={16} style={{ flexShrink:0 }} draggable={false}/>;
}

/* ─── Git status color ─── */
function gc(s: GitStatus) { return s==="M"?C.gitM:s==="U"||s==="A"?C.gitU:s==="D"?C.gitD:"var(--card-foreground)"; }

/* ─── Tree Item ─── */
interface TreeItemProps {
  entry: FsEntry; depth: number; selectedPath: string;
  onSelect: (e: FsEntry) => void; gitMap: Map<string, GitStatus>; query: string;
  onRefresh: () => void;
}
function TreeItem({ entry, depth, selectedPath, onSelect, gitMap, query, onRefresh }: TreeItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[]>([]);
  const [hovered, setHovered]   = useState(false);
  const [ctx, setCtx]           = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState<"file"|"folder"|null>(null);
  const isFolder = entry.type === "folder";
  const isActive = !isFolder && entry.path === selectedPath;
  const status   = gitMap.get(entry.name) ?? null;
  const dim      = ["node_modules","__pycache__",".git"].includes(entry.name);

  const matches = !query || entry.name.toLowerCase().includes(query.toLowerCase());

  const loadChildren = useCallback(async () => {
    const kids = await apiDir(entry.path);
    setChildren(kids);
  }, [entry.path]);

  const toggle = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isFolder) { onSelect(entry); return; }
    if (!expanded) await loadChildren();
    setExpanded(v => !v);
  }, [isFolder, expanded, entry, onSelect, loadChildren]);

  if (!matches && !isFolder) return null;

  const handleCtx = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY });
  };

  const doDelete = async () => {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    await apiDelete(entry.path);
    onRefresh();
  };

  const doRename = async (name: string) => {
    setRenaming(false);
    if (name === entry.name) return;
    await apiRename(entry.path, name);
    onRefresh();
  };

  const doCreate = async (name: string, type: "file"|"folder") => {
    setCreating(null);
    if (!name) return;
    const newPath = entry.path + "/" + name;
    await apiCreate(newPath, type);
    await loadChildren();
    if (!expanded) setExpanded(true);
    onRefresh();
  };

  const ctxItems: CtxItem[] = isFolder ? [
    { label:"New File",   icon:<FilePlus size={11}/>,   onClick: () => { setExpanded(true); loadChildren(); setCreating("file");   } },
    { label:"New Folder", icon:<FolderPlus size={11}/>, onClick: () => { setExpanded(true); loadChildren(); setCreating("folder"); } },
    { label:"---", onClick: () => {} },
    { label:"Rename",     icon:<Pencil size={11}/>,     onClick: () => setRenaming(true) },
    { label:"Delete",     icon:<Trash2 size={11}/>,     danger:true, onClick: doDelete },
  ] : [
    { label:"Rename",     icon:<Pencil size={11}/>,     onClick: () => setRenaming(true) },
    { label:"Delete",     icon:<Trash2 size={11}/>,     danger:true, onClick: doDelete },
    { label:"---", onClick: () => {} },
    { label:"Copy Path",  onClick: () => navigator.clipboard.writeText(entry.path) },
  ];

  return (
    <div>
      <div
        onClick={toggle}
        onContextMenu={handleCtx}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={entry.path}
        style={{
          display:"flex", alignItems:"center", height:22, paddingRight:4,
          cursor:"pointer", position:"relative", userSelect:"none",
          background: ctx || isActive ? C.treeActive : hovered ? C.treeHover : "transparent",
          borderLeft: `2px solid ${isActive ? C.treeActiveBdr : "transparent"}`,
          opacity: dim ? 0.28 : 1,
        }}
      >
        {Array.from({ length: depth }, (_, i) => (
          <span key={i} style={{ width:16, alignSelf:"stretch", flexShrink:0, position:"relative" }}>
            <span style={{ position:"absolute", left:7, top:0, bottom:0, width:1, background:"rgba(var(--fg-rgb),0.05)" }}/>
          </span>
        ))}
        <span style={{ width:16, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
          {isFolder && (expanded
            ? <ChevronDown size={9} color="var(--muted-foreground)" opacity={0.45}/>
            : <ChevronRight size={9} color="var(--muted-foreground)" opacity={0.45}/>
          )}
        </span>
        {isFolder ? <FolderIcon open={expanded}/> : <FileIcon name={entry.name}/>}

        {renaming ? (
          <div style={{ flex:1, marginLeft:5, marginRight:4 }}>
            <NameInput initial={entry.name} onCommit={doRename} onCancel={() => setRenaming(false)}/>
          </div>
        ) : (
          <span style={{
            marginLeft:5, flex:1, fontSize:12.5, fontFamily:SANS,
            fontWeight: isActive ? 500 : 400,
            color: isActive ? "var(--foreground)" : status ? gc(status) : "var(--card-foreground)",
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          }}>{entry.name}</span>
        )}

        {/* Hover actions */}
        {hovered && !renaming && (
          <div style={{ display:"flex", gap:1, flexShrink:0, marginRight:2 }} onClick={e => e.stopPropagation()}>
            {isFolder && <>
              <button onClick={e => { e.stopPropagation(); setExpanded(true); loadChildren(); setCreating("file"); }}
                title="New File" style={iconBtn}>
                <FilePlus size={10}/>
              </button>
              <button onClick={e => { e.stopPropagation(); setExpanded(true); loadChildren(); setCreating("folder"); }}
                title="New Folder" style={iconBtn}>
                <FolderPlus size={10}/>
              </button>
            </>}
            <button onClick={e => { e.stopPropagation(); setRenaming(true); }} title="Rename" style={iconBtn}>
              <Pencil size={10}/>
            </button>
            <button onClick={e => { e.stopPropagation(); doDelete(); }} title="Delete" style={{ ...iconBtn, color:"#f87171" }}>
              <Trash2 size={10}/>
            </button>
          </div>
        )}

        {!hovered && status && (
          <span style={{ fontSize:9.5, fontWeight:600, color:gc(status), marginRight:6, flexShrink:0, fontFamily:MONO, opacity:0.75 }}>{status}</span>
        )}
      </div>

      {/* Inline create input */}
      {isFolder && expanded && creating && (
        <div style={{
          display:"flex", alignItems:"center", gap:6,
          height:22, paddingLeft: (depth+1)*16 + 18,
          paddingRight:8,
        }}>
          {creating === "folder" ? <FolderIcon/> : <FileIcon name="file"/>}
          <NameInput
            initial=""
            onCommit={name => doCreate(name, creating)}
            onCancel={() => setCreating(null)}
          />
        </div>
      )}

      {isFolder && expanded && children.map(c => (
        <TreeItem key={c.path} entry={c} depth={depth+1} selectedPath={selectedPath}
          onSelect={onSelect} gitMap={gitMap} query={query} onRefresh={async () => { await loadChildren(); onRefresh(); }}/>
      ))}

      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onClose={() => setCtx(null)}/>
      )}
    </div>
  );
}
const iconBtn: React.CSSProperties = {
  width:18, height:18, display:"flex", alignItems:"center", justifyContent:"center",
  background:"none", border:"none", cursor:"pointer",
  color:"var(--muted-foreground)", borderRadius:3, padding:0, flexShrink:0,
};

/* ─── File Tree Sidebar ─── */
function FileTree({ root, selectedPath, onSelect }: {
  root: string; selectedPath: string; onSelect: (e: FsEntry) => void;
}) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [gitMap, setGitMap]   = useState<Map<string, GitStatus>>(new Map());
  const [query, setQuery]     = useState("");
  const [searching, setSearching] = useState(false);
  const [headerHov, setHeaderHov] = useState(false);
  const projectName = root.split("/").pop() ?? "PROJECT";
  const searchRef   = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!root) return;
    apiDir(root).then(setEntries);
    apiGit(root).then(info => {
      const m = new Map<string, GitStatus>();
      info.staged?.forEach(f => m.set(f.split("/").at(-1)!, "A"));
      info.modified?.forEach(f => m.set(f.split("/").at(-1)!, "M"));
      info.untracked?.forEach(f => m.set(f.split("/").at(-1)!, "U"));
      setGitMap(m);
    });
  }, [root]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  // Root-level new file/folder
  const [rootCreating, setRootCreating] = useState<"file"|"folder"|null>(null);
  const doRootCreate = async (name: string, type: "file"|"folder") => {
    setRootCreating(null);
    if (!name) return;
    await apiCreate(root + "/" + name, type);
    refresh();
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      {/* ── Header row ── */}
      <div
        onMouseEnter={() => setHeaderHov(true)}
        onMouseLeave={() => setHeaderHov(false)}
        style={{
          height:32, padding:"0 6px 0 10px", flexShrink:0,
          display:"flex", alignItems:"center", gap:2,
          borderBottom:`1px solid ${C.border}`,
        }}
      >
        <span style={{
          flex:1, fontSize:10, fontWeight:600,
          color:"var(--muted-foreground)", fontFamily:SANS,
          textTransform:"uppercase", letterSpacing:"0.1em", opacity:0.45,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        }}>{projectName}</span>

        {/* Action icons — always visible on hover */}
        <div style={{ display:"flex", gap:0, flexShrink:0, opacity: headerHov ? 1 : 0, transition:"opacity 0.12s" }}>
          <button onClick={() => { setRootCreating("file"); }} title="New File" style={iconBtn}>
            <FilePlus size={12}/>
          </button>
          <button onClick={() => { setRootCreating("folder"); }} title="New Folder" style={iconBtn}>
            <FolderPlus size={12}/>
          </button>
          <button onClick={() => setSearching(s => !s)} title="Search" style={{ ...iconBtn, opacity: searching ? 0.9 : undefined }}>
            <Search size={12}/>
          </button>
          <button onClick={refresh} title="Refresh" style={iconBtn}>
            <RefreshCw size={11}/>
          </button>
        </div>
      </div>

      {/* ── Search row ── */}
      {searching && (
        <div style={{ padding:"5px 8px", flexShrink:0, borderBottom:`1px solid ${C.border}` }}>
          <div style={{ position:"relative", display:"flex", alignItems:"center" }}>
            <Search size={10} color="var(--muted-foreground)" style={{ position:"absolute", left:7, opacity:0.4, pointerEvents:"none" } as React.CSSProperties}/>
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") { setSearching(false); setQuery(""); } }}
              placeholder="Filter files…"
              style={{
                width:"100%", paddingLeft:24, paddingRight:24, paddingTop:4, paddingBottom:4,
                background:"var(--c-srf)", border:"1px solid var(--c-brd)",
                borderRadius:5, fontSize:12, color:"var(--card-foreground)", fontFamily:SANS,
                outline:"none",
              }}
            />
            {query && (
              <button onClick={() => setQuery("")} style={{ position:"absolute", right:6, background:"none", border:"none", cursor:"pointer", color:"var(--muted-foreground)", display:"flex", padding:0, opacity:0.5 }}>
                <X size={10}/>
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Root-level create input ── */}
      {rootCreating && (
        <div style={{ display:"flex", alignItems:"center", gap:6, height:22, paddingLeft:18, paddingRight:8, background:C.treeHover }}>
          {rootCreating === "folder" ? <FolderIcon/> : <FileIcon name="new"/>}
          <NameInput initial="" onCommit={n => doRootCreate(n, rootCreating)} onCancel={() => setRootCreating(null)}/>
        </div>
      )}

      {/* ── Tree ── */}
      <div className="scroll-subtle" style={{ flex:1, overflowY:"auto", overflowX:"hidden", paddingTop:2, paddingBottom:8 }}>
        {entries.length === 0 && (
          <div style={{ padding:"10px 14px", fontSize:12, color:"var(--muted-foreground)", opacity:0.35, fontFamily:SANS }}>Loading…</div>
        )}
        {entries.map(e => (
          <TreeItem key={e.path} entry={e} depth={0} selectedPath={selectedPath}
            onSelect={onSelect} gitMap={gitMap} query={query} onRefresh={refresh}/>
        ))}
      </div>
    </div>
  );
}

/* ─── Save API ─── */
async function apiSave(path: string, content: string): Promise<boolean> {
  try {
    const r = await fetch("/api/fs/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    return r.ok;
  } catch { return false; }
}


/* ─── CodeMirror Editor ─── */
async function getLanguageExtension(ext: string) {
  const map: Record<string, () => Promise<unknown>> = {
    py:   () => import("@codemirror/lang-python").then(m => m.python()),
    pyw:  () => import("@codemirror/lang-python").then(m => m.python()),
    js:   () => import("@codemirror/lang-javascript").then(m => m.javascript()),
    mjs:  () => import("@codemirror/lang-javascript").then(m => m.javascript()),
    jsx:  () => import("@codemirror/lang-javascript").then(m => m.javascript({ jsx: true })),
    ts:   () => import("@codemirror/lang-javascript").then(m => m.javascript({ typescript: true })),
    tsx:  () => import("@codemirror/lang-javascript").then(m => m.javascript({ jsx: true, typescript: true })),
    json: () => import("@codemirror/lang-json").then(m => m.json()),
    jsonc:() => import("@codemirror/lang-json").then(m => m.json()),
    md:   () => import("@codemirror/lang-markdown").then(m => m.markdown()),
    mdx:  () => import("@codemirror/lang-markdown").then(m => m.markdown()),
    html: () => import("@codemirror/lang-html").then(m => m.html()),
    htm:  () => import("@codemirror/lang-html").then(m => m.html()),
    css:  () => import("@codemirror/lang-css").then(m => m.css()),
    scss: () => import("@codemirror/lang-css").then(m => m.css()),
    sass: () => import("@codemirror/lang-css").then(m => m.css()),
    rs:   () => import("@codemirror/lang-rust").then(m => m.rust()),
    cpp:  () => import("@codemirror/lang-cpp").then(m => m.cpp()),
    c:    () => import("@codemirror/lang-cpp").then(m => m.cpp()),
    h:    () => import("@codemirror/lang-cpp").then(m => m.cpp()),
    java: () => import("@codemirror/lang-java").then(m => m.java()),
    sql:  () => import("@codemirror/lang-sql").then(m => m.sql()),
    yml:  () => import("@codemirror/lang-yaml").then(m => m.yaml()),
    yaml: () => import("@codemirror/lang-yaml").then(m => m.yaml()),
  };
  const fn = map[ext];
  return fn ? fn() : null;
}

/* ── Per-Fleet-theme CodeMirror skin ──
   Uses oneDark highlight style (syntax colors) on all dark themes,
   but overrides the background/gutter/cursor to match the active Fleet theme.
*/
async function buildEditorExtensions(
  colorThemeId: string,
  isDark: boolean,
  ext: string,
  onUpdate: (update: ViewUpdate) => void,
) {
  const themeDef = getTheme(colorThemeId);
  const accent   = themeDef.preview.accent;
  const sidebarBg= themeDef.preview.sidebar;

  // All CM modules imported together in one Promise.all so Vite always
  // resolves to the SAME module instance. Mixing dynamic imports from
  // multiple call-sites causes "Unrecognized extension value" errors
  // because instanceof checks break when two copies of @codemirror/state
  // are loaded.
  const [
    { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
      drawSelection, dropCursor, rectangularSelection, crosshairCursor },
    { EditorState, Compartment },
    { defaultKeymap, history, historyKeymap, indentWithTab },
    { syntaxHighlighting, HighlightStyle, defaultHighlightStyle, bracketMatching, indentOnInput, foldGutter },
    ,
    { search, searchKeymap, SearchQuery, setSearchQuery, findNext, findPrevious, closeSearchPanel },
    { tags: t },
    langExt,
  ] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
    import("@codemirror/theme-one-dark"),
    import("@codemirror/search"),
    import("@lezer/highlight"),
    getLanguageExtension(ext),
  ]);

  // Vesper theme by Raunofreiberg — warm dark, orange accents, mint strings
  const V = {
    bg:      "#101010",
    fg:      "#FFFFF0",
    orange:  "#FFC799",
    mint:    "#99FFE4",
    comment: "#4B4B4B",
    muted:   "#8D8D8D",
  };
  const darkHighlightStyle = HighlightStyle.define([
    // Headings + markers → Vesper orange
    { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
      color: V.orange, fontWeight: "bold" },
    { tag: t.heading,               color: V.orange, fontWeight: "bold" },
    { tag: t.processingInstruction, color: V.orange },
    { tag: t.contentSeparator,      color: V.comment },
    { tag: t.meta,                  color: V.orange },
    // Strings, URLs, inline code → mint
    { tag: [t.string, t.special(t.string)], color: V.mint },
    { tag: t.monospace,             color: V.mint },
    { tag: t.url,                   color: V.mint, textDecoration: "underline" },
    { tag: t.link,                  color: V.orange, fontWeight: "bold" },
    // Keywords, types, numbers → orange
    { tag: [t.keyword, t.modifier], color: V.orange },
    { tag: [t.typeName, t.className, t.namespace], color: V.orange },
    { tag: [t.number, t.bool, t.null], color: V.orange },
    { tag: [t.atom, t.self],        color: V.orange },
    { tag: [t.angleBracket, t.tagName], color: V.orange },
    { tag: t.attributeName,         color: V.mint },
    // Identifiers, functions → foreground (ivory)
    { tag: [t.variableName, t.function(t.variableName)], color: V.fg },
    { tag: [t.propertyName, t.function(t.propertyName)], color: V.fg },
    // Operators, punctuation → muted gray
    { tag: [t.operator, t.punctuation, t.separator], color: V.muted },
    // Comments → dark gray italic
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: V.comment, fontStyle: "italic" },
    // Emphasis
    { tag: t.emphasis,   fontStyle: "italic", color: V.fg },
    { tag: t.strong,     fontWeight: "bold",  color: V.fg },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.invalid,    color: "#ff5c57", textDecoration: "underline dotted" },
  ]);

  const syntaxExt = isDark
    ? syntaxHighlighting(darkHighlightStyle, { fallback: true })
    : syntaxHighlighting(defaultHighlightStyle, { fallback: true });

  const readonlyComp = new Compartment();

  const editorBg = isDark ? V.bg : sidebarBg;
  const chromeTheme = EditorView.theme({
    "&":            { height: "100%", background: `${editorBg} !important` },
    ".cm-editor":   { background: `${editorBg} !important` },
    ".cm-scroller": {
      fontFamily: MONO, fontSize: "12px", lineHeight: "1.5",
      background: `${editorBg} !important`,
    },
    ".cm-content": {
      caretColor: isDark ? V.orange : accent, padding: "6px 0",
      // No background here — CodeMirror's .cm-selectionLayer renders
      // BEHIND .cm-content (z-index: -1), so painting an opaque bg on
      // .cm-content would hide the selection rectangle. The editor's
      // bg is already applied via &, .cm-editor, and .cm-scroller.
      ...(isDark ? { color: V.fg } : {}),
    },
    // Gutter — same bg as editor, no border, seamless
    ".cm-gutters": {
      background:  `${editorBg} !important`,
      borderRight: "none !important",
      color:       isDark ? "#3a3a3a" : "rgba(0,0,0,0.22)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "3em", paddingRight: "14px", textAlign: "right",
      fontSize: "11.5px",
    },
    ".cm-foldGutter": { width: "10px" },
    // Active line
    ".cm-activeLine":       { backgroundColor: isDark ? "rgba(255,199,153,0.04) !important" : "rgba(0,0,0,0.03) !important" },
    ".cm-activeLineGutter": {
      backgroundColor: isDark ? "rgba(255,199,153,0.04) !important" : "rgba(0,0,0,0.03) !important",
      color: isDark ? "#555" : "rgba(0,0,0,0.5)",
    },
    // Selection — CM6 paints two rules: idle and focused. Both need
    // an !important override or the library's default rule wins.
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection": {
      background: isDark ? "rgba(255,199,153,0.30) !important" : "rgba(0,0,0,0.18) !important",
    },
    ".cm-selectionBackground": {
      background: isDark ? "rgba(255,199,153,0.22) !important" : "rgba(0,0,0,0.12) !important",
    },
    // Cursor
    ".cm-cursor": { borderLeftColor: isDark ? V.orange : accent },
    // Bracket matching
    ".cm-matchingBracket": {
      backgroundColor: isDark ? "rgba(255,199,153,0.12)" : `${accent}30`,
      outline: isDark ? "1px solid rgba(255,199,153,0.35)" : `1px solid ${accent}60`,
    },
    // Search panel container
    ".cm-panels": {
      background: `${editorBg} !important`,
      borderTop: `1px solid ${isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.10)"}`,
      color: isDark ? "#c8c8c8" : "#333",
    },
    ".cm-panel": {
      background: `${editorBg} !important`,
      padding: "7px 10px",
      display: "flex",
      flexWrap: "wrap",
      gap: "5px",
      alignItems: "center",
    },
    ".cm-panel.cm-search": {
      padding: "7px 10px",
      gap: "5px",
      flexWrap: "wrap",
    },
    // Find / Replace inputs
    ".cm-textfield": {
      background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)",
      border: `1px solid ${isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.18)"}`,
      borderRadius: "4px",
      padding: "3px 8px",
      color: isDark ? V.fg : "#111",
      fontSize: "12px",
      fontFamily: MONO,
      outline: "none",
      height: "24px",
      boxSizing: "border-box",
      minWidth: "140px",
    },
    ".cm-textfield:focus": {
      borderColor: isDark ? V.orange : accent,
      boxShadow: isDark ? `0 0 0 2px rgba(255,199,153,0.15)` : `0 0 0 2px ${accent}22`,
    },
    // Buttons (next / previous / all / replace / replace all)
    ".cm-button": {
      background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
      border: `1px solid ${isDark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.16)"}`,
      borderRadius: "4px",
      padding: "0 10px",
      height: "24px",
      color: isDark ? "#888" : "#444",
      fontSize: "11.5px",
      fontFamily: SANS,
      cursor: "pointer",
      lineHeight: "24px",
      whiteSpace: "nowrap",
    },
    ".cm-button:hover": {
      background: isDark ? "rgba(255,199,153,0.10)" : "rgba(0,0,0,0.12)",
      color: isDark ? V.orange : "#111",
      borderColor: isDark ? "rgba(255,199,153,0.30)" : "rgba(0,0,0,0.20)",
    },
    ".cm-button:active": {
      background: `${accent}22`,
      borderColor: `${accent}55`,
      color: accent,
    },
    // Labels — match case / regexp / by word
    ".cm-panel label": {
      fontSize: "11px",
      color: isDark ? "#888" : "#666",
      display: "inline-flex",
      alignItems: "center",
      gap: "3px",
      cursor: "pointer",
      whiteSpace: "nowrap",
    },
    ".cm-panel label:hover": { color: isDark ? "#c0c0c0" : "#222" },
    // Close button
    "button[name=close]": {
      background: "transparent",
      border: "none",
      color: isDark ? "#666" : "#999",
      cursor: "pointer",
      fontSize: "14px",
      padding: "0 2px",
      lineHeight: "1",
      marginLeft: "auto",
    },
    "button[name=close]:hover": { color: "#e06c75" },
  }, { dark: isDark });

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    history(),
    indentOnInput(),
    bracketMatching(),
    foldGutter(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    readonlyComp.of(EditorState.readOnly.of(true)),
    chromeTheme,
    syntaxExt,
    search({
      createPanel: (v) => {
        const bg = isDark ? V.bg : sidebarBg;
        const fg = isDark ? V.fg : "#111";
        const dim = isDark ? "#4a4a4a" : "#aaa";
        const ora = isDark ? V.orange : accent;

        const s = (el: HTMLElement, props: Record<string, string>) =>
          Object.assign(el.style, props);

        const wrap = document.createElement("div");
        s(wrap, {
          display: "flex", alignItems: "center", gap: "5px",
          padding: "5px 10px", background: bg,
          borderBottom: `1px solid ${isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.08)"}`,
          boxSizing: "border-box",
        });

        const inp = document.createElement("input");
        inp.placeholder = "Find in file...";
        s(inp, {
          flex: "1", minWidth: "0",
          background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
          border: `1px solid ${isDark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.14)"}`,
          borderRadius: "4px", padding: "2px 8px",
          color: fg, fontSize: "12px", fontFamily: MONO,
          outline: "none", height: "24px", boxSizing: "border-box",
        });
        inp.addEventListener("focus", () => {
          inp.style.borderColor = ora;
          inp.style.boxShadow = `0 0 0 2px ${isDark ? "rgba(255,199,153,0.15)" : `${accent}22`}`;
        });
        inp.addEventListener("blur", () => {
          inp.style.borderColor = isDark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.14)";
          inp.style.boxShadow = "none";
        });
        inp.addEventListener("input", () =>
          v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: inp.value })) })
        );
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) { findPrevious(v); } else { findNext(v); } }
          else if (e.key === "Escape") closeSearchPanel(v);
        });

        const mkBtn = (icon: string, title: string, action: () => void) => {
          const b = document.createElement("button");
          b.textContent = icon; b.title = title;
          s(b, {
            flexShrink: "0", width: "22px", height: "22px",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "transparent", border: "none",
            borderRadius: "3px", color: dim,
            fontSize: "13px", cursor: "pointer", padding: "0", lineHeight: "1",
          });
          b.addEventListener("mouseenter", () => { b.style.background = isDark ? "rgba(255,199,153,0.10)" : "rgba(0,0,0,0.08)"; b.style.color = isDark ? ora : "#333"; });
          b.addEventListener("mouseleave", () => { b.style.background = "transparent"; b.style.color = dim; });
          b.addEventListener("click", action);
          return b;
        };

        wrap.append(
          inp,
          mkBtn("↑", "Previous match (Shift+Enter)", () => findPrevious(v)),
          mkBtn("↓", "Next match (Enter)", () => findNext(v)),
          mkBtn("×", "Close (Esc)", () => closeSearchPanel(v)),
        );
        return { dom: wrap, top: true, mount: () => inp.focus() };
      },
    }),
    keymap.of(searchKeymap),
    EditorView.updateListener.of(onUpdate),
    ...(langExt ? [langExt as Extension] : []),
  ];

  return { extensions, EditorView, EditorState, readonlyComp };
}

function CodeEditor({ path, root, onLineChange }: {
  path: string; root: string;
  onLineChange?: (info: { line: number; total: number }) => void;
}) {
  const editorRef   = useRef<HTMLDivElement>(null);
  const viewRef     = useRef<EditorView | null>(null);
  const [saved, setSaved]     = useState(true);
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(true);
  const colorTheme  = useThemeStore(s => s.colorTheme);
  const isDark      = useThemeStore(s => s.theme) === "dark";
  const themeDef    = getTheme(colorTheme);
  const filename    = path.split("/").pop() ?? "";
  const ext         = filename.split(".").pop()?.toLowerCase() ?? "";
  const relPath     = path.startsWith(root+"/") ? path.slice(root.length+1) : path;
  const segments    = relPath.split("/");

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const content = view.state.doc.toString();
    const ok = await apiSave(path, content);
    if (ok) setSaved(true);
  }, [path]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  // Rebuild editor whenever path OR active theme changes
  useEffect(() => {
    let destroyed = false;
    setLoading(true); setError(""); setSaved(true);
    try { viewRef.current?.destroy(); } catch { /* CodeMirror already torn down */ }
    viewRef.current = null;
    if (editorRef.current) editorRef.current.innerHTML = "";

    (async () => {
      try {
        const onUpdate = (u: ViewUpdate) => {
          if (u.docChanged) {
            setSaved(false);
            const line = u.state.doc.lineAt(u.state.selection.main.head).number;
            onLineChange?.({ line, total: u.state.doc.lines });
          } else if (u.selectionSet) {
            const line = u.state.doc.lineAt(u.state.selection.main.head).number;
            onLineChange?.({ line, total: u.state.doc.lines });
          }
        };
        const [r, { extensions, EditorView, EditorState }] = await Promise.all([
          apiFile(path),
          buildEditorExtensions(colorTheme, isDark, ext, onUpdate),
        ]);
        if (destroyed || !editorRef.current) return;
        if (r.error) { setError(r.error); setLoading(false); return; }

        onLineChange?.({ line: 1, total: (r.content ?? "").split("\n").length });
        const state = EditorState.create({ doc: r.content ?? "", extensions });
        const view  = new EditorView({ state, parent: editorRef.current! });
        viewRef.current = view;
        setLoading(false);
      } catch (e) {
        if (!destroyed) { setError(String(e)); setLoading(false); }
      }
    })();

    return () => { destroyed = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, colorTheme]);

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0 }}>
      {/* Breadcrumb + save status */}
      <div style={{
        height:28, padding:"0 14px", flexShrink:0,
        display:"flex", alignItems:"center", gap:4,
        background: themeDef.preview.sidebar,
        borderBottom: `1px solid ${themeDef.preview.border}`,
      }}>
        <div style={{ flex:1, display:"flex", alignItems:"center", gap:4, overflow:"hidden" }}>
          {segments.map((seg, i) => (
            <span key={i} style={{ display:"flex", alignItems:"center", gap:4, minWidth:0 }}>
              {i > 0 && <span style={{ fontSize:10, color:themeDef.preview.text, opacity:0.25, flexShrink:0 }}>›</span>}
              <span style={{
                fontSize:11.5, fontFamily:SANS, whiteSpace:"nowrap",
                color: themeDef.preview.text,
                opacity: i === segments.length-1 ? 0.85 : 0.35,
              }}>{seg}</span>
            </span>
          ))}
        </div>
        {!saved && (
          <button onClick={save} title="Save (⌘S)" style={{
            fontSize:10.5, fontFamily:SANS, color: themeDef.preview.accent,
            background:"none", border:"none", cursor:"pointer", padding:"2px 6px",
            borderRadius:4, flexShrink:0, opacity:0.7,
          }}
            onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={e => (e.currentTarget.style.opacity = "0.7")}
          >● Unsaved</button>
        )}
      </div>

      {/* Editor area — background set to theme card color; CodeMirror fills it */}
      <div style={{ flex:1, overflow:"hidden", background: themeDef.preview.card, position:"relative" }}>
        {loading && !error && (
          <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <span style={{ fontSize:12, color:themeDef.preview.text, opacity:0.3, fontFamily:SANS }}>Loading…</span>
          </div>
        )}
        {error && (
          <div style={{ padding:20, fontSize:12, color:"#F14C4C", fontFamily:SANS }}>{error}</div>
        )}
        <div ref={editorRef} style={{ height:"100%", display: loading || error ? "none" : "block" }}/>
      </div>
    </div>
  );
}

/* ─── Terminal ─── */
function TerminalPanel({ cwd, termKey }: { cwd: string; termKey: string }) {
  const termRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!termRef.current) return;
    let cleanup: (() => void) | null = null;
    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      await import("@xterm/xterm/css/xterm.css");
      const term = new Terminal({
        theme: {
          background:"#0a0a0a", foreground:"#CCCCCC", cursor:"rgba(255,255,255,0.6)",
          black:"#000", brightBlack:"#555", red:"#CD3131", brightRed:"#F14C4C",
          green:"#0DBC79", brightGreen:"#23D18B", yellow:"#E5E510", brightYellow:"#F5F543",
          blue:"#2472C8", brightBlue:"#3B8EEA", magenta:"#BC3FBC", brightMagenta:"#D670D6",
          cyan:"#11A8CD", brightCyan:"#29B8DB", white:"#E5E5E5", brightWhite:"#E5E5E5",
          selectionBackground:"rgba(255,255,255,0.1)",
        },
        fontSize:12.5, fontFamily:MONO, cursorBlink:true, cursorStyle:"bar",
        lineHeight:1.4, scrollback:2000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termRef.current!);
      fit.fit();
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/terminal?cwd=${encodeURIComponent(cwd)}`);
      ws.onopen = () => term.focus();
      ws.onmessage = e => term.write(e.data);
      ws.onerror = () => term.writeln("\r\n\x1b[33m⚠ Terminal unavailable\x1b[0m");
      ws.onclose = () => term.writeln("\r\n\x1b[90m[session ended]\x1b[0m");
      term.onData(d => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:"input", data:d })); });
      const ro = new ResizeObserver(() => {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type:"resize", cols:term.cols, rows:term.rows }));
      });
      ro.observe(termRef.current!);
      cleanup = () => { ro.disconnect(); ws.close(); term.dispose(); };
    })();
    return () => { cleanup?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termKey, cwd]);
  return (
    <div style={{ flex:1, background:"#0a0a0a", overflow:"hidden" }}>
      <div ref={termRef} style={{ width:"100%", height:"100%" }}/>
    </div>
  );
}

/* ─── Git Panel ─── */
function GitPanel({ cwd, selectedFile, onSelectFile }: {
  cwd: string;
  selectedFile?: string;
  onSelectFile?: (path: string | null) => void;
}) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    setLoading(true);
    apiGit(cwd).then(g => { setInfo(g); setLoading(false); });
  }, [cwd]);
  useEffect(() => { refresh(); }, [refresh]);

  if (loading) return <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center" }}><span style={{ fontSize:12, color:"var(--muted-foreground)", opacity:0.4 }}>Loading…</span></div>;
  if (!info?.branch) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8, padding:20 }}>
      <GitBranch size={16} color="var(--muted-foreground)" opacity={0.2}/>
      <span style={{ fontSize:12, color:"var(--muted-foreground)", opacity:0.4 }}>Not a git repository</span>
    </div>
  );

  const items = [
    ...(info.staged?.map(f => ({ f, s:"A" as const, c:C.gitA })) ?? []),
    ...(info.modified?.map(f => ({ f, s:"M" as const, c:C.gitM })) ?? []),
    ...(info.untracked?.map(f => ({ f, s:"U" as const, c:C.gitU })) ?? []),
  ];

  return (
    <div className="scroll-subtle" style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column" }}>
      {/* Branch header */}
      <div style={{ padding:"10px 12px 8px", display:"flex", alignItems:"center", gap:6 }}>
        <GitBranch size={10} color="var(--muted-foreground)" opacity={0.5}/>
        <span style={{ fontSize:12, color:"var(--card-foreground)", fontFamily:MONO, flex:1, overflow:"hidden", textOverflow:"ellipsis", opacity:0.8 }}>{info.branch}</span>
        {items.length > 0 && <span style={{ fontSize:9.5, fontWeight:600, background:"var(--c-srf2)", color:"var(--muted-foreground)", border:`1px solid ${C.border}`, padding:"1px 6px", borderRadius:20 }}>{items.length}</span>}
        <button onClick={refresh} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--muted-foreground)", padding:2, borderRadius:3, display:"flex", opacity:0.4 }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity="1"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity="0.4"; }}
        ><RefreshCw size={10}/></button>
      </div>

      {items.length === 0 ? (
        <div style={{ padding:"0 12px", fontSize:12, color:"var(--muted-foreground)", opacity:0.4 }}>Working tree clean</div>
      ) : (
        <>
          <div style={{ padding:"0 12px 6px", fontSize:9.5, fontWeight:600, color:"var(--muted-foreground)", textTransform:"uppercase", letterSpacing:"0.1em", opacity:0.4 }}>Changes — {items.length}</div>
          {items.map(({ f, s, c }) => {
            const active = selectedFile === f;
            return (
              <div key={`${s}-${f}`}
                onClick={() => onSelectFile?.(f)}
                title={f}
                style={{
                  display:"flex", alignItems:"center", gap:6, padding:"2px 12px", height:22,
                  cursor: onSelectFile ? "pointer" : "default",
                  background: active ? C.treeActive : "transparent",
                  borderLeft: `2px solid ${active ? C.treeActiveBdr : "transparent"}`,
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = C.treeHover; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <span style={{ fontSize:12, color:c, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontFamily:SANS, opacity: active ? 1 : 0.85 }}>{f.split("/").pop()}</span>
                <span style={{ fontSize:9.5, fontWeight:600, color:c, flexShrink:0, opacity:0.8 }}>{s}</span>
              </div>
            );
          })}
        </>
      )}

      {(info.commits?.length ?? 0) > 0 && (
        <div style={{ marginTop:16 }}>
          <div style={{ padding:"0 12px 6px", fontSize:9.5, fontWeight:600, color:"var(--muted-foreground)", textTransform:"uppercase", letterSpacing:"0.1em", opacity:0.4 }}>Recent Commits</div>
          {info.commits!.slice(0, 8).map((c, i) => (
            <div key={c.hash} style={{ padding:"3px 12px", display:"flex", gap:8, cursor:"default" }}
              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = C.treeHover)}
              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = "transparent")}
            >
              <span style={{ fontSize:10, fontFamily:MONO, color:"var(--muted-foreground)", flexShrink:0, opacity:0.5 }}>{c.hash}</span>
              <span style={{ fontSize:12, color: i===0 ? "var(--card-foreground)" : "var(--muted-foreground)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", opacity: i===0 ? 0.85 : 0.45, fontFamily:SANS }}>{c.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Diff Viewer ─── */
interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx" | "meta";
  oldN?: number;
  newN?: number;
  text: string;
}

function parseUnifiedDiff(raw: string): { file: string; lines: DiffLine[] }[] {
  if (!raw) return [];
  const files: { file: string; lines: DiffLine[] }[] = [];
  const ensureCurrent = (name: string): { file: string; lines: DiffLine[] } => {
    const existing = files[files.length - 1];
    if (existing) return existing;
    const next = { file: name, lines: [] as DiffLine[] };
    files.push(next);
    return next;
  };
  let oldN = 0, newN = 0;
  const all = raw.split("\n");
  for (const line of all) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/ b\/(.+)$/);
      const entry = { file: m?.[1] ?? "file", lines: [] as DiffLine[] };
      files.push(entry);
      continue;
    }
    const current = ensureCurrent("file");
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m?.[1] && m?.[2]) { oldN = parseInt(m[1], 10); newN = parseInt(m[2], 10); }
      current.lines.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") ||
        line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity ") ||
        line.startsWith("rename ") || line.startsWith("old mode") || line.startsWith("new mode")) {
      current.lines.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", newN, text: line.slice(1) });
      newN++;
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "del", oldN, text: line.slice(1) });
      oldN++;
    } else if (line.startsWith(" ")) {
      current.lines.push({ kind: "ctx", oldN, newN, text: line.slice(1) });
      oldN++; newN++;
    }
  }
  return files;
}

function DiffViewer({ cwd, file, onOpenEditor }: {
  cwd: string;
  file: string | null;
  onOpenEditor?: (absPath: string) => void;
}) {
  const isDark = useThemeStore(s => s.theme) === "dark";
  const [raw, setRaw] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  const refresh = useCallback(() => {
    if (!cwd) return;
    setLoading(true); setErr("");
    apiGitDiff(cwd, file ?? undefined).then(r => {
      if (r.error) setErr(r.error);
      else setRaw(r.diff ?? "");
      setLoading(false);
    });
  }, [cwd, file]);

  useEffect(() => { refresh(); }, [refresh]);

  const files = useMemo(() => parseUnifiedDiff(raw), [raw]);

  const stats = useMemo(() => {
    let add = 0, del = 0;
    for (const f of files) for (const l of f.lines) {
      if (l.kind === "add") add++;
      else if (l.kind === "del") del++;
    }
    return { add, del };
  }, [files]);

  if (loading) return (
    <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <span style={{ fontSize:12, color:"var(--muted-foreground)", opacity:0.4, fontFamily:SANS }}>Computing diff…</span>
    </div>
  );

  if (err) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 }}>
      <AlertTriangle size={18} color="#f59e0b" opacity={0.6}/>
      <span style={{ fontSize:12, color:"var(--muted-foreground)", opacity:0.55, fontFamily:SANS }}>{err}</span>
    </div>
  );

  if (files.length === 0) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10, padding:20 }}>
      <GitCompareArrows size={18} color="var(--muted-foreground)" opacity={0.15}/>
      <span style={{ fontSize:12, color:"var(--muted-foreground)", opacity:0.5, fontFamily:SANS }}>
        {file ? "No changes in this file." : "Working tree clean."}
      </span>
      {!file && (
        <span style={{ fontSize:11, color:"var(--muted-foreground)", opacity:0.3, fontFamily:SANS }}>
          Edits from the agent or the editor will surface here live.
        </span>
      )}
    </div>
  );

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0, background:"var(--card)" }}>
      {/* Header */}
      <div style={{
        flexShrink:0, height:34, padding:"0 18px",
        display:"flex", alignItems:"center", gap:14,
        borderBottom:`1px solid ${C.border}`,
        background:"var(--sidebar)",
      }}>
        <span style={{
          fontSize:10.5, fontWeight:600, color:"var(--muted-foreground)",
          fontFamily:SANS, textTransform:"uppercase", letterSpacing:"0.16em", opacity:0.55,
        }}>
          {file ? "File Diff" : "Working Tree"}
        </span>
        {file && (
          <span style={{
            fontSize:11, color:"var(--card-foreground)", fontFamily:MONO,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", opacity:0.75,
          }}>{file}</span>
        )}
        <div style={{ flex:1 }}/>
        <span style={{ fontSize:10.5, fontFamily:MONO, color:C.gitU, opacity:0.9 }}>+{stats.add}</span>
        <span style={{ fontSize:10.5, fontFamily:MONO, color:C.gitD, opacity:0.9 }}>−{stats.del}</span>
        {file && onOpenEditor && (
          <button onClick={() => onOpenEditor(`${cwd}/${file}`)}
            title="Open in editor"
            style={{ ...iconBtn, width:22, height:22 }}
          ><FileCode size={12}/></button>
        )}
        <button onClick={refresh} title="Refresh" style={{ ...iconBtn, width:22, height:22 }}>
          <RefreshCw size={11}/>
        </button>
      </div>

      {/* Body */}
      <div className="scroll-subtle" style={{
        flex:1, overflow:"auto", padding:"10px 0 24px",
      }}>
        {files.map((f, i) => (
          <div key={i} style={{ marginBottom:14 }}>
            {!file && (
              <div style={{
                padding:"8px 18px 6px",
                display:"flex", alignItems:"center", gap:8,
              }}>
                <FileIcon name={f.file.split("/").pop() ?? f.file}/>
                <span style={{
                  fontSize:12, fontFamily:SANS, fontWeight:500,
                  color:"var(--foreground)", opacity:0.9,
                }}>{f.file}</span>
              </div>
            )}
            <div style={{
              margin:"0 14px", border:`1px solid ${C.border}`, borderRadius:6,
              overflow:"hidden", background:"rgba(0,0,0,0.12)",
              fontFamily:MONO, fontSize:12, lineHeight:1.5,
            }}>
              {f.lines.map((ln, j) => {
                if (ln.kind === "meta") return null;
                if (ln.kind === "hunk") {
                  return (
                    <div key={j} style={{
                      padding:"4px 12px",
                      background:"var(--c-srf)",
                      borderTop: j === 0 ? "none" : `1px solid ${C.border}`,
                      borderBottom:`1px solid ${C.border}`,
                      color:"var(--muted-foreground)", opacity:0.55,
                      fontSize:10.5, fontFamily:MONO,
                      display:"flex", alignItems:"center", gap:8,
                    }}>
                      <span style={{ opacity:0.6, letterSpacing:"0.04em" }}>{ln.text}</span>
                    </div>
                  );
                }
                const bg = ln.kind === "add"
                  ? "rgba(115, 201, 145, 0.10)"
                  : ln.kind === "del"
                    ? "rgba(241, 76, 76, 0.10)"
                    : "transparent";
                const fg = ln.kind === "add"
                  ? isDark ? "rgba(187, 233, 203, 0.92)" : "#166534"
                  : ln.kind === "del"
                    ? isDark ? "rgba(255, 188, 188, 0.92)" : "#991b1b"
                    : isDark ? "rgba(200, 200, 200, 0.75)" : "var(--c-med)";
                const sigilColor = ln.kind === "add" ? C.gitU : ln.kind === "del" ? C.gitD : "var(--c-ghost)";
                const sigil = ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : " ";
                return (
                  <div key={j} style={{ display:"flex", background:bg }}>
                    <span style={{
                      flexShrink:0, width:42, padding:"0 8px 0 10px",
                      textAlign:"right", color:"var(--c-ghost)", userSelect:"none",
                      fontSize:10.5,
                    }}>{ln.oldN ?? ""}</span>
                    <span style={{
                      flexShrink:0, width:42, padding:"0 8px",
                      textAlign:"right", color:"var(--c-ghost)", userSelect:"none",
                      fontSize:10.5, borderRight:`1px solid ${C.border}`,
                    }}>{ln.newN ?? ""}</span>
                    <span style={{
                      flexShrink:0, width:18, textAlign:"center",
                      color: sigilColor, fontWeight:600, userSelect:"none",
                    }}>{sigil}</span>
                    <span style={{
                      flex:1, padding:"0 10px 0 0",
                      color: fg, whiteSpace:"pre",
                      overflow:"hidden",
                    }}>{ln.text || " "}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Tasks Panel (TodoWrite-derived) ─── */
interface AgentTodo { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }

function useLatestToolInput(sessionId: string | null, toolName: string): Record<string, unknown> | null {
  const sessionState = useChatStore(selectSession(sessionId));
  return useMemo(() => {
    // In-flight blocks land in contentSoFar during an active stream — scan
    // those first so the panel updates live as the agent emits TodoWrite /
    // ExitPlanMode calls mid-turn, before the message is finalised.
    const inflight = sessionState.contentSoFar;
    for (let i = inflight.length - 1; i >= 0; i--) {
      const block = inflight[i];
      if (block?.type === "tool_use" && block.tool_name === toolName) {
        return block.input;
      }
    }
    // Fall back to the persisted message history.
    const messages = sessionState.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i]?.content;
      if (!content) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j];
        if (block?.type === "tool_use" && block.tool_name === toolName) {
          return block.input;
        }
      }
    }
    return null;
  }, [sessionState.contentSoFar, sessionState.messages, toolName]);
}

/* ─── Tasks pane (card list) ───
 *
 * Lists agent tasks (one per user prompt → assistant response cycle)
 * as Claude-Code-Desktop-style cards. Each card shows: status icon,
 * task title (derived from the user prompt), and a metadata sub-line
 * with model · status · elapsed · tokens · tool count. The card for
 * the currently-running turn carries a Stop button that calls the
 * existing abort RPC.
 *
 * Two sections: Running (the in-flight turn, if any) on top,
 * Completed (every prior assistant message) below — most-recent first
 * so newly-finished tasks slide in just under the divider.
 *
 * Title derivation: walks back from each assistant message to the
 * nearest preceding user message and uses its first text block,
 * trimmed to 80 chars. If there's no preceding user message (very
 * rare — first message in session was assistant somehow), falls back
 * to a generic "Agent turn N" label so the card still has a name.
 */
function TaskCardsWorkspace({ sessionId }: { sessionId: string | null }) {
  const requestClose = useContext(PaneCloseContext);
  const sessionState = useChatStore(selectSession(sessionId));
  const setSelected = useChatStore(s => s.setSelectedSubagentTask);
  const addView = useAppStore(s => s.addWorkspaceView);
  const { subagentTasks, selectedSubagentTaskId } = sessionState;

  // 500ms ticker — keeps the live duration on Running cards counting
  // up between TaskProgressMessage events (those arrive every few
  // seconds, the ticker fills the gap).
  const hasRunning = useMemo(
    () => Object.values(subagentTasks).some(t => t.status === "running"),
    [subagentTasks],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    const iv = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(iv);
  }, [hasRunning]);

  const taskList = useMemo(() => Object.values(subagentTasks), [subagentTasks]);
  // Running first (newest first), Completed below (newest first).
  // Cards inside each section render most-recent-first so a newly-
  // dispatched task lands at the top of Running, and a freshly-
  // completed one lands at the top of Completed.
  const runningCards = useMemo(
    () => taskList.filter(t => t.status === "running")
      .sort((a, b) => b.startedAt - a.startedAt),
    [taskList],
  );
  const finishedCards = useMemo(
    () => taskList.filter(t => t.status !== "running")
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
    [taskList],
  );

  const fmt = (ms: number) => {
    if (ms <= 0) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  };
  const fmtTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  const onPick = (taskId: string) => {
    if (!sessionId) return;
    // Click opens the Agent pane and selects this task. When the task
    // is backed by a real session (Fleet dispatch), SubagentContent
    // pulls that session's full chat history straight from chat-store
    // — so the user sees every tool call with real input + output
    // without leaving their current workspace.
    setSelected(sessionId, taskId);
    try { addView("process"); } catch { /* noop */ }
  };

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      minHeight: 0, height: "100%",
      background: "var(--sidebar)",
    }}>
      <div style={{
        height: 40, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 12px",
      }}>
        <span data-pane-handle="true" style={{
          fontSize: 12.5, fontWeight: 600, color: "var(--c-high)",
          letterSpacing: 0.1, cursor: "grab",
        }}>Tasks</span>
        <button
          onClick={() => requestClose?.("tasks")}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, borderRadius: 5,
            background: "transparent", border: "none",
            cursor: "pointer", color: "var(--c-ghost)",
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--c-srf)"; (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--c-ghost)"; }}
          title="Close pane"
        >
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>

      <div className="scroll-subtle" style={{
        flex: 1, minHeight: 0, overflowY: "auto",
        padding: "12px 14px 16px",
      }}>
        {runningCards.length === 0 && finishedCards.length === 0 ? (
          <div style={{
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            height: "100%", gap: 8, opacity: 0.5, textAlign: "center", padding: "0 24px",
          }}>
            <CheckSquare size={22} color="var(--c-ghost)" />
            <span style={{ fontSize: 12, color: "var(--c-dim)" }}>
              No tasks yet
            </span>
            <span style={{ fontSize: 11, color: "var(--c-ghost)", lineHeight: 1.5 }}>
              When the agent dispatches a Task, it appears here with live
              tokens, tool uses, and duration.
            </span>
          </div>
        ) : (
          <>
            {runningCards.length > 0 && (
              <>
                <SectionLabel>Running</SectionLabel>
                {runningCards.map(t => (
                  <SubagentTaskCard
                    key={t.id}
                    task={t}
                    nowMs={now}
                    selected={selectedSubagentTaskId === t.id}
                    fmt={fmt}
                    fmtTokens={fmtTokens}
                    onPick={() => onPick(t.id)}
                    onStop={sessionId ? () => wsManager.abort(sessionId) : undefined}
                  />
                ))}
              </>
            )}
            {finishedCards.length > 0 && (
              <>
                <SectionLabel style={{ marginTop: runningCards.length > 0 ? 14 : 0 }}>
                  Completed
                </SectionLabel>
                {finishedCards.map(t => (
                  <SubagentTaskCard
                    key={t.id}
                    task={t}
                    nowMs={now}
                    selected={selectedSubagentTaskId === t.id}
                    fmt={fmt}
                    fmtTokens={fmtTokens}
                    onPick={() => onPick(t.id)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontSize: 11, color: "var(--c-dim)",
      letterSpacing: 0.04, fontWeight: 500,
      margin: "0 0 8px 4px",
      ...(style ?? {}),
    }}>
      {children}
    </div>
  );
}

/* ─── Card rendered for each entry in the Tasks pane ───
 *
 * Pure presentation — reads from a SubagentTask straight from the
 * store. Live state (Running's elapsed counter, last_tool_name) comes
 * directly from TaskProgressMessage, so the card always shows real
 * per-sub-agent metrics, not parent aggregates.
 *
 * Selection highlight: the currently-viewed task in the Agent pane
 * gets a lifted background + accent border. Click → setSelected
 * pushes that task into the Agent pane view.
 */
function SubagentTaskCard({
  task, nowMs, selected, fmt, onPick, onStop,
}: {
  task: import("@/stores/chat-store").SubagentTask;
  nowMs: number;
  selected: boolean;
  fmt: (ms: number) => string;
  fmtTokens: (n: number) => string;
  onPick: () => void;
  /** Optional — when set, renders a Stop button on running cards.
   *  Today this calls wsManager.abort(sessionId) which terminates
   *  the WHOLE session (parent + any sub-agents) — see commit log
   *  for why. */
  onStop?: () => void;
}) {
  const running = task.status === "running";
  const failed = task.status === "failed" || task.status === "stopped";
  const statusLabel = running ? "Running"
    : task.status === "stopped" ? "Stopped"
    : task.status === "failed"  ? "Failed"
    : "Completed";

  // Duration: running cards tick locally so the counter moves between
  // progress events; finished cards use the SDK-reported duration.
  const elapsed = running
    ? Math.max(task.durationMs, nowMs - task.startedAt)
    : task.durationMs;

  // Third-line detail: what is/was the agent actually doing?
  // Priority: running → active tool input; completed → summary first line
  // (only if it adds info beyond the title); fallback → lastToolName.
  // Returns null when there's nothing meaningful — the third line then
  // collapses so we don't repeat the title.
  const detailLine = (() => {
    if (running) {
      const active = Object.values(task.activeToolCalls ?? {})[0];
      if (active) {
        const peek = peekToolInput(active.name, active.input);
        if (peek) return peek;
      }
      if (task.lastToolName) return `Running ${task.lastToolName}`;
      return "Starting…";
    }
    if (task.summary) {
      const first = task.summary.split("\n").map(s => s.trim()).find(Boolean);
      if (first && first !== task.description) return first;
    }
    if (task.lastToolName) return `Last: ${task.lastToolName}`;
    return null;
  })();

  // Subtitle: "<Tool> · <Status>" — matches the reference layout
  // (Bash · Completed). Falls back to "Agent · …" when no tool ran yet.
  const subtitleTool = task.lastToolName ?? "Agent";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } }}
      style={{
        display: "flex", flexDirection: "column", gap: 3,
        width: "100%", textAlign: "left",
        padding: "8px 10px",
        marginBottom: 6,
        borderRadius: 7,
        background: "rgba(255,255,255,0.025)",
        border: "1px solid var(--c-brd)",
        cursor: "pointer",
        transition: "background 0.10s, border-color 0.10s",
        fontFamily: "inherit",
        outline: "none",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
        (e.currentTarget as HTMLElement).style.borderColor = "var(--c-brd2)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.025)";
        (e.currentTarget as HTMLElement).style.borderColor = "var(--c-brd)";
      }}
    >
      {/* Title row — status icon, description, chevron-down. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          flexShrink: 0, width: 12, height: 12,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}>
          {running ? (
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: "var(--c-med)",
              animation: "fleetPulse 1.4s ease-in-out infinite",
            }}/>
          ) : failed ? (
            <X size={11} strokeWidth={2.4} color="#f87171" />
          ) : (
            <Check size={11} strokeWidth={2.4} color="var(--c-low)" />
          )}
        </span>
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 12.5, fontWeight: 600,
          color: "var(--c-high)", letterSpacing: -0.005,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{task.description}</span>
        {running && onStop && (
          <span
            role="button"
            tabIndex={0}
            onClick={e => { e.stopPropagation(); onStop(); }}
            onMouseDown={e => e.preventDefault()}
            style={{
              flexShrink: 0,
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--c-srf2)",
              border: "1px solid var(--sidebar-border)",
              color: "var(--c-med)",
              fontSize: 10.5, fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-high)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
          >Stop</span>
        )}
        <ChevronDown size={11} color="var(--c-ghost)" />
      </div>

      {/* Subtitle — packs tool · status · duration · tool count in one
          mono line so the card is information-dense without bloat. */}
      <div style={{
        marginLeft: 20,
        fontSize: 10.5,
        color: "var(--c-dim)",
        fontFamily: "var(--font-mono)",
        letterSpacing: 0,
        display: "flex", alignItems: "center", gap: 5,
        flexWrap: "wrap",
      }}>
        <span>{subtitleTool}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>{statusLabel}</span>
        {elapsed > 0 && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{fmt(elapsed)}</span>
          </>
        )}
        {task.toolUses > 0 && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{task.toolUses} {task.toolUses === 1 ? "tool" : "tools"}</span>
          </>
        )}
      </div>

      {/* Detail line — concrete preview of what the agent is doing /
          did. Only renders when it'd add info beyond the title (avoids
          the "title repeated" look when summary == description). */}
      {detailLine && (
        <div style={{
          marginLeft: 20, marginTop: 2,
          fontSize: 11.5, color: "var(--c-med)",
          lineHeight: 1.4,
          overflow: "hidden", textOverflow: "ellipsis",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>{detailLine}</div>
      )}

      <style>{`@keyframes fleetPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
      {/* `selected` no longer paints a special chrome — the user explicitly
          asked for no blue tint. Selection is implicit (the side panel
          mirrors whichever card was last clicked). Suppressing the prop
          access lint without dropping the API for callers. */}
      <span style={{ display: "none" }} aria-hidden>{selected ? "1" : "0"}</span>
    </div>
  );
}

/* Best-effort "what is this tool doing right now" string for the
   detail line. Keeps the card readable without dumping the full
   tool input. Matches the reference target where Bash shows the
   command, Edit shows the file, etc. */
function peekToolInput(name: string, input: Record<string, unknown>): string | null {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "shell") {
    const cmd = String(input.command ?? "").trim();
    if (cmd) return cmd.split("\n")[0]?.slice(0, 120) ?? null;
  }
  if (lower === "edit" || lower === "write" || lower === "multiedit" || lower === "read") {
    const path = String(input.file_path ?? input.path ?? "").trim();
    if (path) {
      const parts = path.split("/").filter(Boolean);
      return parts.slice(-2).join("/") || path;
    }
  }
  if (lower === "grep" || lower === "glob") {
    const pat = String(input.pattern ?? input.query ?? "").trim();
    if (pat) return pat;
  }
  if (lower === "webfetch" || lower === "websearch") {
    const url = String(input.url ?? input.query ?? "").trim();
    if (url) return url;
  }
  // Fall back to the first stringy field.
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim().slice(0, 120);
    }
  }
  return null;
}

function TaskCard({
  card, fmt, fmtTokens, onStop,
}: {
  card: {
    id: string; title: string; status: "running" | "completed" | "failed";
    durationMs: number; tokens: number; toolCount: number;
    activeToolName?: string;
  };
  fmt: (ms: number) => string;
  fmtTokens: (n: number) => string;
  onStop?: () => void;
}) {
  const running = card.status === "running";
  const failed  = card.status === "failed";
  const statusLabel = running
    ? (card.activeToolName ? `Running ${card.activeToolName}` : "Running")
    : failed ? "Failed" : "Completed";
  const toolWord = card.toolCount === 1 ? "tool use" : "tool uses";
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4,
      padding: "10px 12px",
      marginBottom: 8,
      borderRadius: 8,
      background: "var(--c-srf)",
      border: "1px solid var(--c-brd)",
      transition: "background 0.15s, border-color 0.15s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Status icon — pulsing blue dot for running, check for done */}
        <span style={{
          flexShrink: 0, width: 14, height: 14,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}>
          {running ? (
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "#3b82f6",
              boxShadow: "0 0 0 3px rgba(59,130,246,0.18)",
              animation: "fleetPulse 1.4s ease-in-out infinite",
            }}/>
          ) : failed ? (
            <X size={12} strokeWidth={2.4} color="#f87171" />
          ) : (
            <Check size={12} strokeWidth={2.4} color="var(--c-low)" />
          )}
        </span>
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 13.5, fontWeight: 500,
          color: "var(--c-high)", letterSpacing: -0.005,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{card.title}</span>
        {running && onStop && (
          <button
            onClick={onStop}
            onMouseDown={e => e.preventDefault()}
            style={{
              flexShrink: 0,
              padding: "3px 9px",
              borderRadius: 5,
              background: "rgba(var(--fg-rgb), 0.08)",
              border: "1px solid var(--c-brd)",
              color: "var(--c-med)",
              fontSize: 11.5, fontWeight: 500, cursor: "pointer",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(var(--fg-rgb), 0.14)"; (e.currentTarget as HTMLElement).style.color = "var(--c-high)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(var(--fg-rgb), 0.08)"; (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
          >
            Stop
          </button>
        )}
      </div>
      {/* Metadata sub-line — model role · status · duration · tokens · tools */}
      <div style={{
        marginLeft: 24,
        fontSize: 11.5,
        color: "var(--c-dim)",
        fontFamily: "var(--font-mono)",
        letterSpacing: 0,
        display: "flex", alignItems: "center", gap: 6,
        flexWrap: "wrap",
      }}>
        <span>Agent</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>{statusLabel}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>{fmt(card.durationMs)}</span>
        {card.tokens > 0 && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{fmtTokens(card.tokens)} tokens</span>
          </>
        )}
        {card.toolCount > 0 && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{card.toolCount} {toolWord}</span>
          </>
        )}
      </div>
      <style>{`@keyframes fleetPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
    </div>
  );
}

function TasksWorkspace({ sessionId }: { sessionId: string | null }) {
  const input = useLatestToolInput(sessionId, "TodoWrite");
  // Tool input shape isn't validated end-to-end — older sessions or
  // malformed payloads can deliver `todos` as null, an object, or
  // missing entirely. Cast-then-default falls through here because the
  // type assertion doesn't run, so guard with Array.isArray.
  const rawTodos = input?.todos;
  const todos: AgentTodo[] = Array.isArray(rawTodos) ? rawTodos : [];

  const counts = useMemo(() => {
    const c = { pending: 0, in_progress: 0, completed: 0 };
    for (const t of todos) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [todos]);

  const total = todos.length;
  const done = counts.completed;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0, background:"var(--card)" }}>
      {/* Header */}
      <div style={{
        flexShrink:0, padding:"14px 22px 10px",
        borderBottom:`1px solid ${C.border}`,
      }}>
        <div style={{ display:"flex", alignItems:"baseline", gap:12 }}>
          <span style={{
            fontSize:11, fontWeight:600, color:"var(--muted-foreground)",
            fontFamily:SANS, textTransform:"uppercase", letterSpacing:"0.14em", opacity:0.55,
          }}>Tasks</span>
          {total > 0 && (
            <span style={{ fontSize:11, color:"var(--muted-foreground)", fontFamily:MONO, opacity:0.45 }}>
              {done} / {total} · {pct}%
            </span>
          )}
          {counts.in_progress > 0 && (
            <span style={{ display:"flex", alignItems:"center", gap:5, marginLeft:"auto", fontSize:10.5, color:"#f59e0b", fontFamily:SANS, opacity:0.9 }}>
              <span style={{
                width:6, height:6, borderRadius:"50%", background:"#f59e0b",
                boxShadow:"0 0 6px rgba(245,158,11,0.6)",
                animation:"fleetPulse 1.4s ease-in-out infinite",
              }}/>
              {counts.in_progress} active
            </span>
          )}
        </div>
        {total > 0 && (
          <div style={{
            marginTop:10, height:2, borderRadius:2, overflow:"hidden",
            background:"var(--c-srf)",
          }}>
            <div style={{
              width:`${pct}%`, height:"100%",
              background:"linear-gradient(90deg, var(--c-ghost), var(--c-med))",
              transition:"width 0.6s cubic-bezier(0.4,0,0.2,1)",
            }}/>
          </div>
        )}
      </div>

      {/* Task list */}
      {total === 0 ? (
        <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 }}>
          <ListTodo size={18} color="var(--muted-foreground)" opacity={0.15}/>
          <span style={{ fontSize:12, color:"var(--muted-foreground)", opacity:0.4, fontFamily:SANS }}>No tasks yet.</span>
          <span style={{ fontSize:11, color:"var(--muted-foreground)", opacity:0.3, fontFamily:SANS }}>Tasks the agent creates will appear here live.</span>
        </div>
      ) : (
        <div className="scroll-subtle" style={{ flex:1, overflowY:"auto", padding:"12px 20px 24px" }}>
          {todos.map((t, i) => {
            const active = t.status === "in_progress";
            const done = t.status === "completed";
            const label = active ? (t.activeForm || t.content) : t.content;
            return (
              <div key={i} style={{
                display:"flex", alignItems:"flex-start", gap:12,
                padding:"8px 6px", borderRadius:6,
                background: active ? "rgba(245,158,11,0.055)" : "transparent",
                transition:"background 0.2s",
              }}>
                <span style={{
                  flexShrink:0, marginTop:5,
                  width:8, height:8, borderRadius:"50%",
                  background: active ? "#f59e0b" : done ? "var(--c-ghost)" : "transparent",
                  border: done ? "none" : active ? "none" : "1px solid var(--c-brd2)",
                  boxShadow: active ? "0 0 0 3px rgba(245,158,11,0.12), 0 0 8px rgba(245,158,11,0.45)" : "none",
                  animation: active ? "fleetPulse 1.4s ease-in-out infinite" : "none",
                }}/>
                <span style={{
                  flex:1, fontSize:13.5, lineHeight:1.55,
                  fontFamily:SANS,
                  fontWeight: active ? 500 : 400,
                  color: done ? "var(--c-dim)" : active ? "var(--foreground)" : "var(--card-foreground)",
                  textDecoration: done ? "line-through" : "none",
                  textDecorationColor: "var(--c-ghost)",
                  opacity: done ? 0.65 : 1,
                  letterSpacing: active ? "-0.005em" : 0,
                }}>
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <style>{`@keyframes fleetPulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.22); opacity: 0.75; } }`}</style>
    </div>
  );
}

/* ─── Plan Panel (ExitPlanMode-derived) ─── */
function PlanWorkspace({ sessionId }: { sessionId: string | null }) {
  const input = useLatestToolInput(sessionId, "ExitPlanMode");
  const plan = typeof input?.plan === "string" ? (input.plan as string) : "";

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0, background:"var(--card)" }}>
      <div style={{
        flexShrink:0, padding:"14px 22px 12px",
        borderBottom:`1px solid ${C.border}`,
        display:"flex", alignItems:"baseline", gap:12,
      }}>
        <span style={{
          fontSize:11, fontWeight:600, color:"var(--muted-foreground)",
          fontFamily:SANS, textTransform:"uppercase", letterSpacing:"0.14em", opacity:0.55,
        }}>Plan</span>
        {plan && (
          <span style={{ fontSize:10.5, color:"var(--muted-foreground)", opacity:0.4, fontFamily:SANS }}>
            proposed by agent
          </span>
        )}
      </div>

      {!plan ? (
        <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 }}>
          <NotebookText size={18} color="var(--muted-foreground)" opacity={0.15}/>
          <span style={{ fontSize:12, color:"var(--muted-foreground)", opacity:0.4, fontFamily:SANS }}>No plan yet.</span>
          <span style={{ fontSize:11, color:"var(--muted-foreground)", opacity:0.3, fontFamily:SANS, maxWidth:320, textAlign:"center" }}>
            When the agent drafts a plan it will appear here.
          </span>
        </div>
      ) : (
        <div className="scroll-subtle" style={{ flex:1, overflowY:"auto", padding:"18px 28px 32px" }}>
          <div style={{ maxWidth:720, margin:"0 auto", color:"var(--foreground)", fontFamily:SANS, fontSize:14, lineHeight:1.75 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={planMdComponents}>{plan}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

const planMdComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => <h1 style={{ fontSize:17, fontWeight:700, letterSpacing:"-0.015em", margin:"4px 0 12px", color:"var(--foreground)" }}>{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 style={{ fontSize:14, fontWeight:600, letterSpacing:"-0.01em", margin:"20px 0 8px", color:"var(--foreground)" }}>{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 style={{ fontSize:12.5, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", margin:"18px 0 6px", color:"var(--muted-foreground)" }}>{children}</h3>,
  p:  ({ children }: { children?: React.ReactNode }) => <p style={{ margin:"0 0 12px", color:"var(--card-foreground)" }}>{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul style={{ paddingLeft:18, margin:"0 0 14px" }}>{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol style={{ paddingLeft:18, margin:"0 0 14px" }}>{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li style={{ margin:"3px 0", color:"var(--card-foreground)" }}>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong style={{ fontWeight:600, color:"var(--foreground)" }}>{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em style={{ color:"var(--card-foreground)" }}>{children}</em>,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = !!className;
    if (isBlock) {
      return (
        <pre style={{
          margin:"12px 0", padding:"12px 14px", borderRadius:6,
          background:"var(--c-srf)", border:`1px solid ${C.border}`,
          fontFamily:MONO, fontSize:12, lineHeight:1.6, overflowX:"auto",
          color:"var(--card-foreground)",
        }}><code>{children}</code></pre>
      );
    }
    return (
      <code style={{
        fontFamily:MONO, fontSize:"0.88em",
        background:"var(--c-srf2)", padding:"1px 6px",
        borderRadius:3, color:"var(--foreground)",
      }}>{children}</code>
    );
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote style={{
      margin:"12px 0", padding:"2px 14px",
      borderLeft:"2px solid var(--c-brd2)",
      color:"var(--muted-foreground)",
    }}>{children}</blockquote>
  ),
  hr: () => <hr style={{ border:"none", borderTop:`1px solid ${C.border}`, margin:"18px 0" }}/>,
  /* Table — polished card with subtle header band + hairline row
     separators. Same recipe as message-content.tsx and the marketplace
     markdown renderer, so every markdown table in the app shares one
     design language. */
  table: ({ children }: { children?: React.ReactNode }) => (
    <div style={{
      margin: "14px 0",
      borderRadius: 9,
      overflow: "hidden",
      border: "1px solid var(--c-brd)",
      background: "var(--background)",
    }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th style={{
      padding: "9px 14px",
      borderBottom: "1px solid var(--c-brd)",
      textAlign: "left",
      fontWeight: 600,
      color: "var(--c-dim)",
      fontSize: 10.5,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      background: "var(--c-srf)",
      verticalAlign: "middle",
    }}>{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td style={{
      padding: "10px 14px",
      borderBottom: "1px solid var(--c-brd)",
      color: "var(--c-high)",
      fontSize: 13,
      lineHeight: 1.45,
      verticalAlign: "middle",
    }}>{children}</td>
  ),
};

/* ─── Process Viewer — live agent activity feed ───
   Design direction: "silent log". Each event is a single flat line — an emoji
   glyph on the left, a mono-caps tool label, the subject inline, and a tiny
   clock on the right. No panels, no borders, no inner frames, no running
   dots. Hover lifts a subtle background so a row still feels clickable. The
   whole feed reads like a terminal printing one line at a time.
*/
type ToolKind =
  | "file_write" | "file_edit" | "file_read"
  | "todo" | "plan"
  | "bash" | "tool" | "search" | "web" | "subagent" | "task";

function classifyTool(name: string): { kind: ToolKind; glyph: string; label: string } {
  const n = name.toLowerCase();
  if (n === "todowrite")                       return { kind:"todo",       glyph:"✓",  label:"Todo"  };
  if (n === "exitplanmode")                    return { kind:"plan",       glyph:"◆",  label:"Plan"  };
  if (n === "write")                           return { kind:"file_write", glyph:"✎",  label:"Write" };
  if (n === "edit" || n === "multiedit")       return { kind:"file_edit",  glyph:"✎",  label:"Edit"  };
  if (n === "read" || n === "notebookread")    return { kind:"file_read",  glyph:"👁", label:"Read"  };
  if (n === "bash" || n === "powershell")      return { kind:"bash",       glyph:"⚡", label:"Shell" };
  if (n === "glob")                            return { kind:"search",     glyph:"🔍", label:"Glob"  };
  if (n === "grep")                            return { kind:"search",     glyph:"🔍", label:"Grep"  };
  if (n === "webfetch" || n === "websearch")   return { kind:"web",        glyph:"🌐", label:"Web"   };
  if (n === "agent" || n === "taskcreate")     return { kind:"subagent",   glyph:"✦",  label:"Agent" };
  if (n === "taskupdate" || n === "tasklist" || n === "taskget") return { kind:"task", glyph:"◎", label:"Task" };
  return { kind:"tool", glyph:"▪", label:name };
}


function ellipsis(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ─── Minimal monochrome syntax tokeniser ───
   Brutalist palette: luminance only. Keywords bold, strings softer, comments
   dim italic, numbers mid-tone. No hue. Covers the handful of languages
   Fleet users actually edit; falls back to plain text for the rest.
*/
type TokenType = "kw" | "str" | "cmt" | "num" | "tag" | "txt";

interface HLToken { type: TokenType; text: string; }

const HL = {
  kw:  "rgba(255,255,255,0.96)",
  str: "rgba(255,255,255,0.70)",
  cmt: "rgba(255,255,255,0.32)",
  num: "rgba(255,255,255,0.78)",
  tag: "rgba(255,255,255,0.88)",
  txt: "rgba(255,255,255,0.82)",
};

const JS_KEYWORDS = new Set([
  "import","export","from","default","const","let","var","function","return",
  "if","else","for","while","do","switch","case","break","continue","class",
  "extends","new","this","super","async","await","try","catch","finally",
  "throw","typeof","instanceof","in","of","true","false","null","undefined",
  "void","delete","interface","type","enum","namespace","declare","readonly",
  "public","private","protected","static","as","is","satisfies","keyof",
]);
const PY_KEYWORDS = new Set([
  "def","class","if","elif","else","for","while","return","import","from","as",
  "try","except","finally","raise","with","yield","async","await","lambda",
  "pass","break","continue","global","nonlocal","True","False","None","not",
  "and","or","in","is","self","cls",
]);
const CSS_KEYWORDS = new Set([
  "important","inherit","initial","unset","auto","none","normal","bold",
  "italic","center","left","right","flex","grid","block","inline","absolute",
  "relative","fixed","sticky",
]);

function pickKeywordSet(lang: string): Set<string> | null {
  const l = lang.toLowerCase();
  if (["ts","tsx","js","jsx","mjs","cjs"].includes(l)) return JS_KEYWORDS;
  if (l === "py" || l === "pyw") return PY_KEYWORDS;
  if (l === "css" || l === "scss" || l === "sass") return CSS_KEYWORDS;
  return null;
}

function tokenizeLine(line: string, lang: string): HLToken[] {
  const kws = pickKeywordSet(lang);
  const out: HLToken[] = [];
  let i = 0;
  const n = line.length;

  const push = (type: TokenType, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };

  while (i < n) {
    const ch = line[i]!;

    // Line comments — `//` for JS-family, `#` for Python/shell/yaml,
    // `<!--` … `-->` not handled here (single-line tokeniser).
    if (
      (ch === "/" && line[i + 1] === "/" && (lang === "ts"||lang==="tsx"||lang==="js"||lang==="jsx"||lang==="mjs"||lang==="cjs"||lang==="css"||lang==="scss"||lang==="c"||lang==="cpp"||lang==="go"||lang==="rs"||lang==="java"||lang==="kt")) ||
      (ch === "#" && (lang === "py"||lang==="pyw"||lang==="sh"||lang==="yml"||lang==="yaml"||lang==="toml"))
    ) {
      push("cmt", line.slice(i));
      i = n;
      continue;
    }

    // String literals — single / double / backtick. No multi-line tracking
    // so unterminated strings just run to end of line.
    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === quote) { j++; break; }
        j++;
      }
      push("str", line.slice(i, j));
      i = j;
      continue;
    }

    // Numbers
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < n && /[0-9._xA-Fa-f]/.test(line[j]!)) j++;
      push("num", line.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      push(kws && kws.has(word) ? "kw" : "txt", word);
      i = j;
      continue;
    }

    // HTML/JSX-ish tags (very rough — look for `<Name` or `</Name>`)
    if (ch === "<" && (/[A-Za-z/]/.test(line[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && line[j] !== ">" && line[j] !== " ") j++;
      push("tag", line.slice(i, j));
      i = j;
      continue;
    }

    // Everything else — single char of plain text.
    push("txt", ch);
    i++;
  }

  return out;
}

function HighlightedLine({ text, lang }: { text: string; lang: string }) {
  const tokens = useMemo(() => tokenizeLine(text, lang), [text, lang]);
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={{
          color: HL[t.type],
          fontWeight: t.type === "kw" ? 600 : 400,
          fontStyle: t.type === "cmt" ? "italic" : "normal",
        }}>{t.text}</span>
      ))}
    </>
  );
}

function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/* Summarise line deltas for a file-modifying tool call so the row header can
   show `+N -M` counts in green/red next to the subject. */
function lineDelta(ev: ProcessEvent, kind: ToolKind): { add: number; del: number } | null {
  const input = ev.input ?? {};
  if (kind === "file_write") {
    const content = String(input.content ?? "");
    return { add: content ? content.split("\n").length : 0, del: 0 };
  }
  if (kind === "file_edit") {
    const o = String(input.old_string ?? "");
    const n = String(input.new_string ?? "");
    return {
      add: n ? n.split("\n").length : 0,
      del: o ? o.split("\n").length : 0,
    };
  }
  return null;
}


/* Summarise a tool call into a single inline subject string — what the user
   needs to glance at. No multi-line bodies, no diff previews. */
function eventSubject(ev: ProcessEvent, kind: ToolKind): string {
  const input = ev.input ?? {};
  if (kind === "file_write" || kind === "file_edit" || kind === "file_read") {
    const raw = String(input.file_path ?? input.path ?? "");
    const filename = raw.split(/[\\/]/).pop() ?? "";
    return filename || raw || "file";
  }
  if (kind === "todo") {
    const todos = (input.todos as AgentTodo[] | undefined) ?? [];
    const active = todos.find(t => t.status === "in_progress");
    if (active) return ellipsis(active.activeForm || active.content, 80);
    return `${todos.length} item${todos.length !== 1 ? "s" : ""}`;
  }
  if (kind === "plan") {
    const plan = String(input.plan ?? "");
    const first = plan.split("\n").find(l => l.trim()) ?? "";
    return ellipsis(first.replace(/^#+\s*/, ""), 90) || "plan proposed";
  }
  if (kind === "bash") {
    const desc = String(input.description ?? "");
    if (desc) return ellipsis(desc, 80);
    const cmd = String(input.command ?? "");
    return ellipsis(cmd, 80) || "shell";
  }
  if (kind === "search") {
    const pattern = String(input.pattern ?? input.query ?? input.filter ?? "");
    return ellipsis(pattern, 80) || "(no pattern)";
  }
  if (kind === "web") {
    return ellipsis(String(input.url ?? input.query ?? ""), 90) || "web";
  }
  if (kind === "subagent") {
    const descr = String(input.description ?? input.subject ?? input.prompt ?? "");
    return ellipsis(descr, 90) || "subagent";
  }
  if (kind === "task") {
    return ev.name;
  }
  // Generic fallback — pick the first string/number field we can find.
  for (const [, v] of Object.entries(input)) {
    if (typeof v === "string" && v) return ellipsis(v, 80);
    if (typeof v === "number") return String(v);
  }
  return "";
}



function DiffDetail({ ev }: { ev: ProcessEvent }) {
  const input = ev.input ?? {};
  const filePath = String(input.file_path ?? input.path ?? "");
  const lang = extOf(filePath);
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");

  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];

  return (
    <div style={{
      margin: 0,
      background: "var(--card)",
      fontFamily: MONO, fontSize: 11.5, lineHeight: 1.6,
      overflow: "hidden",
    }}>
      {oldLines.map((ln, i) => (
        <div key={`d${i}`} style={{
          display: "flex",
          background: "rgba(248,113,113,0.06)",
          borderLeft: "2px solid rgba(248,113,113,0.22)",
        }}>
          <span style={gutterStyle}>{i + 1}</span>
          <span style={sigilCell("rgba(248,113,113,0.8)")}>−</span>
          <span style={{ flex: 1, padding: "0 10px 0 0", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>
            <HighlightedLine text={ln || " "} lang={lang}/>
          </span>
        </div>
      ))}
      {oldLines.length > 0 && newLines.length > 0 && (
        <div style={{ height: 1, background: "var(--c-brd)", margin: "2px 0" }}/>
      )}
      {newLines.map((ln, i) => (
        <div key={`a${i}`} style={{
          display: "flex",
          background: "rgba(74,222,128,0.06)",
          borderLeft: "2px solid rgba(74,222,128,0.22)",
        }}>
          <span style={gutterStyle}>{i + 1}</span>
          <span style={sigilCell("rgba(74,222,128,0.8)")}>+</span>
          <span style={{ flex: 1, padding: "0 10px 0 0", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>
            <HighlightedLine text={ln || " "} lang={lang}/>
          </span>
        </div>
      ))}
    </div>
  );
}

const gutterStyle: React.CSSProperties = {
  flexShrink: 0, width: 40, padding: "0 8px 0 10px",
  textAlign: "right", color: "var(--c-ghost)",
  userSelect: "none", fontSize: 10.5,
};

function sigilCell(color: string): React.CSSProperties {
  return {
    flexShrink: 0, width: 18, textAlign: "center",
    color, fontWeight: 600, userSelect: "none",
  };
}

function WriteDetail({ ev }: { ev: ProcessEvent }) {
  const input = ev.input ?? {};
  const filePath = String(input.file_path ?? input.path ?? "");
  const lang = extOf(filePath);
  const content = String(input.content ?? "");
  const allLines = content.split("\n");
  const [expanded, setExpanded] = useState(false);
  const PREVIEW = 20;
  const showFull = expanded || allLines.length <= PREVIEW;
  const lines = showFull ? allLines : allLines.slice(0, PREVIEW);
  const hiddenCount = allLines.length - lines.length;

  return (
    <div
      onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
      style={{
        margin: 0,
        background: "var(--card)",
        fontFamily: MONO, fontSize: 11.5, lineHeight: 1.6,
        overflow: "hidden", cursor: "pointer",
      }}
      title={expanded ? "Click to collapse" : "Click to expand full file"}
    >
      {lines.map((ln, i) => (
        <div key={i} style={{
          display: "flex",
          background: "rgba(74,222,128,0.06)",
          borderLeft: "2px solid rgba(74,222,128,0.22)",
        }}>
          <span style={gutterStyle}>{i + 1}</span>
          <span style={sigilCell("rgba(74,222,128,0.8)")}>+</span>
          <span style={{ flex: 1, padding: "0 10px 0 0", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>
            <HighlightedLine text={ln || " "} lang={lang}/>
          </span>
        </div>
      ))}
      {!showFull && (
        <div style={{
          padding: "6px 14px",
          borderTop: "1px solid var(--c-brd)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          fontFamily: MONO, fontSize: 10, color: "var(--c-ghost)",
          letterSpacing: "0.1em", textTransform: "uppercase",
        }}>
          <span>+{hiddenCount} more line{hiddenCount !== 1 ? "s" : ""}</span>
          <span style={{ color: "var(--c-dim)" }}>Click to expand →</span>
        </div>
      )}
      {expanded && allLines.length > PREVIEW && (
        <div style={{
          padding: "6px 14px",
          borderTop: "1px solid var(--c-brd)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          fontFamily: MONO, fontSize: 10, color: "var(--c-ghost)",
          letterSpacing: "0.1em", textTransform: "uppercase",
        }}>
          <span>{allLines.length} line{allLines.length !== 1 ? "s" : ""}</span>
          <span style={{ color: "var(--c-dim)" }}>← Click to collapse</span>
        </div>
      )}
    </div>
  );
}

function ReadDetail({ ev }: { ev: ProcessEvent }) {
  const input = ev.input ?? {};
  const filePath = String(input.file_path ?? input.path ?? "");
  const offset = input.offset ? String(input.offset) : null;
  const limit = input.limit ? String(input.limit) : null;
  return (
    <div style={{
      margin: 0, padding: "10px 14px",
      background: "var(--card)",
      fontFamily: MONO, fontSize: 11.5, lineHeight: 1.6,
    }}>
      <div style={{ color: "var(--c-ghost)", fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 5 }}>path</div>
      <div style={{ wordBreak: "break-all", color: "var(--c-low)" }}>{filePath}</div>
      {(offset || limit) && (
        <div style={{ marginTop: 5, color: "var(--c-ghost)", fontSize: 10.5 }}>
          {offset && <>offset {offset}</>}{offset && limit && <> · </>}{limit && <>limit {limit}</>}
        </div>
      )}
    </div>
  );
}

function BashDetail({ ev }: { ev: ProcessEvent }) {
  const input = ev.input ?? {};
  const cmd = String(input.command ?? "");
  return (
    <div style={{
      margin: 0, padding: "10px 14px",
      background: "var(--card)",
      fontFamily: MONO, fontSize: 11.5, color: "var(--c-low)",
      lineHeight: 1.6,
    }}>
      <div style={{ display: "flex", gap: 10, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        <span style={{ color: "var(--c-ghost)", flexShrink: 0 }}>$</span>
        <span style={{ flex: 1 }}>{cmd}</span>
      </div>
    </div>
  );
}

function GenericDetail({ ev }: { ev: ProcessEvent }) {
  const input = ev.input ?? {};
  const primaryField = useMemo(() => {
    const priority = ["prompt", "description", "query", "url", "content", "pattern", "command", "path", "file_path"];
    for (const k of priority) {
      if (k in input && input[k]) return { key: k, value: String(input[k]) };
    }
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === "string" && v) return { key: k, value: v };
    }
    return null;
  }, [input]);

  if (!primaryField) return null;

  return (
    <div style={{ margin: 0, padding: "10px 14px", background: "var(--card)" }}>
      <div style={{
        fontSize: 9.5, fontFamily: MONO, color: "var(--c-ghost)",
        textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6,
      }}>
        {primaryField.key}
      </div>
      <div style={{
        fontFamily: MONO, fontSize: 11.5, color: "var(--c-low)",
        lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
        maxHeight: 260, overflowY: "auto",
      }}>
        {primaryField.value}
      </div>
    </div>
  );
}

function SubagentDetail({ ev }: { ev: ProcessEvent }) {
  const input = ev.input ?? {};
  const prompt = String(input.prompt ?? "");
  const subtype = String(input.subagent_type ?? "");
  const description = String(input.description ?? "");
  return (
    <div style={{ margin: 0, background: "var(--card)" }}>
      {(subtype || description) && (
        <div style={{
          padding: "8px 14px 6px",
          borderBottom: "1px solid var(--c-brd)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {subtype && (
            <span style={{
              fontFamily: MONO, fontSize: 9.5, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: "0.1em",
              color: "var(--c-ghost)",
              background: "var(--c-srf)",
              border: "1px solid var(--c-brd)",
              padding: "1px 6px", borderRadius: 4,
            }}>{subtype}</span>
          )}
          {description && (
            <span style={{ fontSize: 11.5, color: "var(--c-dim)", fontFamily: SANS }}>{description}</span>
          )}
        </div>
      )}
      {prompt && (
        <div style={{
          padding: "10px 14px",
          fontFamily: SANS, fontSize: 12, color: "var(--c-low)",
          lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 280, overflowY: "auto",
        }}>
          {prompt}
        </div>
      )}
    </div>
  );
}

function SearchDetail({ ev }: { ev: ProcessEvent }) {
  const input = ev.input ?? {};
  const pattern = String(input.pattern ?? input.query ?? input.filter ?? "");
  const path = String(input.path ?? "");
  const glob = String(input.glob ?? "");
  return (
    <div style={{ margin: 0, padding: "10px 14px", background: "var(--card)" }}>
      {pattern && (
        <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--c-low)", marginBottom: path || glob ? 6 : 0 }}>
          {pattern}
        </div>
      )}
      {(path || glob) && (
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--c-ghost)" }}>
          {[path, glob].filter(Boolean).join("  ·  ").replace(/^\/Users\/[^/]+/, "~")}
        </div>
      )}
    </div>
  );
}

function EventDetail({ ev, kind }: { ev: ProcessEvent; kind: ToolKind }) {
  if (kind === "file_edit")  return <DiffDetail ev={ev}/>;
  if (kind === "file_write") return <WriteDetail ev={ev}/>;
  if (kind === "file_read")  return <ReadDetail ev={ev}/>;
  if (kind === "bash")       return <BashDetail ev={ev}/>;
  if (kind === "subagent")   return <SubagentDetail ev={ev}/>;
  if (kind === "search")     return <SearchDetail ev={ev}/>;
  return <GenericDetail ev={ev}/>;
}

/* ── Per-kind icon color (subtle, used only for running state) ── */
const KIND_ICON_COLOR: Record<ToolKind, string> = {
  file_read:  "rgba(96,165,250,0.7)",
  file_write: "rgba(74,222,128,0.7)",
  file_edit:  "rgba(251,191,36,0.7)",
  bash:       "rgba(167,139,250,0.7)",
  search:     "var(--c-dim)",
  web:        "rgba(56,189,248,0.7)",
  subagent:   "rgba(244,114,182,0.7)",
  todo:       "rgba(251,146,60,0.7)",
  plan:       "var(--c-dim)",
  task:       "var(--c-dim)",
  tool:       "var(--c-dim)",
};

function KindIcon({ kind, color, size = 12 }: { kind: ToolKind; color: string; size?: number }) {
  const p = { size, color, strokeWidth: 1.75 };
  if (kind === "file_read")  return <Eye {...p}/>;
  if (kind === "file_write") return <Pencil {...p}/>;
  if (kind === "file_edit")  return <FileCode {...p}/>;
  if (kind === "bash")       return <TerminalIcon {...p}/>;
  if (kind === "search")     return <Search {...p}/>;
  if (kind === "web")        return <Globe {...p}/>;
  if (kind === "subagent")   return <Activity {...p}/>;
  if (kind === "todo")       return <CheckSquare {...p}/>;
  if (kind === "plan")       return <NotebookText {...p}/>;
  if (kind === "task")       return <Layers {...p}/>;
  return <Code2 {...p}/>;
}

function formatDuration(startedAt: number, endedAt: number | null): string {
  if (!endedAt) return "";
  const ms = endedAt - startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Process event row — single line per tool call.
 *
 * Visual hierarchy:
 *   • A tiny coloured square left of the icon column carries the kind
 *     accent (file=high, search=low, web=mid, bash=mid). Lets the eye
 *     scan a long list and pick out "where did the agent edit?" without
 *     reading the icon glyph.
 *   • `groupStart` adds a subtle 1px divider above the row when the
 *     previous row was a different kind. Sequential same-kind calls
 *     read as one block; transitions get a clear break. This is the
 *     biggest single readability win — a list of 29 steps without it
 *     reads as undifferentiated noise.
 *   • Subject line uses the secondary helper (`prettifySubject`) which
 *     trims absolute project paths down to a relative form so a long
 *     `/Users/cryonicx/Desktop/projects/checker/Costco/...` becomes
 *     just `…/Costco/...`. The full path is always available on hover
 *     via `title`.
 */
function ProcessEventRow({ ev, groupStart }: { ev: ProcessEvent; groupStart?: boolean }) {
  const meta = classifyTool(ev.name);
  const running = ev.status === "running";
  const errored = ev.status === "errored";
  const subject = eventSubject(ev, meta.kind);
  const subjectTrimmed = prettifySubject(subject, meta.kind);
  const delta = lineDelta(ev, meta.kind);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  const accent = KIND_ICON_COLOR[meta.kind] ?? "var(--c-low)";
  const iconColor = running
    ? accent
    : errored ? "rgba(248,113,113,0.45)"
    : "var(--c-ghost)";
  const duration = formatDuration(ev.startedAt, ev.endedAt);
  const isFileKind = meta.kind === "file_read" || meta.kind === "file_write" || meta.kind === "file_edit";

  return (
    <div style={{
      // Group divider — only fires when this row's kind differs from
      // the row above. Hairline border, very dim — present without
      // pulling attention.
      borderTop: groupStart ? "1px solid var(--c-brd)" : "none",
      marginTop: groupStart ? 1 : 0,
    }}>
      <div
        onClick={() => setOpen(v => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={subject}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "5px 12px 5px 0",
          cursor: "pointer",
          background: open ? "var(--c-srf)" : hovered ? "var(--c-srf)" : "transparent",
          transition: "background 0.1s",
          position: "relative",
        }}
      >
        {/* Kind-accent stripe — 2px coloured rail on the left edge.
            Stays the same on idle/running/errored so the kind palette
            is the dominant visual. Errored rows get a red overlay
            on top of the stripe via the icon colour + strikethrough. */}
        <span aria-hidden style={{
          position: "absolute", left: 0, top: 4, bottom: 4, width: 2,
          background: errored ? "rgba(248,113,113,0.55)" : accent,
          opacity: open || hovered || running ? 1 : 0.4,
          transition: "opacity 0.1s",
          borderRadius: 1,
        }}/>

        {/* Bare icon — sits just inside the stripe */}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", width: 14, marginLeft: 12 }}>
          <KindIcon kind={meta.kind} size={11} color={iconColor} />
        </span>

        {/* Subject — single line, with title attribute carrying the
            full untruncated value for hover. */}
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 12, fontWeight: running ? 500 : 400,
          fontFamily: isFileKind ? MONO : SANS,
          letterSpacing: isFileKind ? "-0.01em" : "normal",
          color: errored ? "var(--c-dim)"
            : running ? "var(--c-high)"
            : open ? "var(--c-high)"
            : "var(--c-med)",
          textDecoration: errored ? "line-through" : "none",
          textDecorationColor: "var(--c-ghost)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          lineHeight: 1.3,
        }}>
          {subjectTrimmed}
        </span>

        {/* Right: deltas + duration + chevron (chevron only on hover/open) */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          {delta && (delta.add > 0 || delta.del > 0) && (
            <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
              {delta.add > 0 && <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, color: "rgba(74,222,128,0.75)" }}>+{delta.add}</span>}
              {delta.del > 0 && <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, color: "rgba(248,113,113,0.75)" }}>−{delta.del}</span>}
            </span>
          )}
          <span style={{
            fontFamily: MONO, fontSize: 9.5,
            color: running ? "var(--c-dim)" : errored ? "rgba(248,113,113,0.4)" : "var(--c-ghost)",
            minWidth: 28, textAlign: "right",
          }}>
            {running ? "···" : errored ? "err" : (duration || "")}
          </span>
          <ChevronRight size={9} style={{
            flexShrink: 0,
            color: "var(--c-ghost)",
            opacity: hovered || open ? 1 : 0,
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 0.15s, opacity 0.1s",
          }}/>
        </div>
      </div>

      {open && (
        <div style={{ marginBottom: 2 }}>
          <EventDetail ev={ev} kind={meta.kind}/>
        </div>
      )}
    </div>
  );
}

/** Trim subject text for the row display — crops absolute project
 *  paths down to a `…/last-two-segments` form so the row doesn't
 *  spend its width on cwd prefixes the user can already see in the
 *  workspace title bar. Hover restores the full value via `title`. */
function prettifySubject(s: string, kind: ToolKind): string {
  if (!s) return "";
  // For glob patterns + file paths: collapse absolute paths to last two
  // path segments. `/Users/foo/bar/baz/qux/` → `…/qux/` (or `…/baz/qux`).
  if (kind === "search" || kind === "file_read" || kind === "file_write" || kind === "file_edit") {
    // Recognise an absolute-ish path: starts with `/` or `~/`.
    if (/^[~/]/.test(s) && s.length > 36) {
      const parts = s.split("/").filter(Boolean);
      if (parts.length > 2) {
        return "…/" + parts.slice(-2).join("/");
      }
    }
  }
  // Bash: same trimming if the description is itself a path.
  if (kind === "bash" && /^[~/]/.test(s) && s.length > 36) {
    const parts = s.split("/").filter(Boolean);
    if (parts.length > 2) return "…/" + parts.slice(-2).join("/");
  }
  return s;
}

/* ─── Agent Panel (focused current-task view) ───
 *
 * Shows ONLY the latest task — the most recent user prompt and
 * everything the agent did in response (thinking, tool calls,
 * streaming text). Past turns stay in the main chat; the Agent pane
 * is the "what is the agent doing RIGHT NOW" lens, matching Claude
 * Code Desktop's right pane reference the user gave.
 *
 * Renders chat-style content (the same MessageContent components the
 * main chat uses) so prompt cards / thinking rows / grouped tool
 * calls / diffs all stay in design sync. No chat input — this is a
 * read-only focused view.
 */
/* ─── Agent pane (focused sub-agent view) ───
 *
 * Renders the currently-selected sub-agent's live activity log —
 * its prompt (from description), its tool calls grouped chat-style,
 * its streaming text + thinking, and a header with name + live
 * metrics (tokens / tool uses / duration).
 *
 * If no sub-agent is selected and there are running ones, picks the
 * most-recent running task automatically. If there are none at all,
 * shows an empty-state instead of mirroring the main chat (regular
 * tools belong inline in chat, not in this pane).
 *
 * Provider-agnostic at this layer: reads only `subagentTasks` —
 * any bridge that emits subagent_start/progress/end fills it in.
 */
function AgentPaneView({ sessionId }: { sessionId: string | null }) {
  const requestClose = useContext(PaneCloseContext);
  const sessionState = useChatStore(selectSession(sessionId));
  const setSelected = useChatStore(s => s.setSelectedSubagentTask);
  const { subagentTasks, selectedSubagentTaskId } = sessionState;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Pick which task to show. Explicit user selection wins; otherwise
  // fall back to the newest running task, then the newest task
  // overall — keeps the pane useful right after a dispatch ends.
  const taskList = useMemo(() => Object.values(subagentTasks), [subagentTasks]);
  const activeTask = useMemo(() => {
    if (selectedSubagentTaskId && subagentTasks[selectedSubagentTaskId]) {
      return subagentTasks[selectedSubagentTaskId];
    }
    const running = taskList
      .filter(t => t.status === "running")
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (running) return running;
    return taskList.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  }, [selectedSubagentTaskId, subagentTasks, taskList]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current =
      el.scrollHeight - (el.scrollTop + el.clientHeight) < 40;
  };

  // Auto-pin scroll to bottom as new tokens / tools land inside the
  // selected sub-agent's content log.
  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    activeTask?.id,
    activeTask?.content.length,
    activeTask?.streamingText,
    activeTask?.streamingThinking,
    activeTask?.status,
  ]);

  // Reset selection back to auto-pick when the chosen task disappears
  // (e.g. cleared by session reset). Without this the pane would lock
  // on a stale id that no longer resolves.
  useEffect(() => {
    if (selectedSubagentTaskId && !subagentTasks[selectedSubagentTaskId]) {
      setSelected(sessionId ?? "", null);
    }
  }, [selectedSubagentTaskId, subagentTasks, sessionId, setSelected]);

  const isRunning = activeTask?.status === "running";

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      minHeight: 0, height: "100%",
      background: "var(--sidebar)",
    }}>
      {/* Header — task name + live status pulse */}
      <div style={{
        height: 40, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 12px",
        borderBottom: `1px solid var(--c-brd)`,
        gap: 8,
      }}>
        <span data-pane-handle="true" style={{
          flex: 1, minWidth: 0,
          fontSize: 12.5, fontWeight: 600, color: "var(--c-high)",
          letterSpacing: 0.1, cursor: "grab",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {activeTask ? activeTask.description : "Agent"}
          {isRunning && (
            <span style={{
              marginLeft: 8,
              fontSize: 10.5, fontFamily: "var(--font-mono)",
              color: "#22c55e", fontWeight: 500,
            }}>
              ● live
            </span>
          )}
        </span>
        <button
          onClick={() => requestClose?.("process")}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, borderRadius: 5,
            background: "transparent", border: "none",
            cursor: "pointer", color: "var(--c-ghost)",
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--c-srf)"; (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--c-ghost)"; }}
          title="Close pane"
        >
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>

      {/* Body */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scroll-subtle"
        style={{
          flex: 1, minHeight: 0, overflowY: "auto",
          padding: "16px 14px 12px",
        }}
      >
        {!activeTask ? (
          <div style={{
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            height: "100%", gap: 8, opacity: 0.5, textAlign: "center", padding: "0 24px",
          }}>
            <Activity size={22} color="var(--c-ghost)" />
            <span style={{ fontSize: 12, color: "var(--c-dim)" }}>
              No sub-agent activity yet
            </span>
            <span style={{ fontSize: 11, color: "var(--c-ghost)", lineHeight: 1.5 }}>
              When the agent dispatches a Task, its live activity appears here.
              Regular tools (Bash, Read, Edit…) stay inline in the chat.
            </span>
          </div>
        ) : (
          <SubagentContent task={activeTask} />
        )}
      </div>
    </div>
  );
}

/* Renders a sub-agent's prompt card + nested content blocks +
 * in-flight streaming buffers. Maps each content block kind to the
 * same primitives the main chat uses (text → markdown, tool_use →
 * ToolCallRow, thinking → ThinkingBlock) by wrapping them inside a
 * synthetic ChatMessage so MessageContent can render the lot.
 *
 * Fleet-dispatched workers run as their own sessions, and the worker
 * session has the FULL conversation in chat fidelity — including tool
 * inputs / outputs that the dispatch_stream events lose. When the
 * task's id matches a known session, we render that session's
 * messages directly (full detail). Otherwise we fall back to the
 * compact `task.content` log that Claude SDK Task tool / Codex
 * spawnAgent dispatches populate.
 */
function SubagentContent({ task }: { task: import("@/stores/chat-store").SubagentTask }) {
  // Stable refs — selectors that returned `??[]`/`find()` re-create a
  // value every render, so Zustand sees a new reference each tick and
  // re-runs the component forever. Pull the slice directly; let it be
  // `undefined` when missing and guard below.
  const workerSession = useAppStore(s => s.sessions.find(x => x.id === task.id));
  const workerSessionState = useChatStore(s => s.sessions[task.id]);
  const workerMessages = workerSessionState?.messages;
  const setMessages = useChatStore(s => s.setMessages);

  // When the task is backed by a real session (Fleet dispatch) but
  // chat-store hasn't loaded its messages yet (user never opened it),
  // pull them via the same /sessions/:id/messages endpoint chat-view
  // uses. Without this hydration the worker-mode branch sees an empty
  // messages list and falls back to the dispatch-stream log (which is
  // lossy — no tool inputs/outputs).
  const taskId = task.id;
  const needsFetch = !!workerSession && (!workerMessages || workerMessages.length === 0);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!needsFetch || fetchedFor === taskId) return;
    let cancelled = false;
    setFetchedFor(taskId);
    fetchMessages(taskId).then(rows => {
      if (cancelled) return;
      if (Array.isArray(rows) && rows.length > 0) {
        setMessages(taskId, rows as Parameters<typeof setMessages>[1]);
      }
    }).catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [taskId, needsFetch, fetchedFor, setMessages]);

  // Prefer the worker session's full chat history when available —
  // that's what surfaces every tool call with its real input + output,
  // every assistant turn, every file edit, every thinking block.
  // Falls back to the in-task `content` log for sub-agents that don't
  // have a session of their own.
  const useWorker = !!workerSession && !!workerMessages && workerMessages.length > 0;

  const synthetic = useMemo(() => ({
    id: `subagent-${task.id}`,
    role: "assistant" as const,
    content: task.content,
    timestamp: new Date(task.startedAt).toISOString(),
  }), [task.id, task.content, task.startedAt]);

  return (
    <>
      {/* Prompt card — mirrors how user-message bubbles look in chat
          (the parent's "Task" dispatch is conceptually the prompt the
          sub-agent is working on). description is the short title;
          full prompt isn't included in the SDK's TaskStartedMessage
          so the title is what we show. */}
      <div style={{
        background: "rgba(56,114,224,0.10)",
        border: "1px solid rgba(56,114,224,0.20)",
        borderRadius: 10,
        padding: "12px 14px",
        marginBottom: 16,
        color: "rgba(180,200,255,0.95)",
        fontSize: 13.5, lineHeight: 1.55, letterSpacing: -0.005,
      }}>
        {task.description}
        {task.taskType && (
          <div style={{
            marginTop: 6,
            fontSize: 10.5, fontFamily: "var(--font-mono)",
            color: "rgba(180,200,255,0.55)",
            letterSpacing: 0.04,
          }}>
            {task.taskType}
          </div>
        )}
      </div>

      {/* Content stream — when the task is backed by a real session
          we render that session's full chat history (every tool call
          with real input + output, every assistant turn). Otherwise
          fall back to the in-task content log for sub-agents that
          only stream through dispatch_stream. */}
      {useWorker ? (
        <>
          {workerMessages.map(m => (
            <div key={m.id} style={{ marginBottom: 12 }}>
              <MessageContent message={m} />
            </div>
          ))}
        </>
      ) : (
        <>
          {task.content.length > 0 && <MessageContent message={synthetic} />}
          {(task.streamingText || task.streamingThinking) && (
            <StreamingMessage
              text={task.streamingText}
              thinking={task.streamingThinking}
            />
          )}
        </>
      )}

      {/* Final summary banner when the task is done */}
      {task.status !== "running" && task.summary && (
        <div style={{
          marginTop: 16,
          padding: "10px 14px",
          background: "var(--c-srf)",
          border: "1px solid var(--c-brd)",
          borderRadius: 8,
          fontSize: 12, lineHeight: 1.55,
          color: "var(--c-med)",
        }}>
          <div style={{
            fontSize: 10.5, color: "var(--c-ghost)",
            letterSpacing: 0.08, textTransform: "uppercase",
            marginBottom: 6, fontFamily: "var(--font-mono)",
          }}>
            {task.status === "failed" ? "Failed" :
             task.status === "stopped" ? "Stopped" : "Summary"}
          </div>
          {task.summary}
        </div>
      )}
    </>
  );
}

function ProcessWorkspace({ sessionId }: { sessionId: string | null }) {
  const sessionState = useChatStore(selectSession(sessionId));
  const log = sessionState.processLog;
  const isStreaming = sessionState.isStreaming;
  const clearProcessLog = useChatStore(s => s.clearProcessLog);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Track whether the user has scrolled away; only auto-scroll when they're
  // pinned to the bottom so reviewing older events isn't yanked.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 40;
    pinnedToBottom.current = nearBottom;
  };

  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  const runningCount = useMemo(
    () => log.filter(e => e.status === "running").length,
    [log],
  );

  // Kind breakdown — "29 steps" alone tells you nothing about what
  // happened. A compact kind-count strip ("12 files · 8 search · 9 shell")
  // gives the at-a-glance shape of the run. Computed once per log
  // change; cheap because it's a single linear pass.
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of log) {
      const k = classifyTool(e.name).kind;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    // Order matches the typical reading: write/edit first, then reads,
    // then searches, then shell, then web/agent. Keeps the breakdown
    // stable across runs so the user's eye locks onto positions.
    const order: { kind: string; label: string }[] = [
      { kind: "file_edit", label: "edits" },
      { kind: "file_write", label: "writes" },
      { kind: "file_read", label: "reads" },
      { kind: "search", label: "search" },
      { kind: "bash", label: "shell" },
      { kind: "web", label: "web" },
      { kind: "subagent", label: "agents" },
      { kind: "todo", label: "todos" },
    ];
    return order
      .map(o => ({ ...o, count: counts[o.kind] ?? 0 }))
      .filter(o => o.count > 0);
  }, [log]);

  const reversed = log; // chronological: oldest → newest

  const isLive = isStreaming || runningCount > 0;

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0, background:"var(--card)" }}>
      {/* Header bar — bigger step count, kind breakdown, live pulse,
          Clear action. Was: a 30px strip with "29 steps Clear" looking
          like fine print. Now: 38px header where the step count is the
          headline and the kind breakdown carries real information. */}
      {(log.length > 0 || isLive) && (
        <div style={{
          flexShrink: 0, padding: "0 14px", height: 38,
          borderBottom: "1px solid var(--c-brd)",
          display: "flex", alignItems: "baseline", gap: 10,
        }}>
          {/* Headline: large tabular-nums step count */}
          <span style={{
            fontSize: 14, fontWeight: 600, color: "var(--c-high)",
            fontFamily: MONO, fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.01em",
          }}>
            {log.length}
          </span>
          <span style={{
            fontSize: 9.5, fontWeight: 600, color: "var(--c-low)",
            textTransform: "uppercase", letterSpacing: "0.08em",
          }}>
            steps
          </span>

          {/* Kind breakdown — only first 4 to keep the line tight */}
          {kindCounts.length > 0 && (
            <span style={{
              display: "flex", alignItems: "baseline", gap: 8,
              fontSize: 11, color: "var(--c-ghost)",
              fontVariantNumeric: "tabular-nums",
              overflow: "hidden",
            }}>
              <span style={{ color: "var(--c-brd2)" }}>·</span>
              {kindCounts.slice(0, 4).map((kc, i) => (
                <span key={kc.kind} style={{ display: "inline-flex", alignItems: "baseline", gap: 3 }}>
                  <span style={{ color: "var(--c-low)", fontWeight: 500 }}>{kc.count}</span>
                  <span>{kc.label}</span>
                  {i < kindCounts.slice(0, 4).length - 1 && (
                    <span style={{ marginLeft: 8, color: "var(--c-brd2)" }}>·</span>
                  )}
                </span>
              ))}
            </span>
          )}

          <div style={{ flex: 1 }}/>

          {/* Live indicator — moved right so the headline can breathe */}
          {isLive && (
            <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--c-high)" }}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: "var(--c-high)",
                animation: "agent-pulse 2s ease-in-out infinite",
              }}/>
              {runningCount > 0 ? `${runningCount} running` : "live"}
            </span>
          )}

          {log.length > 0 && !isLive && sessionId && (
            <button onClick={() => clearProcessLog(sessionId)} style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--c-ghost)", padding: 0,
              fontSize: 11, fontFamily: SANS,
              transition: "color 0.12s",
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-high)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-ghost)"; }}
            >Clear</button>
          )}
        </div>
      )}

      {log.length === 0 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
          <Activity size={16} style={{ color: "var(--c-dim)" }}/>
          <span style={{
            fontSize: 12, color: "var(--c-dim)", fontFamily: SANS,
            maxWidth: 240, textAlign: "center", lineHeight: 1.65,
          }}>
            Tool calls and shell commands appear here as the agent works.
          </span>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="scroll-subtle"
          style={{ flex:1, overflowY:"auto", padding:"6px 0 20px" }}
        >
          {reversed.map((ev, i) => {
            // Group consecutive same-kind rows visually. The divider
            // fires only when the kind transitions, so a streak of 5
            // file edits reads as one block and the next "shell"
            // command gets a clear break above it.
            const prev = i > 0 ? reversed[i - 1] : null;
            const groupStart = i > 0 && prev != null
              && classifyTool(prev.name).kind !== classifyTool(ev.name).kind;
            return <ProcessEventRow key={ev.id} ev={ev} groupStart={groupStart}/>;
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Full-panel terminal (no split) ─── */
function TerminalWorkspace({ cwd, termKey }: { cwd: string; termKey: string }) {
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0, background:"#0a0a0a" }}>
      <div style={{
        height:26, flexShrink:0, padding:"0 14px",
        display:"flex", alignItems:"center", gap:6,
        background:"#0d0d0d", borderBottom:"1px solid rgba(255,255,255,0.05)",
      }}>
        <TerminalIcon size={10} color="var(--muted-foreground)" opacity={0.45}/>
        <span style={{ fontSize:11, color:"rgba(255,255,255,0.45)", flex:1, fontFamily:SANS, letterSpacing:"0.02em" }}>Terminal</span>
        <span style={{ fontSize:10, color:"rgba(255,255,255,0.25)", fontFamily:MONO, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:320 }}>{cwd}</span>
      </div>
      <TerminalPanel key={termKey} termKey={termKey} cwd={cwd}/>
    </div>
  );
}

/* ─── Browser ─── */
function BrowserPanel() {
  const [url, setUrl]     = useState("http://localhost:3000");
  const [input, setInput] = useState("http://localhost:3000");
  const nav = (u: string) => { const t = /^https?:\/\//.test(u) ? u : "http://"+u; setUrl(t); setInput(t); };
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column" }}>
      <div style={{ height:32, display:"flex", alignItems:"center", gap:6, padding:"0 10px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <Globe size={10} color="var(--muted-foreground)" opacity={0.4}/>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key==="Enter"&&nav(input)}
          style={{ flex:1, background:"var(--c-srf)", border:"1px solid var(--c-brd)", borderRadius:5, padding:"3px 9px", fontSize:11.5, color:"var(--card-foreground)", fontFamily:MONO, outline:"none" }}
          placeholder="http://localhost:3000"/>
      </div>
      <iframe src={url} style={{ flex:1, border:"none" }} title="browser"
        sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"/>
    </div>
  );
}

/* ─── Tab Item ─── */
function TabItem({ tab, isActive, onSelect, onClose }: {
  tab: OpenTab; isActive: boolean;
  onSelect: (id: string) => void; onClose: (id: string) => void;
}) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={() => onSelect(tab.id)}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display:"flex", alignItems:"center", gap:5, padding:"0 10px 0 10px",
        cursor:"pointer", whiteSpace:"nowrap", flexShrink:0, position:"relative",
        background: isActive ? "var(--card)" : hov ? "var(--c-srf)" : "transparent",
        borderRight: `1px solid ${C.border}`,
        minWidth:90, maxWidth:180, userSelect:"none", height:"100%",
      }}
    >
      {/* active indicator */}
      {isActive && <span style={{ position:"absolute", bottom:0, left:0, right:0, height:1, background:"var(--c-med)" }}/>}
      <FileIcon name={tab.name}/>
      <span style={{ fontSize:12, fontFamily:SANS, flex:1, color: isActive ? "var(--foreground)" : "var(--muted-foreground)", overflow:"hidden", textOverflow:"ellipsis", opacity: isActive ? 0.9 : 0.5 }}>{tab.name}</span>
      <span onClick={e => { e.stopPropagation(); onClose(tab.id); }} style={{
        width:14, height:14, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center",
        borderRadius:3, cursor:"pointer", opacity: isActive||hov ? 0.5 : 0, color:"var(--muted-foreground)",
        transition:"opacity 0.1s",
      }}
        onMouseEnter={e => { e.currentTarget.style.opacity="1"; e.currentTarget.style.color="var(--foreground)"; }}
        onMouseLeave={e => { e.currentTarget.style.opacity="0.5"; e.currentTarget.style.color="var(--muted-foreground)"; }}
      ><X size={9}/></span>
    </div>
  );
}

/* ─── Terminal Resize Handle ─── */
function TermResizeHandle({ onDelta }: { onDelta: (dy: number) => void }) {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let last = e.clientY;
    const onMove = (ev: MouseEvent) => { onDelta(last - ev.clientY); last = ev.clientY; };
    const onUp   = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); document.body.style.cursor = ""; };
    document.body.style.cursor = "ns-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [onDelta]);

  return (
    <div onMouseDown={onMouseDown} style={{
      height:3, flexShrink:0, cursor:"ns-resize",
      background: C.border,
      transition:"background 0.15s",
    }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--c-brd2)")}
      onMouseLeave={e => (e.currentTarget.style.background = C.border)}
    />
  );
}


/* ─── Quadrant multi-pane workspace ──────────────────────────────────
 *
 * Default workspace layout when no specific file is open: a 2×2 grid
 * where four context panels render simultaneously (Diff / Tasks /
 * Files / Plan). Replaces the previous "single-view, switch via icon
 * rail" behaviour — that meant the user only ever saw ONE view at a
 * time and had to constantly toggle to keep tabs on parallel concerns
 * (file changes vs. agent tasks vs. plan vs. tree). The reference
 * design the user pointed at uses this multi-pane layout because it
 * matches how a real workspace gets used: many things at once.
 *
 * Each pane is closeable. Closing a pane just hides it from this
 * grid; remaining panes auto-redistribute via CSS grid. The activity
 * icon rail at top still works — clicking an icon swaps the WHOLE
 * workspace into single-view mode (full-bleed) for that view; click
 * the same icon again to return to the quadrant layout.
 * ─────────────────────────────────────────────────────────────── */

type PaneKind = "files" | "terminal" | "tasks";

const PANE_TITLE: Record<PaneKind, string> = {
  files: "Files",
  terminal: "Terminal",
  tasks: "Tasks",
};

function PaneHeader({
  title, onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <div style={{
      flexShrink: 0,
      height: 30, padding: "0 10px",
      display: "flex", alignItems: "center", gap: 6,
      background: "var(--card)",
      borderBottom: "1px solid var(--c-brd)",
    }}>
      <span style={{
        flex: 1,
        fontSize: 11.5, fontWeight: 600,
        color: "var(--c-low)",
        letterSpacing: "-0.005em",
        fontFamily: SANS,
      }}>
        {title}
      </span>
      <button
        onClick={onClose}
        title={`Hide ${title}`}
        style={{
          width: 18, height: 18,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "none", border: "none", cursor: "pointer",
          color: "var(--c-ghost)", borderRadius: 4,
          transition: "background 0.1s, color 0.1s",
        }}
        onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--c-srf)"; el.style.color = "var(--c-med)"; }}
        onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "none"; el.style.color = "var(--c-ghost)"; }}
      >
        <X size={11}/>
      </button>
    </div>
  );
}

function Pane({
  title, onClose, children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      background: "var(--card)",
      border: "1px solid var(--c-brd)",
      borderRadius: 8,
      overflow: "hidden",
      minWidth: 0, minHeight: 0,
    }}>
      <PaneHeader title={title} onClose={onClose}/>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
}

function QuadrantWorkspace({
  projectPath, sessionId, openFile, onAddPane,
}: {
  projectPath: string;
  sessionId: string | null;
  openFile: (e: FsEntry) => void;
  onAddPane?: (kind: PaneKind) => void;
}) {
  // Default 2x2 layout matching the user's reference: Files (top-left),
  // Tasks (top-right), Terminal (bottom). JSX order matters for
  // CSS grid auto-flow: row-first means [files, tasks, terminal]
  // places them in that order. The fourth slot (Task Detail
  // surface) was dropped along with the Process placeholder.
  const [open, setOpen] = useState<Record<PaneKind, boolean>>({
    files: true, terminal: true, tasks: true,
  });

  const visible = (Object.keys(open) as PaneKind[]).filter((k) => open[k]);
  useEffect(() => {
    if (visible.length === 0 && onAddPane) onAddPane("files");
  }, [visible.length, onAddPane]);

  const close = (k: PaneKind) => setOpen(o => ({ ...o, [k]: false }));

  // CSS grid auto-flow — panes flow row-first, so 4 visible = 2x2,
  // 3 visible = 2-up + 1-down, 2 visible = side by side, 1 = full.
  const cols = visible.length >= 2 ? "1fr 1fr" : "1fr";
  const rows = visible.length >= 3 ? "1fr 1fr" : "1fr";

  return (
    <div style={{
      flex: 1, minHeight: 0, padding: 10,
      display: "grid",
      gridTemplateColumns: cols,
      gridTemplateRows: rows,
      gap: 10,
      background: "var(--card)",
      overflow: "hidden",
    }}>
      {/* JSX order = grid placement (row-first). Keep this order to
          preserve the reference layout. */}
      {open.files && (
        <Pane title={PANE_TITLE.files} onClose={() => close("files")}>
          <FileTree root={projectPath} selectedPath="" onSelect={openFile}/>
        </Pane>
      )}
      {open.tasks && (
        <Pane title={PANE_TITLE.tasks} onClose={() => close("tasks")}>
          <TasksWorkspace sessionId={sessionId}/>
        </Pane>
      )}
      {open.terminal && (
        <Pane title={PANE_TITLE.terminal} onClose={() => close("terminal")}>
          <TerminalPanel cwd={projectPath} termKey={`quadrant-term-${sessionId ?? "global"}`}/>
        </Pane>
      )}
    </div>
  );
}


/* ─── Activity type ─── */
type Activity = WorkspaceView | "browser";

/* ══════════════════════════════════════════════════════════
   WorkspacePanel — Minimal IDE layout
   ┌────────────────────────────────────────────────────────┐
   │ Header (30px): activity icons | project | close        │
   ├──────────┬─────────────────────────────────────────────┤
   │ Sidebar  │ Tab bar (28px)                              │
   │ (180px)  ├─────────────────────────────────────────────┤
   │          │ Code viewer (flex 1)                        │
   │          ├─────────────────────────────────────────────┤
   │          │ ▲ resize handle (3px)                       │
   │          │ Terminal panel (resizable)                  │
   ├──────────┴─────────────────────────────────────────────┤
   │ Status bar (18px): branch · lang · lines               │
   └────────────────────────────────────────────────────────┘
══════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════
   WorkspacePanel — clean slate.

   Earlier this rendered a 7-pane editor + activity rail + tabs.
   The user asked to wipe it back to an empty card and rebuild
   each view (Preview / Diff / Terminal / Files / Tasks / Plan)
   one at a time. This is intentionally minimal — same outer
   shell as before so RightPanelWrapper keeps mounting it
   cleanly, but the content is just an empty surface for now.

   The supporting types, helpers, hooks, and child components
   above are kept in place: re-using them as views land back is
   cheaper than re-deriving them.
══════════════════════════════════════════════════════════ */
export function WorkspacePanel({ onClose: _onClose }: { onClose: () => void }) {
  // CRITICAL: `usePaneSessionId()` returns the global activeSessionId
  // as a fallback when there's no PaneSessionProvider above. So a
  // non-null pane id is NOT proof we're rendered inside a pane —
  // single-view always has an activeSessionId too. Branch on
  // `useIsInPane()` (which actually checks for the provider) and
  // only read the pane id afterwards. Last pass conflated the two
  // and broke the legacy right panel: single-view sessions hit the
  // pane branch with paneViewsById[id] === undefined → empty grid.
  const inPane = useIsInPane();
  const paneSid = usePaneSessionId();
  const globalOpenViews = useAppStore(s => s.openWorkspaceViews);
  const globalWorkspaceView = useAppStore(s => s.workspaceView);
  const paneViewsById = useAppStore(s => s.paneWorkspaceViews);

  const openViews = inPane && paneSid
    ? (paneViewsById[paneSid] ?? [])
    : globalOpenViews;

  // Backwards-compat: when nothing's been added to the grid yet but
  // legacy code still set `workspaceView`, treat that as a single-pane
  // grid so the panel doesn't go blank for older callers.
  const effectiveViews = openViews.length > 0
    ? openViews
    : (!inPane && globalWorkspaceView !== "editor" ? [globalWorkspaceView] : []);

  return (
    <div style={{
      height: "100%",
      display: "flex", flexDirection: "column",
      background: "transparent",
      overflow: "hidden",
    }}>
      <WorkspaceGrid views={effectiveViews} />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   WorkspaceGrid — tiles 1-4 workspace views in a CSS grid.

   Layout map (matches the user's "fill, then below, then right,
   then below" cascade):

      1 view:        2 views:       3 views:        4 views:
     ┌───────┐      ┌───────┐      ┌───┬───┐       ┌───┬───┐
     │       │      │   A   │      │ A │   │       │ A │ B │
     │   A   │      ├───────┤      ├───┤ C │       ├───┼───┤
     │       │      │   B   │      │ B │   │       │ C │ D │
     └───────┘      └───────┘      └───┴───┘       └───┴───┘

   The "editor" view is empty space — when it's the only thing in
   the grid we render nothing so the panel stays a quiet card.
   ══════════════════════════════════════════════════════════ */
/* Width below which a 2-/3-/4-pane grid feels cramped. Drops to a
   single vertical stack so each pane keeps usable horizontal space.
   ~480 is the threshold where the average diff line starts wrapping
   awkwardly in a column-split. */
const NARROW_BREAKPOINT = 480;

/* Context that lets nested panes request a *delayed* close. The grid
   intercepts the request, marks the pane for exit animation, then
   calls the real removeWorkspaceView store action after the
   animation completes. Each view's X button consumes this instead
   of calling removeWorkspaceView directly so closing reads as the
   inverse of opening (sliding out vs sliding in). */
const PaneCloseContext    = createContext<((v: WorkspaceView) => void) | null>(null);
const RightmostPaneContext = createContext<WorkspaceView | null>(null);
const CurrentPaneContext   = createContext<WorkspaceView | null>(null);
const PANE_EXIT_DURATION_MS = 200;

/* Assigns views to columns. Two rows max per column keeps panes
   legible; the rightmost column gets a single pane when count is odd. */
function buildColumns(views: WorkspaceView[]): WorkspaceView[][] {
  const n = views.length;
  if (n <= 2) return [views.slice()];
  if (n === 3) return [views.slice(0, 2), views.slice(2, 3)];
  if (n === 4) return [views.slice(0, 2), views.slice(2, 4)];
  if (n === 5) return [views.slice(0, 2), views.slice(2, 4), views.slice(4, 5)];
  return [views.slice(0, 2), views.slice(2, 4), views.slice(4, 6)];
}

function WorkspaceGrid({ views }: { views: WorkspaceView[] }) {
  const reorderWorkspaceView = useAppStore(s => s.reorderWorkspaceView);
  const removeWorkspaceView  = useAppStore(s => s.removeWorkspaceView);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [width, setWidth] = useState<number>(0);
  const [dragOver, setDragOver] = useState<WorkspaceView | null>(null);
  const [dragging, setDragging] = useState<WorkspaceView | null>(null);
  const [closing, setClosing] = useState<Set<WorkspaceView>>(() => new Set());

  const requestClose = useCallback((v: WorkspaceView) => {
    setClosing(prev => {
      if (prev.has(v)) return prev;
      const next = new Set(prev); next.add(v); return next;
    });
    window.setTimeout(() => {
      removeWorkspaceView(v);
      setClosing(prev => {
        if (!prev.has(v)) return prev;
        const next = new Set(prev); next.delete(v); return next;
      });
    }, PANE_EXIT_DURATION_MS);
  }, [removeWorkspaceView]);

  const columns = useMemo(() => buildColumns(views), [views]);
  const numCols = columns.length;

  // Per-column widths (flex ratios). Reset to equal when column count changes.
  const [colWidths, setColWidths] = useState<number[]>(() => Array(numCols).fill(1));
  useEffect(() => {
    setColWidths(prev => prev.length === numCols ? prev : Array(numCols).fill(1));
  }, [numCols]);

  // Per-column row splits. Index = column index; only used for 2-row columns.
  const [rowSplits, setRowSplits] = useState<number[]>([0.5, 0.5, 0.5]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(entries => {
      const e = entries[0]; if (e) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (views.length === 0) {
    // Friendly placeholder. Previously returned null → opening the
    // right sidebar with no view selected painted a totally blank
    // pane and looked broken. The chat header's panel-picker menu
    // (Files / Terminal / Diff / …) is the way back.
    return (
      <div style={{
        height: "100%",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        gap: 8, padding: "40px 24px",
        color: "var(--c-dim)",
        textAlign: "center",
      }}>
        <span style={{
          fontSize: 12.5, fontWeight: 600, color: "var(--c-med)",
        }}>
          Nothing open
        </span>
        <span style={{ fontSize: 11.5, color: "var(--c-ghost)", maxWidth: 260 }}>
          Use the panel menu in the chat header to open Files, Terminal, Diff, or another view.
        </span>
      </div>
    );
  }
  const narrow = width > 0 && width < NARROW_BREAKPOINT;
  const effectiveCols = narrow ? [views.slice()] : columns;

  // ── Resize drag handlers ──────────────────────────────────────────────────
  // Column: only the two flanking columns move; all others stay fixed.
  const startColResize = (colIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const totalWidth = container.getBoundingClientRect().width;
    const startX = e.clientX;
    const startWidths = [...colWidths];
    const onMove = (mv: MouseEvent) => {
      const delta = (mv.clientX - startX) / totalWidth;
      const a = Math.max(0.12, (startWidths[colIdx] ?? 1) + delta);
      const b = Math.max(0.12, (startWidths[colIdx + 1] ?? 1) - delta);
      const newWidths = [...startWidths];
      newWidths[colIdx] = a;
      newWidths[colIdx + 1] = b;
      setColWidths(newWidths);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true });
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Row: only this column's two rows resize; other columns are unaffected.
  const startRowResize = (colIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const col = colRefs.current[colIdx];
    if (!col) return;
    const totalHeight = col.getBoundingClientRect().height;
    const startY = e.clientY;
    const startSplit = rowSplits[colIdx] ?? 0.5;
    const onMove = (mv: MouseEvent) => {
      const delta = (mv.clientY - startY) / totalHeight;
      const newVal = Math.max(0.12, Math.min(0.88, startSplit + delta));
      setRowSplits(prev => { const next = [...prev]; next[colIdx] = newVal; return next; });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true });
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };
  // ─────────────────────────────────────────────────────────────────────────

  const handleStyle = (axis: "col" | "row"): React.CSSProperties => ({
    flexShrink: 0,
    ...(axis === "col" ? { width: 8 } : { height: 8 }),
    cursor: axis === "col" ? "col-resize" : "row-resize",
    background: "transparent",
    borderRadius: 4,
    zIndex: 5,
    transition: "background 0.1s",
  });

  const items: React.ReactNode[] = [];
  effectiveCols.forEach((col, ci) => {
    if (ci > 0 && !narrow) {
      items.push(
        <div
          key={`ch-${ci}`}
          style={handleStyle("col")}
          onMouseDown={(e) => startColResize(ci - 1, e)}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(167,139,250,0.18)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
        />
      );
    }

    const colRows: React.ReactNode[] = [];
    col.forEach((v, ri) => {
      if (ri > 0 && !narrow && col.length === 2) {
        colRows.push(
          <div
            key={`rh-${ci}-${ri}`}
            style={handleStyle("row")}
            onMouseDown={(e) => startRowResize(ci, e)}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(167,139,250,0.18)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          />
        );
      }

      const rs = rowSplits[ci] ?? 0.5;
      const flexVal = col.length !== 2 ? 1 : ri === 0 ? rs : 1 - rs;

      colRows.push(
        <div
          key={v}
          data-pane={v}
          style={{
            flex: flexVal,
            minHeight: 0, minWidth: 0,
            background: "var(--sidebar)",
            border: dragOver === v
              ? "1px solid rgba(167,139,250,0.65)"
              : "1px solid var(--c-brd)",
            borderRadius: 10,
            display: "flex", flexDirection: "column",
            overflow: "hidden",
            animation: closing.has(v)
              ? `fleet-pane-out ${PANE_EXIT_DURATION_MS}ms cubic-bezier(0.4, 0, 1, 1) forwards`
              : "fleet-pane-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both",
            boxShadow: dragOver === v
              ? "0 0 0 3px rgba(167,139,250,0.18), 0 4px 14px rgba(0,0,0,0.20)"
              : "0 1px 2px rgba(0,0,0,0.30), 0 4px 12px rgba(0,0,0,0.18)",
            opacity: dragging === v ? 0.4 : 1,
            transition: "border-color 0.12s, box-shadow 0.12s, opacity 0.12s",
            pointerEvents: closing.has(v) ? "none" : "auto",
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("application/fleet-pane")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dragOver !== v) setDragOver(v);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setDragOver(prev => prev === v ? null : prev);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const from = e.dataTransfer.getData("application/fleet-pane") as WorkspaceView;
            setDragOver(null); setDragging(null);
            if (from && from !== v) reorderWorkspaceView(from, v);
          }}
        >
          <CurrentPaneContext.Provider value={v}>
            <DraggableHandleScope
              view={v}
              onDragStart={setDragging}
              onDragEnd={() => { setDragging(null); setDragOver(null); }}
            >
              <WorkspacePane view={v} />
            </DraggableHandleScope>
          </CurrentPaneContext.Provider>
        </div>
      );
    });

    items.push(
      <div
        key={`col-${ci}`}
        ref={el => { colRefs.current[ci] = el; }}
        style={{
          display: "flex", flexDirection: "column",
          flex: narrow ? 1 : colWidths[ci],
          minWidth: 0, minHeight: 0,
        }}
      >
        {colRows}
      </div>
    );
  });

  const lastCol = effectiveCols[effectiveCols.length - 1] ?? [];
  const rightmostView = lastCol[lastCol.length - 1] ?? null;

  return (
    <PaneCloseContext.Provider value={requestClose}>
      <RightmostPaneContext.Provider value={rightmostView}>
        <div
          ref={containerRef}
          style={{
            flex: 1, minHeight: 0,
            display: "flex",
            flexDirection: narrow ? "column" : "row",
            padding: 0,
            background: "transparent",
          }}
        >
          {items}
        </div>
      </RightmostPaneContext.Provider>
    </PaneCloseContext.Provider>
  );
}

/* DraggableHandleScope — wraps a pane in a drag-source surface that
   activates ONLY when the user grabs from a child marked with
   data-pane-handle="true" (the pane header label). Without that
   gate, dragging from inside an editor or terminal would yank the
   whole pane around — annoying. With the gate, the rest of the
   pane behaves normally and the user has a clear visual handle. */
function DraggableHandleScope({
  view, children, onDragStart, onDragEnd,
}: {
  view: WorkspaceView;
  children: React.ReactNode;
  onDragStart: (v: WorkspaceView) => void;
  onDragEnd: () => void;
}) {
  // We bind drag handlers on a child wrapper. To detect "did this
  // start from a handle", we listen for mousedown bubbling up and
  // toggle `draggable` only when the source qualifies.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('[data-pane-handle="true"]')) setArmed(true);
      else setArmed(false);
    };
    el.addEventListener("mousedown", onDown);
    return () => el.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div
      ref={wrapRef}
      draggable={armed}
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
      onDragStart={(e) => {
        if (!armed) { e.preventDefault(); return; }
        e.dataTransfer.setData("application/fleet-pane", view);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(view);
      }}
      onDragEnd={() => { setArmed(false); onDragEnd(); }}
    >
      {children}
    </div>
  );
}


/* Routes a single view id to its renderer. Each renderer is
   responsible for its own header (TerminalView / DiffView already
   have one); placeholder views get a tiny empty-card with a close
   button so the user can still remove them from the grid. */
function WorkspacePane({ view }: { view: WorkspaceView }) {
  if (view === "terminal")  return <TerminalView />;
  if (view === "diff")      return <DiffView />;
  if (view === "files")     return <FilesView />;
  if (view === "file")      return <FileView />;
  if (view === "tasks")     return <TasksPaneRouter />;
  if (view === "memories")  return <MemoriesView />;
  if (view === "process")   return <ProcessPaneRouter />;
  // preview / editor — placeholder until each has a real
  // implementation. We still render the chrome so the user can
  // close the slot.
  return <PlaceholderView view={view} />;
}

/* Each agent-driven workspace (process / tasks) reads from the
 * pane's chat session. The pane-context hook gives us the right
 * session id whether the user is in a single-session layout or a
 * split-pane grid. Wrapping in a tiny router keeps the renderer
 * switch above declarative. */
function ProcessPaneRouter() {
  const sid = usePaneSessionId();
  return <AgentPaneView sessionId={sid} />;
}
function TasksPaneRouter() {
  // Tasks pane = card list of dispatched sub-agent tasks.
  const sid = usePaneSessionId();
  return <TaskCardsWorkspace sessionId={sid} />;
}

function PlaceholderView({ view }: { view: WorkspaceView }) {
  const requestClose = useContext(PaneCloseContext);
  const labels: Record<WorkspaceView, string> = {
    preview: "Preview", diff: "Diff", terminal: "Terminal",
    files: "Files", file: "File", tasks: "Tasks",
    memories: "Memories",
    process: "Agent",
    editor: "Editor",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{
        height: 44, flexShrink: 0,
        display: "flex", alignItems: "center",
        padding: "0 8px 2px 8px", gap: 4,
      }}>
        <span data-pane-handle="true" style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "#e6e6e6", letterSpacing: 0.1, cursor: "grab" }}>
          {labels[view] ?? view}
        </span>
        <TermActionBtn title="Close pane" onClick={() => requestClose?.(view)}>
          <X size={13} />
        </TermActionBtn>
      </div>
      <div style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        color: "#7a7a7a", fontSize: 12, fontFamily: SANS,
      }}>
        {labels[view]} — coming soon
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   TerminalView — agent-side terminal surface.

   Layout:

     ┌──────────────────────────────────────────────────────┐
     │ [Terminal] [+]              [×]│[⊟] [×]              │  44px tab/action bar
     ├──────────────────────────────────────────────────────┤
     │                                                      │
     │   $ command output …                                 │
     │                                                      │  flex:1 scroll surface
     │                                                      │
     └──────────────────────────────────────────────────────┘

   Tab bar mirrors the left sidebar's 44px header height for visual
   parity, so the chat-header / sidebar-header / panel-tab-strip all
   sit on the same row across the window. Tab pill uses the same
   --c-srf surface tokens the rest of the app uses for "active" chips,
   so theming follows automatically.

   Rendering of actual terminal output lands later — this iteration
   nails the chrome (tabs, actions, frame) and mounts a placeholder
   stream so the surface reads correctly at first paint.
   ══════════════════════════════════════════════════════════ */
function TerminalView() {
  const requestClose = useContext(PaneCloseContext);

  // Resolve the cwd the shell should open in. Preference order:
  //   1. The active session's worktree path  (per-PR isolated checkout)
  //   2. The active session's project path   (the repo root the user picked)
  //   3. undefined → main.cjs falls back to $HOME
  // This is what makes the terminal "open in the right place" — the
  // shell lands in the same directory the agent is editing in.
  const _paneSid_cwd = usePaneSessionId();
  const activeCwd = useAppStore(s => {
    const id = _paneSid_cwd ?? s.activeSessionId;
    if (!id) return undefined;
    const sess = s.sessions.find(x => x.id === id);
    return sess?.worktree_path || sess?.project_path || undefined;
  });

  // Session list — one entry per terminal. Only the active one is
  // visible at a time; the others stay mounted but hidden (display:
  // none) so their PTY + scrollback survive across switches. The
  // "Terminal N" pill in the header opens a dropdown to switch.
  const [terms, setTerms] = useState<{ id: string; label: string }[]>([
    { id: "t1", label: "Terminal 1" },
  ]);
  const [activeTermId, setActiveTermId] = useState("t1");
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  // Inline rename state — when set, the trigger swaps to an <input>
  // bound to the named terminal. Enter/blur commits, Escape cancels.
  // Used because Electron's window.prompt is gated by default in the
  // renderer's contextIsolation settings and was no-op'ing here.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const addTerminal = () => {
    const id = `t${Date.now()}`;
    setTerms(t => [...t, { id, label: `Terminal ${t.length + 1}` }]);
    setActiveTermId(id);
    setPickerOpen(false);
  };
  const closeTerminal = (id: string) => {
    setTerms(t => {
      const next = t.filter(x => x.id !== id);
      if (next.length === 0) {
        // Last terminal closed → drop the Terminal pane out of the
        // workspace grid. requestClose animates the pane removal.
        requestClose?.("terminal");
        return [{ id: "t1", label: "Terminal 1" }];
      }
      // If the active one is gone, fall back to the last remaining.
      if (id === activeTermId) {
        const cur = next[next.length - 1];
        if (cur) setActiveTermId(cur.id);
      }
      return next;
    });
  };

  const activeTerm = terms.find(t => t.id === activeTermId) ?? terms[0];

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 0,
      background: "var(--sidebar)",
    }}>
      {/* ── Single toolbar — Cursor / VS Code terminal-strip shape.
          Left: drag handle + "Terminal N ⌄" picker + thin separator + "+"
          Right: "×" to drop the pane out of the workspace grid.
          No separate "Terminals" header row above this — the picker
          itself names the active session. */}
      <div ref={pickerRef} style={{
        height: 36, flexShrink: 0,
        display: "flex", alignItems: "center",
        padding: "0 8px 0 2px",
        gap: 1,
        position: "relative",
      }}>
        <div data-pane-handle="true" style={{
          width: 4, alignSelf: "stretch",
          cursor: "grab", flexShrink: 0,
        }} title="Drag to rearrange" />

        {renaming ? (
          <input
            ref={renameInputRef}
            value={renaming.value}
            onChange={e => setRenaming(r => r ? { ...r, value: e.target.value } : r)}
            onBlur={() => {
              const v = renaming.value.trim();
              if (v) setTerms(list => list.map(x => x.id === renaming.id ? { ...x, label: v } : x));
              setRenaming(null);
            }}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
              else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
            }}
            style={{
              padding: "3px 8px",
              background: "var(--c-srf)",
              border: "1px solid var(--c-brd2)", outline: "none", borderRadius: 5,
              color: "#e0e0e0",
              fontSize: 11.5, fontWeight: 500,
              fontFamily: SANS, letterSpacing: 0.1,
              width: 160,
            }}
          />
        ) : (
          <button
            onClick={() => setPickerOpen(o => !o)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "3px 6px 3px 8px",
              background: pickerOpen ? "var(--c-srf2)" : "transparent",
              border: "none", outline: "none", borderRadius: 5,
              color: "#e0e0e0",
              cursor: "pointer",
              fontSize: 11.5, fontWeight: 500,
              fontFamily: SANS, letterSpacing: 0.1,
              transition: "background 0.1s",
            }}
            onMouseEnter={e => { if (!pickerOpen) e.currentTarget.style.background = "var(--c-srf)"; }}
            onMouseLeave={e => { if (!pickerOpen) e.currentTarget.style.background = "transparent"; }}
          >
            {/* Single-terminal case → just "Terminal". The numbered
                label only earns its keep when there are siblings. */}
            <span>{terms.length > 1 ? (activeTerm?.label ?? "Terminal") : "Terminal"}</span>
            <ChevronDown
              size={10}
              style={{
                color: "#9a9a9a",
                transform: pickerOpen ? "rotate(180deg)" : "none",
                transition: "transform 0.14s",
              }}
            />
          </button>
        )}

        <span aria-hidden style={{ width: 1, height: 12, background: "var(--c-brd)", margin: "0 2px" }} />

        <button
          onClick={addTerminal}
          title="New terminal"
          onMouseDown={e => e.preventDefault()}
          style={{
            width: 18, height: 18, borderRadius: 4,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "none", border: "none", outline: "none",
            color: "#8D8D8D", cursor: "pointer",
            transition: "background 0.1s, color 0.1s",
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--c-brd)"; e.currentTarget.style.color = "#e0e0e0"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#8D8D8D"; }}
        >
          <Plus size={11} />
        </button>

        <div style={{ flex: 1 }} />

        <TermActionBtn
          title="Close terminal pane"
          onClick={() => requestClose?.("terminal")}
        >
          <X size={13} />
        </TermActionBtn>

        {pickerOpen && (
          <div style={{
            position: "absolute", left: 12, top: "calc(100% + 2px)",
            zIndex: 30, minWidth: 180,
            background: "var(--popover, #161616)",
            border: "1px solid var(--c-brd)",
            borderRadius: 7,
            padding: 3,
            boxShadow: "0 8px 24px rgba(0,0,0,0.42)",
            fontFamily: SANS,
          }}>
            {/* "Terminals" caption + the session list — only meaningful
                when there are 2+ to switch between, so we hide the
                whole strip in the single-terminal case. The action
                buttons below stay reachable either way. */}
            {terms.length > 1 && (
              <div style={{
                padding: "4px 8px 3px",
                fontSize: 10.5, color: "#7a7a7a", fontWeight: 500,
              }}>Terminals</div>
            )}

            {terms.length > 1 && terms.map(t => {
              const active = t.id === activeTermId;
              return (
                <div
                  key={t.id}
                  onClick={() => { setActiveTermId(t.id); setPickerOpen(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "4px 8px",
                    background: "transparent",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 11.5, fontWeight: 400,
                    color: "#d0d0d0",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--c-srf)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <span style={{ flex: 1 }}>{t.label}</span>
                  {active ? (
                    <Check size={10} style={{ color: "#9a9a9a", flexShrink: 0 }} />
                  ) : (
                    <button
                      onClick={e => { e.stopPropagation(); closeTerminal(t.id); }}
                      onMouseDown={e => e.preventDefault()}
                      title="Close terminal"
                      style={{
                        width: 16, height: 16, borderRadius: 3,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        background: "none", border: "none", outline: "none",
                        color: "#8D8D8D", cursor: "pointer",
                        flexShrink: 0,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = "#f87171"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = "#8D8D8D"; }}
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              );
            })}

            {terms.length > 1 && (
              <div style={{ height: 1, background: "var(--c-brd)", margin: "3px 0" }} />
            )}

            <button
              onClick={() => { addTerminal(); setPickerOpen(false); }}
              onMouseDown={e => e.preventDefault()}
              style={pickerActionStyle}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              New terminal
            </button>
            <button
              onClick={() => {
                const cur = activeTerm;
                if (!cur) return;
                // Inline rename via trigger swap — avoids window.prompt
                // which is gated in Electron's renderer by default.
                setPickerOpen(false);
                setRenaming({ id: cur.id, value: cur.label });
              }}
              onMouseDown={e => e.preventDefault()}
              style={pickerActionStyle}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              Rename terminal
            </button>
          </div>
        )}
      </div>

      {/* ── Live shells ──
          One XtermShell per session, kept mounted so PTY + scrollback
          survive across switches. display:none hides the inactive ones
          without tearing them down. */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--sidebar)" }}>
        {terms.map(t => (
          <div
            key={t.id}
            style={{
              position: "absolute", inset: 0,
              display: t.id === activeTermId ? "block" : "none",
            }}
          >
            <XtermShell cwd={activeCwd} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* Bottom-row action button style for the terminal picker dropdown
   ("New terminal" / "Rename terminal"). Mirrors the menu-item idiom
   the rest of the dropdown uses but is full-width and left-aligned
   so it reads as a command rather than a list entry. */
const pickerActionStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "4px 8px",
  background: "transparent",
  border: "none", outline: "none", borderRadius: 4,
  color: "#d8d8d8",
  fontSize: 11.5, fontWeight: 500,
  fontFamily: SANS, letterSpacing: 0.1,
  cursor: "pointer", textAlign: "left",
};

function TermActionBtn({
  title, onClick, disabled, children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      onMouseDown={e => e.preventDefault()}
      style={{
        width: 22, height: 22, borderRadius: 5,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "none", border: "none", outline: "none",
        color: "#8D8D8D",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.background = "var(--c-brd)"; e.currentTarget.style.color = "#e0e0e0"; } }}
      onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#8D8D8D"; }}
    >
      {children}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════
   DiffView — git working-tree diff surface.

   Layout mirrors TerminalView so the chrome reads as one family:
   44px header with a quiet label on the left, action buttons on
   the right, then a scrollable body. Per-file diffs render
   inline (no nested tabs) — for a working tree this is usually
   1-5 files, and a single scroll feels closer to Cursor's
   "Source Control diff" pane than tab-per-file would.

   Color map (matches xterm theme so the panels feel consistent):
     - additions:  fg #4ade80 on bg rgba(74,222,128,0.08)
     - deletions:  fg #ff8888 on bg rgba(255,107,107,0.08)
     - hunk hdrs:  fg #60a5fa, italic
     - meta lines: dim #8D8D8D
     - line nums:  #5a5a5a, monospace, fixed gutter

   Data path:
     1. Resolve cwd from active session (worktree path → project_path)
     2. apiGitDiff(cwd) returns unified diff
     3. parseUnifiedDiff() yields files[] with line records
     4. Render each file as <FileBlock /> with sticky header
   ══════════════════════════════════════════════════════════ */
function DiffView() {
  const requestClose = useContext(PaneCloseContext);

  const _paneSid_cwd = usePaneSessionId();
  const activeCwd = useAppStore(s => {
    const id = _paneSid_cwd ?? s.activeSessionId;
    if (!id) return undefined;
    const sess = s.sessions.find(x => x.id === id);
    return sess?.worktree_path || sess?.project_path || undefined;
  });

  const [raw, setRaw] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");
  // Scope is fixed at "auto" — the segmented pill was removed from the
  // toolbar at the user's request. Reintroduce a picker (or a settings
  // toggle) later if branch-only / working-only views are needed.
  const scope: DiffScope = "auto";
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);

  // Fetch the current branch so the toolbar can show "base → branch".
  useEffect(() => {
    if (!activeCwd) { setCurrentBranch(null); return; }
    let cancelled = false;
    apiGit(activeCwd).then(g => {
      if (!cancelled) setCurrentBranch(g.branch ?? null);
    });
    return () => { cancelled = true; };
  }, [activeCwd]);

  const refresh = useCallback(() => {
    if (!activeCwd) return;
    setLoading(true); setErr("");
    apiGitDiff(activeCwd, undefined, scope).then(r => {
      if (r.error) setErr(r.error);
      else {
        setRaw(r.diff ?? "");
        setBaseBranch(r.baseBranch ?? null);
      }
      setLoading(false);
    });
  }, [activeCwd, scope]);

  // Initial fetch + refetch on cwd change.
  useEffect(() => { refresh(); }, [refresh]);

  const files = useMemo(() => parseUnifiedDiff(raw), [raw]);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 0,
      background: "var(--sidebar)",
    }}>
      {/* ── Toolbar ──
          [📁 base → current] (or just current if on main) ......
          [×]. Padded so the folder icon sits at x≈12 — same x as
          the chevrons in the file headers below, so the eye lands
          on a single left edge from toolbar through file list. */}
      <div style={{
        height: 36, flexShrink: 0,
        display: "flex", alignItems: "center",
        padding: "0 8px 0 0",
        gap: 0,
      }}>
        <div data-pane-handle="true" style={{
          width: 4, alignSelf: "stretch",
          cursor: "grab", flexShrink: 0,
        }} title="Drag to rearrange" />

        {currentBranch && (() => {
          // Resolve the base branch to show in front of the arrow. The
          // diff API only returns it when scope=branch, so for working-
          // tree diffs we'd otherwise fall back to just the current
          // branch. Default to "main" when nothing is known so the
          // label is always "base → current" (the slash in branch
          // names like `fleet/proton-ef05cbe4` was getting mistaken
          // for the separator). When the user IS on the base branch
          // itself, drop the arrow entirely.
          const effectiveBase = baseBranch ?? "main";
          const showArrow = effectiveBase !== currentBranch;
          return (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "3px 8px",
              fontFamily: MONO,
              fontSize: 12, fontWeight: 500,
              color: "#e0e0e0",
              letterSpacing: -0.1,
              minWidth: 0, overflow: "hidden",
            }}>
              <FolderOpen size={12} style={{ color: "#9a9a9a", flexShrink: 0 }} />
              {showArrow ? (
                <>
                  <span style={{
                    color: "#9a9a9a",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{effectiveBase}</span>
                  <ArrowRight size={12} strokeWidth={2} style={{ color: "#9a9a9a", flexShrink: 0 }} />
                  <span style={{
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{currentBranch}</span>
                </>
              ) : (
                <span style={{
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{currentBranch}</span>
              )}
            </span>
          );
        })()}

        <div style={{ flex: 1 }} />

        <TermActionBtn title="Close diff pane" onClick={() => requestClose?.("diff")}>
          <X size={13} />
        </TermActionBtn>
      </div>

      {/* ── Body ──
          One scroll surface, files stacked. Each file gets a sticky
          header so the user always knows what they're looking at
          while scrolling through long diffs. */}
      <div className="scroll-subtle" style={{
        flex: 1, minHeight: 0, overflowY: "auto",
        background: "var(--sidebar)",
        fontFamily: MONO, fontSize: 11.5, lineHeight: 1.55,
      }}>
        {!activeCwd && (
          <DiffEmptyState
            icon={<GitBranch size={20} color="#5a5a5a" />}
            title="No active project"
            hint="Open a session to see its working-tree diff."
          />
        )}
        {activeCwd && loading && (
          <DiffEmptyState hint="Loading diff…" />
        )}
        {activeCwd && !loading && err && /not a git repository/i.test(err) && (
          <DiffEmptyState
            icon={<GitBranch size={20} color="#9a9a9a" />}
            title="Not a git repository"
            hint="This folder isn't tracked by git, so there's nothing to diff. Initialise it with `git init` (or open a project that already has git) to see changes here."
            cwd={activeCwd}
          />
        )}
        {activeCwd && !loading && err && !/not a git repository/i.test(err) && (
          <DiffEmptyState
            icon={<AlertCircle size={20} color="#ff8888" />}
            title="Diff failed"
            hint={err}
            cwd={activeCwd}
          />
        )}
        {activeCwd && !loading && !err && files.length === 0 && (
          <DiffEmptyState
            icon={<CheckCircle2 size={20} color="#4ade80" opacity={0.8} />}
            title="Working tree clean"
            hint={baseBranch
              ? `No commits ahead of ${baseBranch} and no uncommitted changes.`
              : "Nothing changed — working tree clean and branch even with base."}
          />
        )}
        {activeCwd && !loading && !err && files.length > 0 && (
          files.map((f, i) => <DiffFileBlock key={`${f.file}-${i}`} file={f} />)
        )}
      </div>
    </div>
  );
}

/* (DiffScopePill removed — toolbar no longer surfaces scope picking.
    `scope` is pinned to "auto" inside DiffView, which is the most
    useful default for a quick at-a-glance diff. Reintroduce here when
    we need a Working/Branch toggle back in the UI.) */

/* Empty / loading / error placeholder shared by all three states.
   Vertically centered, restrained color, no busy spinner — matches
   the quiet "Working tree clean" pattern from GitPanel.

   When `cwd` is supplied we render a tiny mono pill underneath so the
   user can see exactly which folder we asked git about. Saves them
   guessing whether the wrong project was being inspected. */
function DiffEmptyState({
  icon, title, hint, cwd,
}: { icon?: React.ReactNode; title?: string; hint: string; cwd?: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      gap: 8, padding: "60px 20px",
      color: "#9a9a9a",
    }}>
      {icon}
      {title && (
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#c8c8c8", fontFamily: SANS }}>{title}</span>
      )}
      <span style={{
        fontSize: 11.5, color: "#7a7a7a", fontFamily: SANS,
        textAlign: "center", maxWidth: 420, lineHeight: 1.5,
        whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>{hint}</span>
      {cwd && (
        <span style={{
          marginTop: 6, padding: "3px 8px",
          fontSize: 10.5, fontFamily: MONO,
          color: "#8D8D8D",
          background: "var(--c-srf2)",
          border: "1px solid var(--c-brd)",
          borderRadius: 4,
          maxWidth: "90%",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          direction: "rtl", textAlign: "left",
        }}>{cwd}</span>
      )}
    </div>
  );
}

/* One file in the diff. Sticky header reads as the section title;
   below it the lines render with a fixed-width line-number gutter
   so additions and deletions align. */
function DiffFileBlock({ file }: { file: { file: string; lines: DiffLine[] } }) {
  const [collapsed, setCollapsed] = useState(false);
  const adds = file.lines.filter(l => l.kind === "add").length;
  const dels = file.lines.filter(l => l.kind === "del").length;
  return (
    // No borderTop — used to render a separator under the toolbar /
    // between files; user explicitly wants the toolbar to flow into
    // the file list without a dividing line.
    <div>
      {/* Sticky file header */}
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{
          position: "sticky", top: 0, zIndex: 1,
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px",
          background: "var(--sidebar)",
          borderBottom: collapsed ? "none" : "1px solid var(--c-brd)",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <ChevronRight
          size={11}
          color="#8D8D8D"
          style={{
            transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
            transition: "transform 0.12s",
            flexShrink: 0,
          }}
        />
        <span style={{
          fontSize: 11.5, fontFamily: MONO, color: "#e6e6e6",
          flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{file.file}</span>
        {adds > 0 && <span style={{ fontSize: 11, color: "#4ade80", fontFamily: MONO }}>+{adds}</span>}
        {dels > 0 && <span style={{ fontSize: 11, color: "#ff8888", fontFamily: MONO }}>−{dels}</span>}
      </div>

      {/* Lines */}
      {!collapsed && file.lines.map((line, idx) => (
        <DiffLineRow key={idx} line={line} />
      ))}
    </div>
  );
}

/* Single diff line. Fixed left gutter holds old/new line numbers,
   then the content with kind-specific bg/fg. Whitespace preserved
   via white-space: pre. */
function DiffLineRow({ line }: { line: DiffLine }) {
  const isAdd = line.kind === "add";
  const isDel = line.kind === "del";
  const isHunk = line.kind === "hunk";
  const isMeta = line.kind === "meta";

  let bg = "transparent";
  let fg = "#c8c8c8";
  let prefix = " ";
  if (isAdd)       { bg = "rgba(74,222,128,0.08)"; fg = "#86efac"; prefix = "+"; }
  else if (isDel)  { bg = "rgba(255,107,107,0.08)"; fg = "#ff8888"; prefix = "−"; }
  else if (isHunk) { bg = "rgba(96,165,250,0.06)"; fg = "#60a5fa"; prefix = " "; }
  else if (isMeta) { fg = "#7a7a7a"; }

  // Hunk and meta lines don't carry line numbers (they're scaffolding).
  const showNums = !isHunk && !isMeta;
  const oldNum = isAdd ? "" : (line.oldN ?? "");
  const newNum = isDel ? "" : (line.newN ?? "");

  return (
    <div style={{
      display: "flex",
      background: bg,
      color: fg,
      fontStyle: isHunk ? "italic" : "normal",
    }}>
      {/* Gutter: old | new line numbers, fixed widths so columns align */}
      {showNums ? (
        <>
          <span style={{
            width: 44, padding: "0 6px 0 10px", textAlign: "right",
            color: "#5a5a5a", fontFamily: MONO, flexShrink: 0,
            userSelect: "none",
          }}>{oldNum}</span>
          <span style={{
            width: 44, padding: "0 6px 0 0", textAlign: "right",
            color: "#5a5a5a", fontFamily: MONO, flexShrink: 0,
            userSelect: "none",
          }}>{newNum}</span>
        </>
      ) : (
        <span style={{ width: 88, flexShrink: 0 }} />
      )}
      <span style={{
        width: 14, textAlign: "center", flexShrink: 0,
        color: isAdd ? "#4ade80" : isDel ? "#ff6b6b" : "transparent",
        userSelect: "none",
      }}>{prefix}</span>
      <span style={{
        flex: 1, whiteSpace: "pre",
        paddingRight: 12, overflow: "hidden",
      }}>{line.text}</span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   FilesView — project file tree.

   Header mirrors TerminalView / DiffView (44px, picker + close
   buttons on the right). Body is a lazy file-tree: each folder is
   rendered collapsed by default and only fetches its children
   when the user expands it. Filter input at the top narrows the
   visible set by name (subset match — typing "ts" surfaces every
   .ts file in expanded folders).

   Rooted at the active session's worktree_path → project_path,
   matching how Terminal / Diff resolve their cwd.
   ══════════════════════════════════════════════════════════ */
function FilesView() {
  const requestClose = useContext(PaneCloseContext);
  const _paneSid_cwd = usePaneSessionId();
  // Read BOTH paths so we can self-heal a broken worktree (effect
  // below). Two separate selectors — combining them into one selector
  // that returns a fresh object literal would re-fire on every
  // unrelated store update and tank the panel's render perf.
  const worktreePath = useAppStore(s => {
    const id = _paneSid_cwd ?? s.activeSessionId;
    if (!id) return undefined;
    return s.sessions.find(x => x.id === id)?.worktree_path || undefined;
  });
  const projectPath = useAppStore(s => {
    const id = _paneSid_cwd ?? s.activeSessionId;
    if (!id) return undefined;
    return s.sessions.find(x => x.id === id)?.project_path || undefined;
  });
  const preferred = worktreePath || projectPath;
  const [effectiveCwd, setEffectiveCwd] = useState<string | undefined>(preferred);

  // Reset to preferred whenever the active session changes.
  useEffect(() => { setEffectiveCwd(preferred); }, [preferred]);

  // Self-heal: if the preferred root lists empty AND project_path is
  // a different path, retry with project_path so the panel never
  // surfaces "(empty)" on a session that demonstrably has files.
  useEffect(() => {
    if (!worktreePath || !projectPath || worktreePath === projectPath) return;
    let cancelled = false;
    apiDir(worktreePath).then(res => {
      if (cancelled) return;
      if (res.length === 0) setEffectiveCwd(projectPath);
    });
    return () => { cancelled = true; };
  }, [worktreePath, projectPath]);

  const activeCwd = effectiveCwd;

  const [filter, setFilter] = useState("");
  // Manual refresh — bumps the key passed to FileTreeNode which
  // forces a fresh apiDir call. Saves the user from a stuck "Loading…"
  // if a fetch races a drag-reorder or a network blip.
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 0,
      background: "var(--sidebar)",
    }}>
      {/* ── Header ── */}
      <div style={{
        height: 44, flexShrink: 0,
        display: "flex", alignItems: "center",
        padding: "0 8px 2px 8px",
        gap: 4,
      }}>
        <span data-pane-handle="true" style={{
          flex: 1, fontSize: 12.5, fontWeight: 600, color: "#e6e6e6",
          letterSpacing: 0.1, cursor: "grab",
        }}>Files</span>
        <TermActionBtn title="Refresh" onClick={() => setRefreshKey(k => k + 1)}>
          <RefreshCw size={13} />
        </TermActionBtn>
        <TermActionBtn title="Close files pane" onClick={() => requestClose?.("files")}>
          <X size={13} />
        </TermActionBtn>
      </div>

      {/* ── Filter input — full-width, focus-ringed, with a visible
          shortcut hint. Uses the global focus class so the same
          purple ring used by the PR dialog inputs lights up here
          for visual consistency. */}
      <div style={{
        flexShrink: 0,
        padding: "0 10px 10px",
      }}>
        <FilterInput value={filter} onChange={setFilter} />
      </div>

      {/* ── Tree body ── */}
      <div className="scroll-subtle" style={{
        flex: 1, minHeight: 0, overflowY: "auto",
        padding: "0 4px 8px",
      }}>
        {!activeCwd ? (
          <div style={{
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            gap: 8, padding: "60px 20px",
            color: "#9a9a9a",
          }}>
            <Folder size={20} color="#5a5a5a" />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "#c8c8c8", fontFamily: SANS }}>
              No active project
            </span>
            <span style={{ fontSize: 11.5, color: "#7a7a7a", fontFamily: SANS, textAlign: "center" }}>
              Open a session to browse its files.
            </span>
          </div>
        ) : (
          <FileTreeNode path={activeCwd} depth={0} filter={filter} refreshKey={refreshKey} />
        )}
      </div>
    </div>
  );
}

/* Search input shared by FilesView (and reusable for any future
   pane that needs a filter). Focus state lifts the ring color to
   the project's purple accent so it reads as "active". The ⌘F-style
   keyboard hint quietly tucks into the right edge — present until
   the user types, then replaced by the clear-button. */
function FilterInput({
  value, onChange,
}: { value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "4px 8px",
      background: focused ? "var(--c-srf)" : "var(--c-srf2)",
      border: focused
        ? "1px solid var(--c-brd2)"
        : "1px solid var(--c-brd)",
      borderRadius: 6,
      transition: "background 0.12s, border-color 0.12s",
    }}>
      <Search size={11} color={focused ? "var(--c-fg)" : "var(--c-dim)"} style={{ flexShrink: 0 }} />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Filter files… (?text to search contents)"
        spellCheck={false}
        style={{
          flex: 1, minWidth: 0,
          background: "transparent", border: "none", outline: "none",
          color: "#d4d4d4", fontSize: 11.5, fontFamily: SANS,
          fontWeight: 400,
        }}
      />
      {value ? (
        <button
          onClick={() => onChange("")}
          title="Clear"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 16, height: 16, borderRadius: 4,
            background: "rgba(255,255,255,0.06)",
            border: "none", outline: "none",
            color: "#9a9a9a", cursor: "pointer",
            transition: "color 0.1s, background 0.1s",
            flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.12)"; e.currentTarget.style.color = "#e6e6e6"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "#9a9a9a"; }}
        >
          <X size={10} />
        </button>
      ) : (
        <span style={{
          fontSize: 10, color: "#5a5a5a",
          fontFamily: MONO, padding: "1px 5px",
          border: "1px solid var(--c-brd)", borderRadius: 3,
          flexShrink: 0,
        }}>⌘F</span>
      )}
    </div>
  );
}

/* Lazy tree node — fetches children only when first opened. The
   root node mounts open=true so the project's top level is visible
   at first paint. Cache lives on the node's local state, so when
   the user collapses + reopens a folder we re-render without
   re-fetching, but a full pane unmount drops the cache (matching
   the user's expectation of a fresh tree on reopen). */
function FileTreeNode({
  path, depth, filter, refreshKey,
}: {
  path: string;
  depth: number;
  filter: string;
  refreshKey?: number;
}) {
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch via a request-id ref so out-of-order responses can't
  // overwrite a newer one. Earlier we used a `cancelled` boolean +
  // strict-mode double-mount + drag re-renders sometimes left the
  // tree stuck on "Loading…" because the pre-cleanup fetch came
  // back AFTER cleanup had cancelled it but BEFORE the next mount
  // had a chance to run a fresh fetch. The ref-based version always
  // accepts the LATEST request and ignores stale ones.
  const reqIdRef = useRef(0);
  // First load + manual refresh — trigger the loading spinner.
  useEffect(() => {
    const myId = ++reqIdRef.current;
    setLoading(true);
    apiDir(path).then(res => {
      if (myId !== reqIdRef.current) return;
      const sorted = sortEntries(res);
      setEntries(sorted);
      setLoading(false);
    });
  }, [path, refreshKey]);

  // ── Background poll ──
  // Only open folders are mounted (collapsed folders unmount their
  // children), so each visible level polls itself every 4 s and we
  // never poll branches the user can't see. Diff-then-set keeps
  // unchanged trees from triggering re-renders / Loading flickers.
  useEffect(() => {
    const id = window.setInterval(() => {
      const myId = ++reqIdRef.current;
      apiDir(path).then(res => {
        if (myId !== reqIdRef.current) return;
        const sorted = sortEntries(res);
        setEntries(prev => entriesEqual(prev, sorted) ? prev : sorted);
      });
    }, 4_000);
    return () => window.clearInterval(id);
  }, [path]);

  const lowerFilter = filter.toLowerCase();
  const matchesFilter = (name: string) =>
    !lowerFilter || name.toLowerCase().includes(lowerFilter);

  const visible = entries?.filter(e => {
    if (!lowerFilter) return true;
    if (e.type === "folder") return true; // always show folders so user can drill
    return matchesFilter(e.name);
  }) ?? null;

  return (
    <>
      {(visible ?? []).map(e => (
        e.type === "folder"
          ? <FolderRow key={e.path} entry={e} depth={depth} filter={filter} />
          : <FileRow key={e.path} entry={e} depth={depth} dim={!matchesFilter(e.name)} />
      ))}
      {loading && (
        <div style={{
          padding: `2px 6px 2px ${depth * 12 + 24}px`,
          fontSize: 11, color: "#7a7a7a", fontFamily: SANS,
        }}>Loading…</div>
      )}
      {!loading && entries !== null && entries.length === 0 && (
        <div style={{
          padding: `2px 6px 2px ${depth * 12 + 24}px`,
          fontSize: 11, color: "#7a7a7a", fontFamily: SANS, fontStyle: "italic",
        }}>(empty)</div>
      )}
    </>
  );
}

function FolderRow({ entry, depth, filter }: {
  entry: FsEntry; depth: number; filter: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        onClick={() => setOpen(o => !o)}
        title={entry.path}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "3px 8px",
          paddingLeft: depth * 14 + 8,
          height: 24,
          cursor: "pointer",
          fontSize: 12.5, fontFamily: SANS, fontWeight: 400,
          color: "#d8d8d8",
          borderRadius: 5,
          userSelect: "none",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        {/* Reference matches the Cursor / minimal-tree look the user
            pinned: just a chevron, no folder icon. The chevron's
            rotation is the only visual marker for collapsed/open. */}
        <ChevronRight
          size={11}
          color="#8D8D8D"
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.14s",
            flexShrink: 0,
          }}
        />
        <span style={{
          flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{entry.name}</span>
      </div>
      {open && <FileTreeNode path={entry.path} depth={depth + 1} filter={filter} />}
    </>
  );
}

function FileRow({ entry, depth, dim }: {
  entry: FsEntry; depth: number; dim?: boolean;
}) {
  const openFile = useAppStore(s => s.openFile);
  const openFilePath = useAppStore(s => s.openFilePath);
  const active = openFilePath === entry.path;
  // Each file gets a small `</>` code icon — the only visual icon
  // in the tree, picked to match the Cursor reference exactly.
  // Folder rows don't carry an icon (just a chevron) so files read
  // as the "leaf nodes" without ambiguity.
  return (
    <div
      title={entry.path}
      onClick={() => openFile(entry.path)}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "3px 8px",
        paddingLeft: depth * 14 + 25,
        height: 24,
        cursor: "pointer",
        fontSize: 12.5, fontFamily: SANS,
        color: dim ? "#5a5a5a" : (active ? "#ffffff" : "#bdbdbd"),
        background: active ? "rgba(255,255,255,0.06)" : "transparent",
        opacity: dim ? 0.5 : 1,
        borderRadius: 5,
        userSelect: "none",
        fontWeight: 400,
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)"; }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <FileCode size={12} color={active ? "#c0c0c0" : "#7a7a7a"} style={{ flexShrink: 0 }} />
      <span style={{
        flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{entry.name}</span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   FileView — singleton CodeMirror editor pane.

   Reads `openFilePath` from the store; rebuilds the editor on
   every path change. Powers:
     - Real syntax highlighting (oneDark via the existing
       buildEditorExtensions helper, language picked by extension)
     - In-file search (⌘F or the search button → CodeMirror's
       built-in search panel)
     - Save (⌘S → PUT /api/fs/file)
     - Reveal in Finder (Electron shell.showItemInFolder)
     - Copy path
     - Drag-handle on the "File" label so the pane participates in
       the workspace grid's reorder/resize like any other pane.

   The visual ramp matches Diff / Files: same header height, same
   action-button styling, same picker-on-toggle behaviour. CodeMirror
   itself is themed via the user's active Fleet theme + oneDark
   highlights, so the pane never looks alien dropped next to the
   terminal or diff card.
   ══════════════════════════════════════════════════════════ */
function FileView() {
  const requestClose = useContext(PaneCloseContext);
  const path = useAppStore(s => s.openFilePath);
  const colorTheme = useThemeStore(s => s.colorTheme);
  const isDark     = useThemeStore(s => s.theme) === "dark";

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef   = useRef<EditorView | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readonlyCompRef = useRef<any>(null);
  const [saved,     setSaved]     = useState(true);
  const [loading,   setLoading]   = useState(false);
  const [err,       setErr]       = useState("");
  const [mdSource,  setMdSource]  = useState<string | null>(null);
  const [viewMode,  setViewMode]  = useState<"preview" | "code">("preview");
  const [isEditing, setIsEditing] = useState(false);

  const ext = path ? ((path.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "") : "";
  const isMarkdown = ext === "md" || ext === "mdx";

  const copyPath = useCallback(() => {
    if (!path) return;
    navigator.clipboard?.writeText(path).catch(() => {});
  }, [path]);

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !path) return;
    const ok = await apiSave(path, view.state.doc.toString());
    if (ok) setSaved(true);
  }, [path]);

  const toggleEdit = useCallback(async () => {
    const view = viewRef.current;
    const comp = readonlyCompRef.current;
    if (!view || !comp) return;
    const next = !isEditing;
    setIsEditing(next);
    const { EditorState: ES } = await import("@codemirror/state");
    view.dispatch({ effects: comp.reconfigure(ES.readOnly.of(!next)) });
    if (next) setTimeout(() => view.focus(), 0);
  }, [isEditing]);

  const openSearch = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const { openSearchPanel } = await import("@codemirror/search");
    openSearchPanel(view);
  }, []);

  const revealInFolder = useCallback(() => {
    if (!path) return;
    const api = window.electronAPI;
    if (api?.showItemInFolder) api.showItemInFolder(path).catch(() => {});
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Reset view mode to preview when switching to a markdown file
  useEffect(() => {
    if (path) setViewMode(isMarkdown ? "preview" : "code");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    if (!path) {
      try { viewRef.current?.destroy(); } catch { /* already gone */ }
      viewRef.current = null;
      if (editorRef.current) editorRef.current.innerHTML = "";
      setMdSource(null);
      return;
    }
    let destroyed = false;
    setLoading(true); setErr(""); setSaved(true); setMdSource(null);
    try { viewRef.current?.destroy(); } catch { /* already gone */ }
    viewRef.current = null;
    if (editorRef.current) editorRef.current.innerHTML = "";

    const fileExt = (path.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
    const isMd = fileExt === "md" || fileExt === "mdx";

    (async () => {
      try {
        if (isMd) {
          const r = await apiFile(path);
          if (destroyed) return;
          if (r.error) { setErr(r.error); setLoading(false); return; }
          setMdSource(r.content ?? "");
          setLoading(false);
        } else {
          const onUpdate = (u: ViewUpdate) => { if (u.docChanged) setSaved(false); };
          const [r, { extensions, EditorView, EditorState, readonlyComp }] = await Promise.all([
            apiFile(path),
            buildEditorExtensions(colorTheme, isDark, fileExt, onUpdate),
          ]);
          if (destroyed || !editorRef.current) return;
          if (r.error) { setErr(r.error); setLoading(false); return; }
          readonlyCompRef.current = readonlyComp;
          setIsEditing(false);
          const state = EditorState.create({ doc: r.content ?? "", extensions });
          const view  = new EditorView({ state, parent: editorRef.current });
          viewRef.current = view;
          setLoading(false);
        }
      } catch (e) {
        if (!destroyed) { setErr(String(e)); setLoading(false); }
      }
    })();

    return () => { destroyed = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, colorTheme, viewMode]);

  // Rebuild CodeMirror when switching from preview → code on a markdown file
  useEffect(() => {
    if (!path || !isMarkdown || viewMode !== "code" || loading) return;
    if (viewRef.current) return; // already built
    let destroyed = false;
    setLoading(true);
    if (editorRef.current) editorRef.current.innerHTML = "";
    (async () => {
      try {
        const onUpdate = (u: ViewUpdate) => { if (u.docChanged) setSaved(false); };
        const [r, { extensions, EditorView, EditorState, readonlyComp }] = await Promise.all([
          apiFile(path),
          buildEditorExtensions(colorTheme, isDark, ext, onUpdate),
        ]);
        if (destroyed || !editorRef.current) return;
        if (r.error) { setErr(r.error); setLoading(false); return; }
        readonlyCompRef.current = readonlyComp;
        setIsEditing(false);
        const state = EditorState.create({ doc: r.content ?? "", extensions });
        const view  = new EditorView({ state, parent: editorRef.current });
        viewRef.current = view;
        setLoading(false);
      } catch (e) {
        if (!destroyed) { setErr(String(e)); setLoading(false); }
      }
    })();
    return () => { destroyed = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  const displayPath = path
    ? (path.length > 60 ? "…" + path.slice(path.length - 60) : path)
    : null;

  const showPreview = isMarkdown && viewMode === "preview";
  const showEditor  = !isMarkdown || viewMode === "code";

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 0,
      background: "var(--sidebar)",
    }}>
      {/* Header */}
      <div style={{
        height: 38, flexShrink: 0,
        display: "flex", alignItems: "center",
        padding: "0 6px 0 12px", gap: 6,
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}>
        <span data-pane-handle="true" style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "#e6e6e6", letterSpacing: 0.1, cursor: "grab" }}>File</span>
        {!saved && path && (
          <div title="Unsaved changes" style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "#fbbf24", flexShrink: 0,
          }} />
        )}
        <TermActionBtn title="Close file pane" onClick={() => requestClose?.("file")}>
          <X size={13} />
        </TermActionBtn>
      </div>

      {/* Sub-header — flat strip, no box */}
      {path && (
        <div style={{
          flexShrink: 0,
          display: "flex", alignItems: "center", gap: 2,
          padding: "3px 6px 3px 12px",
          background: "#252525",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}>
          <span
            onClick={copyPath}
            title={path}
            style={{
              flex: 1, minWidth: 0, fontSize: 10.5, fontFamily: MONO,
              color: "#888",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              cursor: "pointer", direction: "rtl", textAlign: "left",
            }}
          >{displayPath}</span>
          {isMarkdown && (
            <FileActionChip
              title={viewMode === "preview" ? "Edit source (⌘E)" : "Preview (⌘E)"}
              onClick={() => setViewMode(v => v === "preview" ? "code" : "preview")}
            >
              {viewMode === "preview" ? <Code2 size={11} /> : <Eye size={11} />}
            </FileActionChip>
          )}
          {!showPreview && (
            <FileActionChip title="Search in file (⌘F)" onClick={openSearch}>
              <Search size={11} />
            </FileActionChip>
          )}
          {!showPreview && (
            <FileActionChip
              title={isEditing ? "Lock file (stop editing)" : "Edit file"}
              onClick={toggleEdit}
              accent={isEditing}
            >
              <Pencil size={11} />
            </FileActionChip>
          )}
          <FileActionChip title="Reveal in Finder" onClick={revealInFolder}>
            <FolderOpen size={11} />
          </FileActionChip>
          <FileActionChip title="Copy path" onClick={copyPath}>
            <Copy size={11} />
          </FileActionChip>
        </div>
      )}

      {/* Body */}
      {!path ? (
        <div style={{
          flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 8, padding: "60px 20px", color: "#9a9a9a", textAlign: "center",
        }}>
          <FileText size={20} color="#5a5a5a" />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "#c8c8c8", fontFamily: SANS }}>
            No file open
          </span>
          <span style={{ fontSize: 11.5, color: "#7a7a7a", fontFamily: SANS, maxWidth: 280, lineHeight: 1.5 }}>
            Click a file in the Files pane to view it here.
          </span>
        </div>
      ) : err ? (
        <div style={{
          flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 8, padding: "60px 20px", color: "#fca5a5", textAlign: "center",
        }}>
          <AlertCircle size={20} color="#ff8888" />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "#fca5a5", fontFamily: SANS }}>
            Couldn't open file
          </span>
          <span style={{ fontSize: 11.5, color: "#9a9a9a", fontFamily: SANS, maxWidth: 320, lineHeight: 1.5 }}>
            {err}
          </span>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
          {loading && (
            <div style={{
              position: "absolute", inset: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#7a7a7a", fontSize: 12, fontFamily: SANS, pointerEvents: "none",
              zIndex: 2,
            }}>Loading…</div>
          )}
          {showPreview && !loading && mdSource !== null && (
            <MarkdownPreview source={mdSource} />
          )}
          <div ref={editorRef} style={{
            flex: 1, minHeight: 0,
            display: showEditor && !loading ? "block" : "none",
            height: "100%",
          }} />
        </div>
      )}
    </div>
  );
}

/* Renders markdown source as a styled document matching the sidebar
   dark theme. Used by FileView when a .md/.mdx file is open in preview
   mode. Reuses the ReactMarkdown + remark-gfm already loaded for chat. */
function MarkdownPreview({ source }: { source: string }) {
  const c: React.CSSProperties = {
    flex: 1, minHeight: 0,
    overflowY: "auto",
    padding: "20px 24px 36px",
    background: "var(--sidebar)",
    fontFamily: SANS,
    color: "#b8b8b8",
    fontSize: 13,
    lineHeight: 1.65,
  };
  return (
    <div style={c}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 style={{ fontSize: 19, fontWeight: 700, color: "#efefef", margin: "0 0 12px", lineHeight: 1.3 }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: 15, fontWeight: 700, color: "#e6e6e6", margin: "24px 0 8px", paddingBottom: 5, borderBottom: "1px solid rgba(255,255,255,0.07)" }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: 13.5, fontWeight: 700, color: "#dedede", margin: "18px 0 6px" }}>{children}</h3>,
          h4: ({ children }) => <h4 style={{ fontSize: 13, fontWeight: 600, color: "#d0d0d0", margin: "14px 0 4px" }}>{children}</h4>,
          p:  ({ children }) => <p  style={{ margin: "0 0 10px", color: "#b0b0b0" }}>{children}</p>,
          strong: ({ children }) => <strong style={{ fontWeight: 700, color: "#e8e8e8" }}>{children}</strong>,
          em:     ({ children }) => <em     style={{ fontStyle: "italic", color: "#c8c8c8" }}>{children}</em>,
          hr: () => <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.08)", margin: "18px 0" }} />,
          ul: ({ children }) => <ul style={{ paddingLeft: 20, margin: "0 0 10px" }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ paddingLeft: 20, margin: "0 0 10px" }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: 3, color: "#b0b0b0" }}>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote style={{
              borderLeft: "3px solid rgba(167,139,250,0.40)",
              margin: "0 0 10px", paddingLeft: 14,
              color: "#888",
            }}>{children}</blockquote>
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = className?.startsWith("language-");
            if (isBlock) {
              return (
                <pre style={{
                  background: "rgba(0,0,0,0.30)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 6, padding: "10px 14px",
                  overflowX: "auto", margin: "0 0 12px",
                }}>
                  <code style={{ fontFamily: MONO, fontSize: 12, color: "#d0d0d0", lineHeight: 1.55 }} {...props}>
                    {children}
                  </code>
                </pre>
              );
            }
            return (
              <code style={{
                fontFamily: MONO, fontSize: "0.85em",
                background: "rgba(255,255,255,0.09)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 4, padding: "1px 5px",
                color: "#ddd",
              }} {...props}>{children}</code>
            );
          },
          a: ({ href, children }) => (
            <a href={href} style={{ color: "#a78bfa", textDecoration: "underline", textDecorationColor: "rgba(167,139,250,0.35)" }}>
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div style={{
              margin: "14px 0",
              borderRadius: 9,
              overflow: "hidden",
              border: "1px solid var(--c-brd)",
              background: "var(--background)",
            }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{
              padding: "9px 14px",
              borderBottom: "1px solid var(--c-brd)",
              textAlign: "left",
              fontWeight: 600,
              color: "var(--c-dim)",
              fontSize: 10.5,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              background: "var(--c-srf)",
              verticalAlign: "middle",
            }}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{
              padding: "10px 14px",
              borderBottom: "1px solid var(--c-brd)",
              color: "var(--c-high)",
              fontSize: 13,
              lineHeight: 1.45,
              verticalAlign: "middle",
            }}>
              {children}
            </td>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

/* Compact 22x22 chip used in the FileView sub-header. Smaller +
   tighter than TermActionBtn (which is sized for the 44px primary
   header) so the path row reads as a quieter strip. */
function FileActionChip({
  title, onClick, disabled, accent, children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  accent?: boolean;
  children: React.ReactNode;
}) {
  const accentColor = "#FFC799";
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      onMouseDown={e => e.preventDefault()}
      style={{
        width: 22, height: 22, borderRadius: 5,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: accent ? "rgba(255,199,153,0.12)" : "none",
        border: "none", outline: "none",
        color: accent ? accentColor : "#9a9a9a",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
        transition: "background 0.1s, color 0.1s",
      }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.background = accent ? "rgba(255,199,153,0.20)" : "rgba(255,255,255,0.08)"; e.currentTarget.style.color = accent ? accentColor : "#e0e0e0"; } }}
      onMouseLeave={e => { e.currentTarget.style.background = accent ? "rgba(255,199,153,0.12)" : "none"; e.currentTarget.style.color = accent ? accentColor : "#9a9a9a"; }}
    >
      {children}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════
   TasksView — TODO / progress checklist surface.

   Local-state only for now (a future iteration can persist tasks
   per-session via the backend). The shape mirrors what an agent
   would emit if it dropped checklist items into a chat — title,
   optional body, status. Reading this pane as a "what is the
   agent working on right now" board is the goal.
   ══════════════════════════════════════════════════════════ */
type TaskStatusKind = "pending" | "in_progress" | "completed";
interface PaneTask {
  id: string;
  title: string;
  status: TaskStatusKind;
}

function TasksView() {
  const requestClose = useContext(PaneCloseContext);
  // Persist per-session in localStorage so tasks survive Electron
  // reloads and pane close/reopen. Key falls back to "global" when no
  // active session, so the user-visible behaviour (still functional)
  // doesn't break in fleet/control-center mode.
  const sessionId = usePaneSessionId() ?? "global";
  const storageKey = `fleet:tasks:${sessionId}`;

  const [tasks, setTasks] = useState<PaneTask[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return JSON.parse(raw) as PaneTask[];
    } catch { /* ignore */ }
    return [];
  });
  const [draft, setDraft] = useState("");

  // Re-hydrate when the active session changes (e.g. user switches
  // agent and the Tasks pane stays open).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setTasks(raw ? (JSON.parse(raw) as PaneTask[]) : []);
    } catch { setTasks([]); }
  }, [storageKey]);

  // Write-through on every mutation. Keeps state durable without a
  // separate "save" affordance.
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(tasks)); }
    catch { /* quota / private mode — silently best-effort */ }
  }, [tasks, storageKey]);

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    setTasks(t => [...t, { id: crypto.randomUUID(), title, status: "pending" }]);
    setDraft("");
  };
  const cycle = (id: string) => {
    setTasks(t => t.map(x => {
      if (x.id !== id) return x;
      const next: TaskStatusKind =
        x.status === "pending"     ? "in_progress" :
        x.status === "in_progress" ? "completed"   :
        "pending";
      return { ...x, status: next };
    }));
  };
  const remove = (id: string) => setTasks(t => t.filter(x => x.id !== id));

  const groups: { label: string; status: TaskStatusKind; items: PaneTask[] }[] = [
    { label: "In progress", status: "in_progress", items: tasks.filter(t => t.status === "in_progress") },
    { label: "Pending",     status: "pending",     items: tasks.filter(t => t.status === "pending") },
    { label: "Completed",   status: "completed",   items: tasks.filter(t => t.status === "completed") },
  ];

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 0,
      background: "var(--sidebar)",
    }}>
      <div style={{
        height: 44, flexShrink: 0,
        display: "flex", alignItems: "center",
        padding: "0 8px 2px 8px",
        gap: 4,
      }}>
        <span data-pane-handle="true" style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "#e6e6e6", letterSpacing: 0.1, cursor: "grab" }}>Tasks</span>
        {tasks.length > 0 && (
          <span style={{ fontSize: 11, color: "#9a9a9a", marginRight: 6 }}>
            {tasks.filter(t => t.status === "completed").length}/{tasks.length}
          </span>
        )}
        <TermActionBtn title="Close tasks pane" onClick={() => requestClose?.("tasks")}>
          <X size={13} />
        </TermActionBtn>
      </div>

      {/* Add-task input — compact, low-chrome. Quieter than Files'
          search input because tasks-add is a fast capture surface,
          not a primary affordance the user dwells in. */}
      <div style={{ flexShrink: 0, padding: "0 10px 8px" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 8px",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid var(--c-brd)",
          borderRadius: 6,
        }}>
          <Plus size={11} color="#7a7a7a" style={{ flexShrink: 0 }} />
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") add(); }}
            placeholder="Add a task…"
            spellCheck={false}
            style={{
              flex: 1, minWidth: 0,
              background: "transparent", border: "none", outline: "none",
              color: "#dcdcdc", fontSize: 11.5, fontFamily: SANS, fontWeight: 400,
              padding: 0,
            }}
          />
        </div>
      </div>

      {/* Body */}
      <div className="scroll-subtle" style={{
        flex: 1, minHeight: 0, overflowY: "auto",
        padding: "0 6px 8px",
      }}>
        {tasks.length === 0 ? (
          <div style={{
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            gap: 8, padding: "60px 20px",
            color: "#9a9a9a",
          }}>
            <CheckSquare size={20} color="#5a5a5a" />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "#c8c8c8", fontFamily: SANS }}>
              No tasks yet
            </span>
            <span style={{ fontSize: 11.5, color: "#7a7a7a", fontFamily: SANS, textAlign: "center", maxWidth: 280, lineHeight: 1.5 }}>
              Add quick checklist items here. Click a row to cycle pending → in progress → done.
            </span>
          </div>
        ) : (
          groups.map(g => g.items.length === 0 ? null : (
            <div key={g.status} style={{ marginTop: 6 }}>
              <div style={{
                fontSize: 10, fontWeight: 600,
                color: "#7a7a7a", textTransform: "uppercase", letterSpacing: "0.08em",
                padding: "6px 8px 4px",
              }}>{g.label} · {g.items.length}</div>
              {g.items.map(t => <TaskRow key={t.id} task={t} onCycle={() => cycle(t.id)} onRemove={() => remove(t.id)} />)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TaskRow({ task, onCycle, onRemove }: {
  task: PaneTask; onCycle: () => void; onRemove: () => void;
}) {
  // Status pill colors mirror the rest of the surface ramp:
  // pending = neutral grey; in_progress = blue; completed = green dim.
  const dotColor =
    task.status === "completed"   ? "#4ade80" :
    task.status === "in_progress" ? "#60a5fa" :
    "#5a5a5a";
  const dotFill =
    task.status === "completed"   ? "#4ade80" :
    task.status === "in_progress" ? "transparent" :
    "transparent";
  return (
    <div
      onClick={onCycle}
      title="Click to cycle status"
      style={{
        display: "flex", alignItems: "center", gap: 9,
        padding: "5px 8px",
        margin: "1px 0",
        cursor: "pointer",
        borderRadius: 5,
        userSelect: "none",
        opacity: task.status === "completed" ? 0.6 : 1,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <span style={{
        width: 13, height: 13, borderRadius: 999,
        border: `1.5px solid ${dotColor}`,
        background: dotFill,
        flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      }}>
        {task.status === "completed" && <Check size={9} color="#0d2818" strokeWidth={3} />}
      </span>
      <span style={{
        flex: 1, fontSize: 12.5, fontFamily: SANS,
        color: task.status === "completed" ? "#9a9a9a" : "#dcdcdc",
        textDecoration: task.status === "completed" ? "line-through" : "none",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{task.title}</span>
      <button
        onClick={e => { e.stopPropagation(); onRemove(); }}
        title="Remove"
        style={{
          width: 18, height: 18, borderRadius: 4,
          background: "none", border: "none", cursor: "pointer",
          color: "#7a7a7a", display: "inline-flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, opacity: 0,
          transition: "opacity 0.1s, color 0.1s",
        }}
        onMouseEnter={e => { e.currentTarget.style.color = "#ff8888"; }}
        onMouseLeave={e => { e.currentTarget.style.color = "#7a7a7a"; }}
      >
        <X size={10} />
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   PlanView — agent's running plan / scratch buffer.

   Reads as a single Markdown surface — the assistant fills it
   with structured scaffolding ("explore X, implement Y, verify Z")
   while it works. For now, local-state only; future iteration
   subscribes to the agent's `plan` tool events. Editable so the
   user can nudge the plan if the agent goes off-track.
   ══════════════════════════════════════════════════════════ */
// PlanView was a localStorage-backed scratchpad. The user asked for
// the Plan pane to go entirely; the dead function is removed so it
// doesn't accumulate references that quietly add the pane back.

/* ══════════════════════════════════════════════════════════
   MemoriesView — curated knowledge for this session.

   Backed by /api/sessions/:id/memory (existing endpoint). Memory
   items are persisted server-side and shared across sessions on
   the same project (the `from_other_session` flag is honoured so
   the user can tell which entries crossed over).

   Operations: list, add (title + content), delete. Edit lands in a
   follow-up — the API supports PATCH already, but inline editing
   needs a couple of dialogs we don't ship in this turn.
   ══════════════════════════════════════════════════════════ */
function MemoriesView() {
  const requestClose = useContext(PaneCloseContext);
  const sessionId = usePaneSessionId();

  const [items, setItems] = useState<SessionMemoryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [composing, setComposing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody]   = useState("");

  const reqIdRef = useRef(0);
  const refresh = useCallback(() => {
    if (!sessionId) { setItems([]); return; }
    const myId = ++reqIdRef.current;
    setLoading(true); setErr("");
    fetchSessionMemory(sessionId)
      .then(res => { if (myId === reqIdRef.current) { setItems(res); setLoading(false); } })
      .catch((e: Error) => { if (myId === reqIdRef.current) { setErr(e.message || "Load failed"); setLoading(false); } });
  }, [sessionId]);

  useEffect(() => { refresh(); }, [refresh]);

  const submit = async () => {
    if (!sessionId) return;
    const title = draftTitle.trim();
    const content = draftBody.trim();
    if (!title || !content) return;
    try {
      const created = await createSessionMemory(sessionId, { title, content });
      setItems(prev => [created, ...(prev ?? [])]);
      setDraftTitle(""); setDraftBody("");
      setComposing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  };

  const remove = async (id: string) => {
    if (!sessionId) return;
    setItems(prev => (prev ?? []).filter(x => x.id !== id));
    try { await deleteSessionMemory(sessionId, id); }
    catch { /* best-effort — refresh will resync */ refresh(); }
  };

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 0,
      background: "var(--sidebar)",
    }}>
      <div style={{
        height: 44, flexShrink: 0,
        display: "flex", alignItems: "center",
        padding: "0 8px 2px 8px",
        gap: 4,
      }}>
        <span data-pane-handle="true" style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "#e6e6e6", letterSpacing: 0.1, cursor: "grab" }}>Memories</span>
        {items && items.length > 0 && (
          <span style={{ fontSize: 11, color: "#9a9a9a", marginRight: 6 }}>
            {items.length}
          </span>
        )}
        <TermActionBtn title={composing ? "Cancel" : "New memory"} onClick={() => setComposing(c => !c)}>
          {composing ? <X size={13} /> : <Plus size={13} />}
        </TermActionBtn>
        <TermActionBtn title="Refresh" onClick={refresh} disabled={loading}>
          <RefreshCw size={13} />
        </TermActionBtn>
        <TermActionBtn title="Close memories pane" onClick={() => requestClose?.("memories")}>
          <X size={13} />
        </TermActionBtn>
      </div>

      {/* Compose strip — appears when user clicks +. Two short
          inputs (title + content). Submit on ⌘↵ or the explicit
          button. */}
      {composing && (
        <div style={{
          flexShrink: 0,
          margin: "0 10px 8px",
          padding: 8,
          background: "var(--c-srf)",
          border: "1px solid var(--c-brd)",
          borderRadius: 8,
          display: "flex", flexDirection: "column", gap: 6,
        }}>
          <input
            value={draftTitle}
            onChange={e => setDraftTitle(e.target.value)}
            placeholder="Title"
            autoFocus
            style={{
              padding: "5px 9px",
              background: "var(--c-srf2)",
              border: "1px solid var(--c-brd)",
              borderRadius: 5,
              color: "#e6e6e6", fontSize: 12, fontFamily: SANS, fontWeight: 500,
              outline: "none",
            }}
          />
          <textarea
            value={draftBody}
            onChange={e => setDraftBody(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(); }}
            placeholder="Content (⌘↵ to save)"
            rows={3}
            style={{
              padding: "6px 9px",
              background: "var(--c-srf2)",
              border: "1px solid var(--c-brd)",
              borderRadius: 5,
              color: "#dcdcdc", fontSize: 12, fontFamily: MONO, lineHeight: 1.5,
              outline: "none", resize: "vertical",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button
              onClick={() => { setComposing(false); setDraftTitle(""); setDraftBody(""); }}
              style={{
                padding: "4px 10px", fontSize: 11, fontFamily: SANS,
                background: "transparent", border: "1px solid var(--c-brd)",
                borderRadius: 4, color: "#bdbdbd", cursor: "pointer", outline: "none",
              }}
            >Cancel</button>
            <button
              onClick={submit}
              disabled={!draftTitle.trim() || !draftBody.trim()}
              style={{
                padding: "4px 12px", fontSize: 11, fontFamily: SANS, fontWeight: 600,
                background: draftTitle.trim() && draftBody.trim()
                  ? "var(--c-fg)"
                  : "var(--c-srf2)",
                border: "1px solid " + (draftTitle.trim() && draftBody.trim()
                  ? "var(--c-fg)"
                  : "var(--c-brd)"),
                borderRadius: 4,
                color: draftTitle.trim() && draftBody.trim()
                  ? "var(--card)"
                  : "var(--c-dim)",
                cursor: draftTitle.trim() && draftBody.trim() ? "pointer" : "default",
                outline: "none",
              }}
            >Save</button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="scroll-subtle" style={{
        flex: 1, minHeight: 0, overflowY: "auto",
        padding: "0 10px 10px",
      }}>
        {!sessionId ? (
          <div style={{ padding: "60px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <Layers size={20} color="#5a5a5a" />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "#c8c8c8", fontFamily: SANS }}>No session</span>
            <span style={{ fontSize: 11.5, color: "#7a7a7a", fontFamily: SANS, textAlign: "center" }}>
              Memories live per-session. Open a session to view its memory.
            </span>
          </div>
        ) : loading && !items ? (
          <div style={{ padding: 20, fontSize: 12, color: "#7a7a7a", textAlign: "center", fontFamily: SANS }}>Loading…</div>
        ) : err ? (
          <div style={{ padding: 20, fontSize: 11.5, color: "#ff8888", fontFamily: MONO }}>{err}</div>
        ) : items && items.length === 0 ? (
          <div style={{ padding: "60px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
            <Layers size={20} color="#5a5a5a" />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "#c8c8c8", fontFamily: SANS }}>No memories yet</span>
            <span style={{ fontSize: 11.5, color: "#7a7a7a", fontFamily: SANS, maxWidth: 280, lineHeight: 1.5 }}>
              Memories are persistent notes the agent (or you) save during a session — visible across sessions on the same project.
            </span>
          </div>
        ) : (
          (items ?? []).map(m => <MemoryCard key={m.id} item={m} onRemove={() => remove(m.id)} />)
        )}
      </div>
    </div>
  );
}

function MemoryCard({ item, onRemove }: { item: SessionMemoryItem; onRemove: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        marginTop: 6,
        padding: "8px 10px",
        background: "rgba(255,255,255,0.025)",
        border: "1px solid var(--c-brd)",
        borderRadius: 7,
        display: "flex", flexDirection: "column", gap: 4,
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          fontSize: 12, fontWeight: 600, color: "#e6e6e6",
          flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{item.title}</span>
        {item.from_other_session && (
          <span
            title="Saved during a previous session on this project — Fleet pools memories across sessions per project."
            style={{
              fontSize: 9.5, color: "var(--c-dim)", fontFamily: MONO,
              padding: "1px 5px", borderRadius: 3,
              background: "var(--c-srf2)",
              border: "1px solid var(--c-brd)",
            }}
          >shared</span>
        )}
        {hovered && (
          <button
            onClick={onRemove}
            title="Delete"
            style={{
              width: 18, height: 18, borderRadius: 4,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", outline: "none",
              color: "#7a7a7a", cursor: "pointer",
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "#ff8888"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "#7a7a7a"; }}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <span style={{
        fontSize: 11.5, fontFamily: MONO, color: "#bdbdbd",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        lineHeight: 1.5,
      }}>{item.content}</span>
      <span style={{
        fontSize: 10, color: "#6a6a6a", fontFamily: MONO,
        marginTop: 2,
      }}>{item.kind} · {new Date(item.created_at).toLocaleString()}</span>
    </div>
  );
}

/* ─── Shelved internal helpers ────────────────────────────────────
   These components are wired up internally but currently unrouted —
   keeping them in-tree so the rebuild of each pane (Diff, Terminal,
   Plan, etc.) doesn't have to reinvent them. The `void` references
   keep `noUnusedLocals` happy without hiding the implementations
   behind eslint-disable comments. */
void FileJson;
void EXT_LANG;
void CodeEditor;
void GitPanel;
void DiffViewer;
// PlanWorkspace is routed via WorkspacePane (Plan pane). ProcessWorkspace
// is the older flat step-list renderer — kept in the source but no
// longer routed; the Process/Agent pane now goes through AgentPaneView
// (chat-style rendering) instead. Reinstating the void suppression for
// ProcessWorkspace so its presence doesn't trip the unused-symbol check.
void ProcessWorkspace;
// TaskCard / TasksView are superseded by SubagentTaskCard /
// TaskCardsWorkspace (subagent-driven) — kept in source so future
// re-introduction of a per-turn or scratchpad surface doesn't have
// to re-write them. Void-marked so the unused-symbol check stays clean.
void TaskCard;
void TasksView;
// PlanWorkspace is no longer routed — Plan pane was removed entirely.
// Keep the symbol referenced so the function (still in source) doesn't
// trip the unused-symbol check; future re-add of a plan surface can
// simply add it back to WorkspacePane.
void PlanWorkspace;
void TerminalWorkspace;
void BrowserPanel;
void TabItem;
void TermResizeHandle;
void QuadrantWorkspace;
