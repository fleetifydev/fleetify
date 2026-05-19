import { useState, useEffect, useCallback, useRef } from "react";
import {
  FileText,
  FolderOpen,
  FolderClosed,
  ChevronRight,
  ChevronDown,
  Plus,
  X,
  Terminal as TerminalIcon,
  FileCode,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/* ── Hooks for Electron file system ── */
function useProjectRoot() {
  const [root, setRoot] = useState("");
  useEffect(() => {
    window.electronAPI?.getProjectRoot().then(setRoot);
  }, []);
  return root;
}

function useDirectory(dirPath: string) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!dirPath || !window.electronAPI) return;
    setLoading(true);
    const result = await window.electronAPI.readDirectory(dirPath);
    setEntries(result);
    setLoading(false);
  }, [dirPath]);

  useEffect(() => { load(); }, [load]);

  return { entries, loading, refresh: load };
}

function useFileContent(filePath: string) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!filePath || !window.electronAPI) return;
    setLoading(true);
    setError("");
    window.electronAPI.readFile(filePath).then((result) => {
      if (result.error) {
        setError(result.error);
        setContent("");
      } else {
        setContent(result.content ?? "");
        setError("");
      }
      setLoading(false);
    });
  }, [filePath]);

  return { content, loading, error };
}

/* ── Get language from file extension ── */
function getLang(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", md: "markdown",
    json: "json", toml: "toml", yaml: "yaml", yml: "yaml",
    css: "css", html: "html", sql: "sql", sh: "bash",
    txt: "text", cfg: "ini", env: "text",
  };
  return map[ext] ?? "text";
}

