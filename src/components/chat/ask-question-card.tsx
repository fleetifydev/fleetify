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
          // Same surface as the composer / sidebar: sharp 8px card, hairline
          // border, sidebar-matched background. Fully monochrome — no accent.
          borderRadius: 8,
          border: "1px solid var(--c-brd)",
          background: "var(--chat-input-bg)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "11px 13px" }}>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.3px",
              textTransform: "uppercase",
              color: "var(--c-dim)",
              marginBottom: 9,
            }}
          >
            Question
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
                    color: "var(--c-high)",
                    lineHeight: 1.45,
                    marginBottom: 8,
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
                        onMouseEnter={e => { if (!isOn) (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--fg-rgb),0.04)"; }}
                        onMouseLeave={e => { if (!isOn) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 9,
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 11px",
                          borderRadius: 6,
                          // Monochrome selection — selected = subtle fill +
                          // brighter hairline, same language as the dropdowns.
                          border: `1px solid ${isOn ? "var(--c-brd2)" : "var(--c-brd)"}`,
                          background: isOn ? "rgba(var(--fg-rgb),0.07)" : "transparent",
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
                            borderRadius: multi ? 4 : "50%",
                            border: `1.4px solid ${isOn ? "var(--c-high)" : "rgba(var(--fg-rgb),0.30)"}`,
                            background: isOn ? "var(--c-high)" : "transparent",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          {isOn && (
                            <span style={{
                              width: multi ? 6 : 5, height: multi ? 6 : 5,
                              borderRadius: multi ? 1.5 : "50%",
                              background: "var(--background)",
                            }}/>
                          )}
                        </span>
                        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontWeight: 500, lineHeight: 1.35, color: isOn ? "var(--c-high)" : "var(--c-med)" }}>
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
