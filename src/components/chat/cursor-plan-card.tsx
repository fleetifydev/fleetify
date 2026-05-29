import type { CursorPlan, CursorPlanTodo } from "@/stores/chat-store";

interface Props {
  plan: CursorPlan;
  /** Accept the plan (Cursor proceeds with execution). */
  onAccept: (id: string) => void;
  /** Reject the plan. */
  onReject: (id: string) => void;
}

const MONO = "'SF Mono','Menlo','Monaco','Consolas',monospace";
const ACCENT = "#2D9B75";

type Mark = { glyph: string; color: string };
const FALLBACK_MARK: Mark = { glyph: "○", color: "#7a7a7a" };
const STATUS_MARK: Record<string, Mark> = {
  completed: { glyph: "✓", color: "#2D9B75" },
  in_progress: { glyph: "▸", color: "#E0A23C" },
  pending: FALLBACK_MARK,
  cancelled: { glyph: "✕", color: "#9a9a9a" },
};

function TodoList({ todos }: { todos: CursorPlanTodo[] }) {
  if (!todos.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
      {todos.map((t) => {
        const mark = STATUS_MARK[t.status] ?? FALLBACK_MARK;
        return (
          <div
            key={t.id}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              fontSize: 12.5,
              color: "#dcdcdc",
              lineHeight: 1.45,
            }}
          >
            <span style={{ color: mark.color, fontFamily: MONO, fontSize: 11 }}>
              {mark.glyph}
            </span>
            <span
              style={{
                textDecoration: t.status === "cancelled" ? "line-through" : "none",
                opacity: t.status === "cancelled" ? 0.6 : 1,
              }}
            >
              {t.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* Cursor `cursor/create_plan` — a plan-approval card. Renders the markdown
 * plan body plus its todos/phases and Accept / Reject actions. Mirrors the
 * permission-dialog surface tokens. */
export function CursorPlanCard({ plan, onAccept, onReject }: Props) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          borderRadius: 10,
          border: "1px solid rgba(var(--fg-rgb),0.10)",
          background: "var(--chat-input-bg)",
          boxShadow: "inset 0 1px 0 rgba(var(--fg-rgb),0.04)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "10px 12px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            <span style={{ color: ACCENT, fontWeight: 600 }}>Plan</span>
            <span style={{ color: "#6a6a6a" }}>·</span>
            <span style={{ color: "#c4c4c4", fontWeight: 500 }}>Cursor</span>
          </div>

          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: "#f5f5f5",
              lineHeight: 1.4,
              marginBottom: plan.overview ? 4 : 8,
            }}
          >
            {plan.name ? plan.name : "Review this plan before the agent proceeds"}
          </div>

          {plan.overview && (
            <div
              style={{
                fontSize: 12.5,
                color: "#bdbdbd",
                lineHeight: 1.5,
                marginBottom: 8,
              }}
            >
              {plan.overview}
            </div>
          )}

          {/* Plan body (markdown rendered as readable preformatted text) +
              todos/phases — inset surface so it reads as quoted content. */}
          <div
            style={{
              padding: "8px 12px",
              background: "#0e0e0e",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 7,
              fontSize: 12.5,
              lineHeight: 1.55,
              color: "#dcdcdc",
              maxHeight: 260,
              overflowY: "auto",
              marginBottom: 10,
            }}
          >
            {plan.plan && (
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {plan.plan}
              </div>
            )}
            {plan.phases.length > 0
              ? plan.phases.map((ph, i) => (
                  <div key={i} style={{ marginTop: plan.plan || i > 0 ? 10 : 0 }}>
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 10.5,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "#9a9a9a",
                      }}
                    >
                      {ph.name}
                    </div>
                    <TodoList todos={ph.todos} />
                  </div>
                ))
              : plan.todos.length > 0 && (
                  <div style={{ marginTop: plan.plan ? 10 : 0 }}>
                    <TodoList todos={plan.todos} />
                  </div>
                )}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: 6,
            }}
          >
            <button
              onClick={() => onReject(plan.id)}
              style={{
                height: 26,
                padding: "0 10px",
                background: "transparent",
                border: "none",
                borderRadius: 6,
                color: "#a8a8a8",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Reject
            </button>
            <button
              onClick={() => onAccept(plan.id)}
              style={{
                height: 26,
                padding: "0 12px",
                background: "#f5f5f5",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 6,
                color: "#0a0a0a",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Accept plan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
