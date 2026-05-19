import { apiFetch } from "./api";

export type MCPType = "stdio" | "http" | "sse";

export interface StdioConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface SseConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

export type MCPConfig = StdioConfig | HttpConfig | SseConfig;

export type MCPStatus = "connected" | "auth_needed" | "failed" | "checking" | "unknown";

export interface MCPProbe {
  name: string;
  status: MCPStatus;
  tool_count: number;
  tools: { name: string; description?: string }[];
  error: string | null;
  auth_hint: string | null;
  probed_at: string | null;
}

export interface MCPServerRow {
  name: string;
  config: MCPConfig;
  status: MCPProbe;
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (data && (data.detail || data.message)) || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

export async function listServers(): Promise<MCPServerRow[]> {
  const res = await apiFetch("/api/mcp/servers");
  return handle(res);
}

export async function addServer(name: string, config: MCPConfig): Promise<MCPServerRow> {
  const res = await apiFetch("/api/mcp/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config }),
  });
  return handle(res);
}

export async function updateServer(name: string, config: MCPConfig): Promise<MCPServerRow> {
  const res = await apiFetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  return handle(res);
}

export async function deleteServer(name: string): Promise<void> {
  const res = await apiFetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  return handle(res);
}

export async function probeServer(name: string): Promise<MCPProbe> {
  const res = await apiFetch(`/api/mcp/servers/${encodeURIComponent(name)}/probe`, {
    method: "POST",
  });
  return handle(res);
}

export async function probeAll(): Promise<Record<string, MCPProbe>> {
  const res = await apiFetch("/api/mcp/probe-all", { method: "POST" });
  return handle(res);
}

export async function getConfigPath(): Promise<string> {
  const res = await apiFetch("/api/mcp/config-path");
  const data = await handle<{ path: string }>(res);
  return data.path;
}

export async function openConfig(): Promise<void> {
  const res = await apiFetch("/api/mcp/open-config", { method: "POST" });
  await handle(res);
}

export async function startAuth(name: string): Promise<string> {
  const res = await apiFetch(`/api/mcp/servers/${encodeURIComponent(name)}/auth/start`, {
    method: "POST",
  });
  const data = await handle<{ authorize_url: string }>(res);
  return data.authorize_url;
}

export async function signOut(name: string): Promise<void> {
  const res = await apiFetch(`/api/mcp/servers/${encodeURIComponent(name)}/auth/signout`, {
    method: "POST",
  });
  await handle(res);
}