/* ── File tree item ── */
function TreeItem({
  entry,
  depth,
  selectedFile,
  onSelect,
}: {
  entry: FileEntry;
  depth: number;
  selectedFile: string;
  onSelect: (entry: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const isFolder = entry.type === "folder";
  const isActive = !isFolder && entry.path === selectedFile;

  const toggle = useCallback(async () => {
    if (!isFolder) { onSelect(entry); return; }
    if (!expanded && window.electronAPI) {
      const result = await window.electronAPI.readDirectory(entry.path);
      setChildren(result);
    }
    setExpanded(!expanded);
  }, [isFolder, expanded, entry, onSelect]);

  return (
    <div>
      <button
        onClick={toggle}
        className={cn(
          "flex items-center w-full py-[3px] text-[12px] rounded-md transition-colors",
          isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
        style={{ paddingLeft: 8 + depth * 14, paddingRight: 8 }}
      >
        {isFolder ? (
          expanded ? <ChevronDown size={11} className="mr-1 text-muted-foreground" /> : <ChevronRight size={11} className="mr-1 text-muted-foreground" />
        ) : <span className="w-[12px] mr-1" />}

        {isFolder ? (
          expanded ? <FolderOpen size={13} className="mr-1.5 text-amber-500/80" /> : <FolderClosed size={13} className="mr-1.5 text-amber-500/80" />
        ) : <FileText size={13} className="mr-1.5 text-muted-foreground" />}

        <span className="truncate flex-1 text-left">{entry.name}</span>
      </button>

      {isFolder && expanded && children.map((child) => (
        <TreeItem key={child.path} entry={child} depth={depth + 1} selectedFile={selectedFile} onSelect={onSelect} />
      ))}
    </div>
  );
}

/* ── Code viewer with line numbers ── */
function CodeViewer({ content, filename }: { content: string; filename: string }) {
  const lines = content.split("\n");
  const lang = getLang(filename);

  return (
    <div className="font-mono text-[12px] leading-[1.6]">
      <div className="px-2 py-1 text-[10px] text-muted-foreground border-b border-border bg-card/50">
        {filename} — {lang} — {lines.length} lines
      </div>
      <div className="overflow-auto">
        {lines.map((line, i) => (
          <div key={i} className="flex hover:bg-accent/30 transition-colors">
            <span className="w-10 text-right pr-3 text-muted-foreground/50 select-none flex-shrink-0 text-[11px]">
              {i + 1}
            </span>
            <pre className="flex-1 whitespace-pre-wrap break-all text-foreground/80">
              {line || " "}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Terminal panel ── */
function TerminalPanel() {
  const termRef = useRef<HTMLDivElement>(null);
  const [, setConnected] = useState(false);

  useEffect(() => {
    if (!termRef.current) return;

    let term: import("@xterm/xterm").Terminal | null = null;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      await import("@xterm/xterm/css/xterm.css");

      term = new Terminal({
        theme: {
          background: "#131313",
          foreground: "#cccccc",
          cursor: "#cccccc",
          selectionBackground: "rgba(255,255,255,0.15)",
        },
        fontSize: 12,
        fontFamily: "SF Mono, Geist Mono, Menlo, monospace",
        cursorBlink: true,
        cursorStyle: "bar",
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(termRef.current!);
      fitAddon.fit();

      term.writeln("\x1b[90m$ fleet terminal\x1b[0m");
      term.writeln("\x1b[90mConnecting to backend PTY...\x1b[0m");
      term.writeln("");

      // Try to connect to backend terminal WebSocket
      let ws: WebSocket | null = null;
      try {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const host = window.location.host || "127.0.0.1:8765";
        ws = new WebSocket(`${proto}//${host}/ws/terminal/default`);
        ws.onopen = () => {
          setConnected(true);
          term?.writeln("\x1b[32m✓ Connected to backend\x1b[0m");
          term?.writeln("");
        };
        ws.onmessage = (event) => { term?.write(event.data); };
        ws.onerror = () => {
          term?.writeln("\x1b[33m⚠ Backend not available. Start the backend to use terminal.\x1b[0m");
          term?.writeln("\x1b[90m  Run: cd backend && uvicorn app.main:app --port 8765\x1b[0m");
          term?.writeln("");
          // Local echo mode
          term?.writeln("\x1b[90mLocal echo mode active. Type anything:\x1b[0m");
          term?.onData((data) => { term?.write(data); });
        };
        ws.onclose = () => { setConnected(false); };

        term.onData((data) => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
        });
      } catch {
        term.writeln("\x1b[33m⚠ WebSocket not available\x1b[0m");
        term.onData((data) => { term?.write(data); });
      }

      const observer = new ResizeObserver(() => fitAddon.fit());
      observer.observe(termRef.current!);
      return () => {
        observer.disconnect();
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          try { ws.close(); } catch { /* noop */ }
        }
      };
    })();

    return () => { term?.dispose(); };
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={termRef} className="flex-1" />
    </div>
  );
}

/* ── Tab types ── */
interface OpenTab {
  id: string;
  name: string;
  path: string;
  type: "file" | "terminal";
}

/* ── Right Panel ── */
export function RightPanel() {
  const projectRoot = useProjectRoot();
  const { entries } = useDirectory(projectRoot);
  const [tabs, setTabs] = useState<OpenTab[]>([
    { id: "terminal-1", name: "Terminal", path: "", type: "terminal" },
  ]);
  const [activeTabId, setActiveTabId] = useState("terminal-1");
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const { content, loading, error } = useFileContent(
    activeTab?.type === "file" ? activeTab.path : "",
  );

  const openFile = useCallback((entry: FileEntry) => {
    const existing = tabs.find((t) => t.path === entry.path);
    if (existing) {
      setActiveTabId(existing.id);
    } else {
      const newTab: OpenTab = { id: entry.path, name: entry.name, path: entry.path, type: "file" };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  }, [tabs]);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next[next.length - 1]?.id ?? "");
      }
      return next;
    });
  }, [activeTabId]);

  const addTerminal = useCallback(() => {
    const id = `terminal-${Date.now()}`;
    setTabs((prev) => [...prev, { id, name: "Terminal", path: "", type: "terminal" }]);
    setActiveTabId(id);
  }, []);

  const projectName = projectRoot.split("/").pop() ?? "Project";

  return (
    <div className="flex flex-col h-full">
      {/* ── Tab bar ── */}
      <div className="flex items-center h-[36px] border-b border-border overflow-x-auto flex-shrink-0 drag-region bg-card/30">
        <div className="flex items-center no-drag">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTabId(t.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 h-[36px] text-[11.5px] border-b-2 transition-colors whitespace-nowrap",
                t.id === activeTabId ? "text-foreground border-foreground/50" : "text-muted-foreground border-transparent hover:text-foreground/70",
              )}
            >
              {t.type === "terminal" ? (
                <TerminalIcon size={12} className={t.id === activeTabId ? "text-emerald-400" : "text-muted-foreground"} />
              ) : (
                <FileCode size={12} className={t.id === activeTabId ? "text-blue-400" : "text-muted-foreground"} />
              )}
              <span className="truncate max-w-[100px]">{t.name}</span>
              <button onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} className="ml-0.5 p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
                <X size={10} />
              </button>
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 ml-1 text-muted-foreground no-drag" onClick={addTerminal} title="New terminal">
          <Plus size={12} />
        </Button>
      </div>

      {/* ── Content area split: file tree + viewer/terminal ── */}
      <div className="flex flex-1 min-h-0">
        {/* File tree */}
        <ScrollArea className="flex-shrink-0 border-r border-border" style={{ width: 200 }}>
          <div className="py-2 px-1">
            <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground mb-1">{projectName}</div>
            {entries.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-muted-foreground/60 text-center">
                {projectRoot ? "No files" : "Loading..."}
              </div>
            )}
            {entries.map((entry) => (
              <TreeItem key={entry.path} entry={entry} depth={0} selectedFile={activeTab?.path ?? ""} onSelect={openFile} />
            ))}
          </div>
        </ScrollArea>

        {/* Main viewer */}
        <div className="flex-1 flex flex-col min-w-0">
          {!activeTab && (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-[12px]">
              Select a file or open a terminal
            </div>
          )}

          {activeTab?.type === "terminal" && <TerminalPanel />}

          {activeTab?.type === "file" && (
            <>
              {/* Breadcrumb */}
              <div className="flex items-center h-7 px-3 border-b border-border flex-shrink-0">
                <span className="text-[11px] text-muted-foreground truncate">
                  {activeTab.path.replace(projectRoot + "/", "")}
                </span>
              </div>
              <ScrollArea className="flex-1">
                {loading && (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 size={16} className="animate-spin mr-2" /> Loading...
                  </div>
                )}
                {error && <div className="p-4 text-destructive text-[12px]">{error}</div>}
                {!loading && !error && content && (
                  <CodeViewer content={content} filename={activeTab.name} />
                )}
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
