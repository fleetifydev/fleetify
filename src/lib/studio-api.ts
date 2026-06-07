import { apiFetch } from "@/lib/api";

export interface StudioToolStatus { id: string; display_name: string; install_hint: string; installed: boolean; authenticated: boolean; }
export interface HfModel { display_name: string; job_set_type: string; type: "image" | "video" | "text"; }
export interface HfModelParam { name: string; type: string; default: unknown; required: boolean; enum?: unknown[]; }
export interface HfModelDetail { display_name: string; job_set_type: string; type: string; params: HfModelParam[]; }
export interface HfAccount { email: string; credits: number; subscription_plan_type: string; }
export interface HfCost { credits: number; credits_exact: number; }
export interface HfJob { id: string; status: string; result_url?: string; result_urls?: string[]; job_set_type: string; }
export interface StudioMessage { role: string; content: string; }

// The backend returns a plain-text reason (e.g. "Not enough Higgsfield
// credits…") in the body — surface it instead of an opaque "http 500".
async function errMessage(res: Response): Promise<string> {
  try {
    const t = (await res.text()).trim();
    return t || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(await errMessage(res));
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await errMessage(res));
  return (await res.json()) as T;
}

export const studioApi = {
  getTools: () => getJson<StudioToolStatus[]>("/api/studio/tools"),
  listModels: (type?: "image" | "video" | "text") =>
    getJson<HfModel[]>(`/api/studio/higgsfield/models${type ? `?type=${type}` : ""}`),
  getModel: (id: string) => getJson<HfModelDetail>(`/api/studio/higgsfield/models/${encodeURIComponent(id)}`),
  getAccount: () => getJson<HfAccount>("/api/studio/higgsfield/account"),
  cost: (model: string, params: Record<string, unknown>) =>
    postJson<HfCost>("/api/studio/higgsfield/cost", { model, params }),
  generate: (sessionId: string, model: string, params: Record<string, unknown>) =>
    postJson<HfJob>("/api/studio/higgsfield/generate", { session_id: sessionId, model, params }),
  listMessages: (sessionId: string) =>
    getJson<StudioMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
};
