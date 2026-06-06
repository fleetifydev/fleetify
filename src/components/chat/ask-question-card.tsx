import { useState } from "react";
import type { AskQuestion } from "@/stores/chat-store";

interface Answer {
  header?: string;
  question: string;
  selected: string[];
}

interface Props {
  question: AskQuestion;
  /** Submit the user's selections (one entry per question). */
  onAnswer: (id: string, answers: Answer[]) => void;
  /** Skip without answering — Claude is told the question was skipped. */
  onSkip: (id: string) => void;
}

const MONO = "'SF Mono','Menlo','Monaco','Consolas',monospace";
const ACCENT = "#7C6AF7";

/* Claude `AskUserQuestion` — an interactive multiple-choice card. Single-
 * select questions use radios, `multiSelect` ones use checkboxes. Options
 * carry an optional description shown as a sub-line. Mirrors the
 * permission-dialog / cursor-question surface tokens so it reads as part of
 * the composer. Selection is keyed by question index + option label. */
export function AskQuestionCard({ question, onAnswer, onSkip }: Props) {
  const [selected, setSelected] = useState<Record<number, string[]>>({});

  const toggle = (qIdx: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qIdx] ?? [];
      if (multi) {
        return {
          ...prev,
          [qIdx]: cur.includes(label)
            ? cur.filter((x) => x !== label)
            : [...cur, label],
        };
      }
      return { ...prev, [qIdx]: [label] };
    });
  };

  const allAnswered = question.questions.every(
    (_, i) => (selected[i] ?? []).length > 0,
  );

  const submit = () => {
    if (!allAnswered) return;
    onAnswer(
      question.id,
      question.questions.map((q, i) => ({
        header: q.header,
        question: q.question,
        selected: selected[i] ?? [],
      })),
    );
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
          </div>

          {question.questions.map((q, qIdx) => {
            const multi = q.multiSelect ?? false;
            const chosen = selected[qIdx] ?? [];
            return (
              <div key={qIdx} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: "#f2f2f2",
                    lineHeight: 1.45,
                    marginBottom: 7,
                  }}
                >
                  {q.question}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {q.options.map((opt) => {
                    const isOn = chosen.includes(opt.label);
                    return (
                      <button
                        key={opt.label}
                        onClick={() => toggle(qIdx, opt.label, multi)}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 9,
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 11px",
                          borderRadius: 8,
                          border: `1px solid ${isOn ? ACCENT : "rgba(var(--fg-rgb),0.10)"}`,
                          background: isOn
                            ? "rgba(124,106,247,0.12)"
                            : "rgba(var(--fg-rgb),0.02)",
                          color: "var(--c-high)",
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
                            marginTop: 1,
                            borderRadius: multi ? 4 : 7,
                            border: `1px solid ${isOn ? ACCENT : "rgba(var(--fg-rgb),0.28)"}`,
                            background: isOn ? ACCENT : "transparent",
                          }}
                        />
                        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontWeight: 500, lineHeight: 1.35 }}>
                            {opt.label}
                          </span>
                          {opt.description && (
                            <span
                              style={{
                                fontSize: 11.5,
                                color: "var(--c-dim)",
                                lineHeight: 1.4,
                              }}
                            >
                              {opt.description}
                            </span>
                          )}
                        </span>
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
                color: "var(--c-dim)",
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
                background: allAnswered ? "var(--c-high)" : "rgba(var(--fg-rgb),0.07)",
                border: "1px solid rgba(var(--fg-rgb),0.12)",
                borderRadius: 6,
                color: allAnswered ? "var(--background)" : "var(--c-low)",
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
