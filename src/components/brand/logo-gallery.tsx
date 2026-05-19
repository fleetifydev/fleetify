/**
 * Logo gallery — side-by-side comparison of every Fleetify mark variant.
 *
 * Renders each variant at four sizes (favicon 16, sidebar 22, hub 36,
 * splash 96) so you can judge how it holds up across the actual
 * surfaces it'll appear on. Underneath each row: the wordmark next
 * to the mark, both light + dark backgrounds, so you see how the
 * pairing reads in the real chrome.
 *
 * Navigate to <app>/#logos to view. The hash check in App.tsx swaps
 * normal app rendering for this gallery — pure dev tool, never
 * shipped to end users.
 *
 * To pick: identify your favourite by id (e.g. "trio") and tell me;
 * I'll wire it into LogoMark + Wordmark + favicon + everywhere else.
 */
import { LOGO_VARIANTS } from "./logo-variants";

const SIZES = [16, 22, 36, 96] as const;

export function LogoGallery() {
  return (
    // FIXED 100vh + overflowY:auto so the gallery scrolls INTERNALLY.
    // Was minHeight:100vh which let the element grow past the viewport
    // — but globals.css locks #root + body + html to height:100% with
    // overflow:hidden (Electron pattern), so the overflow was clipped
    // and the rest of the gallery became unreachable. Fixed height
    // forces overflowY:auto to actually produce a working scrollbar.
    <div style={{
      height: "100vh", overflowY: "auto",
      background: "#0a0a0a", color: "#fff",
      padding: "32px 40px",
      fontFamily: "var(--font-sans, system-ui), sans-serif",
    }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ marginBottom: 32 }}>
          <h1 style={{
            margin: 0,
            fontSize: 32, fontWeight: 600, letterSpacing: "-0.01em",
            fontFamily: "'Playfair Display Variable', Georgia, serif",
          }}>
            Fleetify · Logo gallery
          </h1>
          <p style={{
            margin: "6px 0 0", fontSize: 13, color: "rgba(255,255,255,0.55)",
            lineHeight: 1.55, maxWidth: 640,
          }}>
            Eight monochrome marks, each a single concept. Compare across
            sizes (favicon, sidebar, hub, splash) and against the
            wordmark on light + dark surfaces. Pick the one that
            stays distinctive at 16px AND feels considered at 96px —
            that's the hardest test for a brand mark.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {LOGO_VARIANTS.map(({ id, name, concept, Component }, idx) => (
            <div key={id} style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {idx === 0 && (
              <SectionHeader
                title="Batch 3 — sophistication"
                subtitle="Multi-layer compositions, organic curves, custom typography. The most considered set. Start here."
              />
            )}
            {idx === 6 && (
              <SectionHeader
                title="Batch 2 — bolder direction"
                subtitle="Maritime metaphors, custom letterforms, negative space. One concept per mark."
              />
            )}
            {idx === 14 && (
              <SectionHeader
                title="Batch 1 — safer geometric"
                subtitle="The original eight. Kept for comparison; the batches above are the recommended picks."
              />
            )}
            <div
              style={{
                background: "#141414",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12,
                padding: "20px 24px",
                display: "flex", flexDirection: "column", gap: 18,
              }}
            >
              {/* Row header — name + id + concept */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 18, fontWeight: 600 }}>{name}</span>
                <code style={{
                  fontSize: 11, color: "rgba(255,255,255,0.4)",
                  background: "rgba(255,255,255,0.05)",
                  padding: "2px 7px", borderRadius: 4,
                  fontFamily: "'SF Mono', monospace",
                }}>
                  id: {id}
                </code>
                <span style={{
                  fontSize: 12.5, color: "rgba(255,255,255,0.55)",
                  flex: 1, minWidth: 200, lineHeight: 1.5,
                }}>
                  {concept}
                </span>
              </div>

              {/* Size sweep */}
              <div style={{
                display: "flex", alignItems: "center", gap: 32,
                padding: "16px 20px",
                background: "#0a0a0a",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 8,
              }}>
                {SIZES.map((sz) => (
                  <div key={sz} style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
                  }}>
                    <Component size={sz} color="#fff" />
                    <span style={{
                      fontSize: 10, color: "rgba(255,255,255,0.35)",
                      fontFamily: "'SF Mono', monospace",
                    }}>
                      {sz}px
                    </span>
                  </div>
                ))}
              </div>

              {/* Wordmark pairing — dark + light surface */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <WordmarkPair Component={Component} bg="#0a0a0a" fg="#fff"/>
                <WordmarkPair Component={Component} bg="#fafafa" fg="#0a0a0a"/>
              </div>
            </div>
            </div>
          ))}
        </div>

        <p style={{
          marginTop: 32, fontSize: 12, color: "rgba(255,255,255,0.4)",
          textAlign: "center",
        }}>
          Pick one and tell me the id — I'll wire it into LogoMark,
          favicon, splash, and the splash + auth screens.
        </p>
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{
      padding: "18px 4px 6px",
      borderTop: "1px solid rgba(255,255,255,0.08)",
    }}>
      <h2 style={{
        margin: 0,
        fontSize: 18, fontWeight: 600,
        letterSpacing: "-0.005em",
        color: "#fff",
      }}>{title}</h2>
      <p style={{
        margin: "4px 0 0",
        fontSize: 12.5, color: "rgba(255,255,255,0.5)",
        lineHeight: 1.5,
      }}>{subtitle}</p>
    </div>
  );
}

function WordmarkPair({
  Component, bg, fg,
}: {
  Component: (typeof LOGO_VARIANTS)[number]["Component"];
  bg: string;
  fg: string;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "18px 20px",
      background: bg,
      borderRadius: 8,
      border: bg === "#fafafa" ? "1px solid rgba(0,0,0,0.06)" : "1px solid rgba(255,255,255,0.05)",
    }}>
      <Component size={28} color={fg}/>
      <span style={{
        fontSize: 22, fontWeight: 500, letterSpacing: "0.04em",
        fontFamily: "'Playfair Display Variable', Georgia, serif",
        color: fg, lineHeight: 1,
      }}>
        Fleetify
      </span>
    </div>
  );
}
