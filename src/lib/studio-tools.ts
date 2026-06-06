/** A creative/media-generation tool surfaced in Studio mode. Kept separate
 *  from the conversational provider CATALOG (which is chat-shaped). Higgsfield
 *  is the first entry; future tools append here. */
export interface StudioTool {
  /** Stable id, also used as a session's `tool` for studio sessions. */
  id: string;
  /** Human label. */
  name: string;
  /** PATH binary name (resolved by the backend in later phases). */
  bin: string;
  /** Install command shown when the tool isn't detected. */
  installHint: string;
  /** Media kinds the tool can produce. */
  media: ("image" | "video")[];
}

export const STUDIO_TOOLS: StudioTool[] = [
  {
    id: "higgsfield",
    name: "Higgsfield",
    bin: "hf",
    installHint: "npm install -g @higgsfield/cli",
    media: ["image", "video"],
  },
];

const STUDIO_TOOL_IDS = new Set(STUDIO_TOOLS.map((t) => t.id));

/** True when `tool` is a registered studio-tool id. Used (in later phases)
 *  to mark a session as a studio session and to filter sidebar lists. */
export function isStudioTool(tool: string | null | undefined): boolean {
  return tool != null && STUDIO_TOOL_IDS.has(tool);
}
