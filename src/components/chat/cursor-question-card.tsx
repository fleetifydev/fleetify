import { useState } from "react";
import type { CursorQuestion } from "@/stores/chat-store";

interface Props {
  question: CursorQuestion;
  /** Submit the user's selections as an `answered` outcome. */
  onAnswer: (id: string, outcome: Record<string, unknown>) => void;
  /** Skip the question (Cursor continues without an answer). */
  onSkip: (id: string) => void;
}

const MONO = "'SF Mono','Menlo','Monaco','Consolas',monospace";
const ACCENT = "#7C6AF7";

/* Cursor `cursor/ask_question` — a multiple-choice card. Single-select
 * questions use radios; `allowMultiple` ones use checkboxes. Mirrors the
 * permission-dialog surface tokens so it reads as part of the composer. */
export function CursorQuestionCard({ question, onAnswer, onSkip }: Props) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  const toggle = (qId: string, optId: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qId] ?? [];
      if (multi) {
        return {
          ...prev,
          [qId]: cur.includes(optId)
            ? cur.filter((x) => x !== optId)
            : [...cur, optId],
        };
      }
      return { ...prev, [qId]: [optId] };
    });
  };

  const allAnswered = question.questions.every(
    (q) => (selected[q.id] ?? []).length > 0,
  );

  const submit = () => {
    if (!allAnswered) return;
    onAnswer(question.id, {
      outcome: "answered",
      answers: question.questions.map((q) => ({
        questionId: q.id,
        selectedOptionIds: selected[q.id] ?? [],
      })),
    });
  };

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
              marginBottom: 8,
            }}
          >
            <span style={{ color: ACCENT, fontWeight: 600 }}>Question</span>
            <span style={{ color: "#6a6a6a" }}>·</span>
            <span style={{ color: "#c4c4c4", fontWeight: 500 }}>Cursor</span>
          </div>

          {question.title && (
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: "#f5f5f5",
                lineHeight: 1.4,
                marginBottom: 10,
              }}
            >
              {question.title}
            </div>
          )}

          {question.questions.map((q) => {
            const multi = q.allowMultiple ?? false;
            const chosen = selected[q.id] ?? [];
            return (
              <div key={q.id} style={{ marginBottom: 10 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: "#ececec",
                    lineHeight: 1.45,
                    marginBottom: 6,
                  }}
                >
                  {q.prompt}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {q.options.map((opt) => {
                    const isOn = chosen.includes(opt.id);
                    return (
                      <button
                        key={opt.id}
                        onClick={() => toggle(q.id, opt.id, multi)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          width: "100%",
                          textAlign: "left",
                          padding: "7px 10px",
                          borderRadius: 7,
                          border: `1px solid ${isOn ? ACCENT : "rgba(255,255,255,0.10)"}`,
                          background: isOn
                            ? "rgba(124,106,247,0.14)"
                            : "rgba(255,255,255,0.02)",
                          color: "#ececec",
                          fontSize: 12.5,
                          fontFamily: "inherit",
                          cursor: "pointer",
                          transition: "border-color 0.12s, background 0.12s",
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 14,
                            height: 14,
                            flexShrink: 0,
                            borderRadius: multi ? 3 : 7,
                            border: `1px solid ${isOn ? ACCENT : "rgba(255,255,255,0.25)"}`,
                            background: isOn ? ACCENT : "transparent",
                          }}
                        />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: 6,
              marginTop: 4,
            }}
          >
            <button
              onClick={() => onSkip(question.id)}
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
              Skip
            </button>
            <button
              onClick={submit}
              disabled={!allAnswered}
              style={{
                height: 26,
                padding: "0 12px",
                background: allAnswered ? "#f5f5f5" : "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 6,
                color: allAnswered ? "#0a0a0a" : "#7a7a7a",
                fontSize: 12,
                fontWeight: 600,
                cursor: allAnswered ? "pointer" : "not-allowed",
                fontFamily: "inherit",
              }}
            >
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
