/**
 * Chat export helpers — pull a session's messages out of the
 * chat-store and dump them as Markdown or JSON.
 *
 * Originally these lived inside chat-view.tsx behind the
 * ChatMoreMenu (the "..." popover in the chat header). The user
 * asked to drop that header button and surface export as a
 * sidebar right-click action, so the helpers were extracted to
 * this module so both call sites can share them.
 */
import type { ChatMessage } from "@/types/chat";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "chat";
}

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function messagesToMarkdown(title: string, msgs: ChatMessage[]): string {
  const out: string[] = [`# ${title}`, "", `_Exported ${new Date().toISOString()}_`, ""];
  for (const m of msgs) {
    const stamp = m.timestamp ? new Date(m.timestamp).toISOString() : "";
    out.push("---", "", `## ${m.role.charAt(0).toUpperCase() + m.role.slice(1)}${stamp ? ` — ${stamp}` : ""}`, "");
    for (const b of m.content) {
      if (b.type === "text") {
        out.push(b.text.trim(), "");
      } else if (b.type === "thinking") {
        out.push("> " + b.text.replace(/\n/g, "\n> "), "");
      } else if (b.type === "tool_use") {
        out.push(`**→ ${b.tool_name}**`, "", "```json", JSON.stringify(b.input, null, 2), "```", "");
      } else if (b.type === "tool_result") {
        const label = b.is_error ? "**Result (error)**" : "**Result**";
        out.push(label, "", "```", String(b.output).slice(0, 4000), "```", "");
      } else if (b.type === "dispatch_result") {
        out.push(`**Dispatch → ${b.agent_name}** (${b.success ? "ok" : "failed"})`, "", `Task: ${b.task}`, "", b.summary, "");
      }
    }
  }
  return out.join("\n");
}

function messagesToJson(title: string, sessionId: string | null, msgs: ChatMessage[]): string {
  return JSON.stringify({
    session: { id: sessionId, title },
    exported_at: new Date().toISOString(),
    message_count: msgs.length,
    messages: msgs,
  }, null, 2);
}

export function exportChat({
  title, sessionId, messages, format,
}: {
  title: string;
  sessionId: string | null;
  messages: ChatMessage[];
  format: "md" | "json";
}) {
  const base = slugify(title);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "md") {
    downloadBlob(`${base}-${stamp}.md`, messagesToMarkdown(title, messages),
      "text/markdown;charset=utf-8");
  } else {
    downloadBlob(`${base}-${stamp}.json`, messagesToJson(title, sessionId, messages),
      "application/json;charset=utf-8");
  }
}
