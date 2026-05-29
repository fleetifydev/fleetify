/* ── Official AI Provider Logos ── */

import { useThemeStore } from "@/stores/theme-store";

// CLI-agent brand marks bundled as SVG files (lobehub / homarr-labs) and
// rendered via <img> — that isolates each file's internal gradient/mask
// ids (so the same icon can render twice with no id collision) and paints
// their real brand colours on any theme. `ProviderLogo` routes the agent
// tool ids to these; the inline components below stay for other surfaces.
import claudeIcon from "./agent-icons/claude.svg";
import codexIcon from "./agent-icons/codex.svg";
import geminiIcon from "./agent-icons/gemini.svg";
import opencodeIcon from "./agent-icons/opencode.svg";
import opencodeLightIcon from "./agent-icons/opencode-light.svg";
import kimiIcon from "./agent-icons/kimi.svg";
import antigravityIcon from "./agent-icons/antigravity.svg";
// Model-provider marks. Colour marks go through <ImgIcon>; the ones that
// only ship as a single-colour "for dark background" variant (Ollama,
// OpenAI) go through <MaskIcon> so they adapt to the theme. Grok + OpenCode
// ship a distinct per-theme asset each, so they go through <ThemedImgIcon>.
import perplexityIcon from "./agent-icons/perplexity.svg";
import openaiIcon from "./agent-icons/openai.png";
import deepseekIcon from "./agent-icons/deepseek.svg";
import grokIcon from "./agent-icons/grok.svg";
import grokDarkIcon from "./agent-icons/grok-dark.png";
import nvidiaIcon from "./agent-icons/nvidia.svg";
import ollamaIcon from "./agent-icons/ollama.svg";

/** Render a bundled brand SVG as an <img>. objectFit keeps a non-square
 *  mark (e.g. OpenCode's 4:5) from stretching into the square slot. */
function ImgIcon({ src, size, label }: { src: string; size: number; label: string }) {
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={label}
      draggable={false}
      style={{ objectFit: "contain", display: "block", flexShrink: 0 }}
    />
  );
}

/** Render a brand mark that ships a distinct asset per theme — the
 *  vendor's light-background variant on the light theme, the dark-
 *  background variant on the dark theme. Used for marks where a single
 *  recoloured asset reads poorly (Grok's white PNG, OpenCode's two-tone
 *  square). Reactively follows `useThemeStore`. */
function ThemedImgIcon({
  light,
  dark,
  size,
  label,
}: {
  light: string;
  dark: string;
  size: number;
  label: string;
}) {
  const theme = useThemeStore((s) => s.theme);
  return <ImgIcon src={theme === "dark" ? dark : light} size={size} label={label} />;
}

/** Render a MONOCHROME mark as a CSS mask painted with currentColor, so a
 *  "for dark background" white-only asset adapts to light/dark instead of
 *  vanishing on one of them. Masks on the alpha channel, so the asset's own
 *  colour is irrelevant — works for both SVG and PNG sources. */
function MaskIcon({ src, size, label }: { src: string; size: number; label: string }) {
  const mask = `url(${src}) center / contain no-repeat`;
  return (
    <span
      role="img"
      aria-label={label}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flexShrink: 0,
        backgroundColor: "currentColor",
        WebkitMask: mask,
        mask,
      }}
    />
  );
}

export function ClaudeLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#D97757" role="img">
      <path d="M4.7144 15.9555l4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

export function OpenAILogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" role="img">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

export function GeminiLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#8E75B2" role="img">
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
  );
}

export function CodexLogo({ size = 18 }: { size?: number }) {
  // Codex is OpenAI's product — uses OpenAI logo with green tint
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#10A37F" role="img">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

export function AiderLogo({ size = 18 }: { size?: number }) {
  // Aider has no official SVG icon — using terminal prompt style
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img">
      <rect width="24" height="24" rx="5" fill="#14b014" />
      <text x="4" y="17" fontFamily="monospace" fontSize="14" fontWeight="bold" fill="white">a&gt;</text>
    </svg>
  );
}

export function OpenCodeLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img">
      <rect width="24" height="24" rx="5" fill="#6366F1" />
      <path d="M9 8L5 12L9 16M15 8L19 12L15 16" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CustomAgentLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img">
      <rect width="24" height="24" rx="5" fill="#525252" />
      <path d="M12 8L8 12L12 16M12 8L16 12L12 16" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
    </svg>
  );
}

/* ── Ollama: stylized llama silhouette derived from the official mark ── */
export function OllamaLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" role="img">
      {/* Compact llama-head silhouette: rounded body with two upward ears.
          Matches Ollama's monochrome brand without copying the exact mark. */}
      <path d="M7.4 2.2c-.8 0-1.5.6-1.5 1.4v3.1C4.3 7.5 3 9.3 3 11.5v6.2c0 1.7 1.4 3.1 3.1 3.1h11.8c1.7 0 3.1-1.4 3.1-3.1v-6.2c0-2.2-1.3-4-2.9-4.8V3.6c0-.8-.7-1.4-1.5-1.4-.8 0-1.5.6-1.5 1.4v2.5h-1V3.6c0-.8-.7-1.4-1.5-1.4-.8 0-1.5.6-1.5 1.4v2.5h-1V3.6c0-.8-.7-1.4-1.5-1.4ZM9 12.7c.7 0 1.2.5 1.2 1.2 0 .7-.5 1.2-1.2 1.2-.7 0-1.2-.5-1.2-1.2 0-.7.5-1.2 1.2-1.2Zm6 0c.7 0 1.2.5 1.2 1.2 0 .7-.5 1.2-1.2 1.2-.7 0-1.2-.5-1.2-1.2 0-.7.5-1.2 1.2-1.2Z" />
    </svg>
  );
}

/* ── Kimi (Moonshot): crescent moon mark ── */
export function KimiLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img">
      <defs>
        <linearGradient id="kimi-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7C5CFF" />
          <stop offset="100%" stopColor="#3DC7FF" />
        </linearGradient>
      </defs>
      {/* Crescent moon — the Moonshot brand element. Drawn as one solid
          shape with a single offset-circle subtraction. */}
      <path
        d="M 12 2.5 a 9.5 9.5 0 1 0 9.2 11.8 A 7.6 7.6 0 0 1 11 5 a 9.5 9.5 0 0 1 1 -2.5 Z"
        fill="url(#kimi-grad)"
      />
    </svg>
  );
}

/* ── Antigravity (agy): orbital arc with rising mass ── */
export function AgyLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label="Antigravity CLI">
      {/* Gravity-well arc + an arrow rising through it — reads as
          "anti-gravity" without copying Google's specific brand mark. */}
      <defs>
        <linearGradient id="agy-grad" x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4F8AFF" />
          <stop offset="100%" stopColor="#9D6BFF" />
        </linearGradient>
      </defs>
      <path
        d="M 3.5 16 a 9 9 0 0 1 17 0"
        stroke="url(#agy-grad)"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M 12 21 L 12 6 M 8.5 9.5 L 12 6 L 15.5 9.5"
        stroke="url(#agy-grad)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ── Cursor: official brand mark from cursor.com favicon ── */
export function CursorLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" role="img" aria-label="Cursor">
      {/* Hexagonal silhouette with an inner cursor-pointer cutout —
          the actual Cursor brand mark, sourced from cursor.com/favicon.svg.
          Uses currentColor + evenodd so the cutout reads as a true
          hollow against any background. */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
        d="m415.035 156.35-151.503-87.4695c-4.865-2.8094-10.868-2.8094-15.733 0l-151.4969 87.4695c-4.0897 2.362-6.6146 6.729-6.6146 11.459v176.383c0 4.73 2.5249 9.097 6.6146 11.458l151.5039 87.47c4.865 2.809 10.868 2.809 15.733 0l151.504-87.47c4.089-2.361 6.614-6.728 6.614-11.458v-176.383c0-4.73-2.525-9.097-6.614-11.459zm-9.516 18.528-146.255 253.32c-.988 1.707-3.599 1.01-3.599-.967v-165.872c0-3.314-1.771-6.379-4.644-8.044l-143.645-82.932c-1.707-.988-1.01-3.599.968-3.599h292.509c4.154 0 6.75 4.503 4.673 8.101h-.007z"
      />
    </svg>
  );
}

/* ── DeepSeek: stylized whale mark in their brand blue ── */
export function DeepSeekLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label="DeepSeek">
      <path
        d="M20.5 6.5c-.5-.4-1.4-.2-2.4.4-.7-.9-1.8-1.5-3-1.5-1.7 0-3.2 1.2-3.7 2.8-1.4-.3-3 0-4.2 1-1.4 1.2-2 3-1.4 4.7.4 1.3 1.5 2.3 2.8 2.7l.4 2.5c.1.5.5.9 1 .9h6c.5 0 .9-.4 1-.9l.5-2.7c1.6-.7 2.8-2.3 2.8-4.1 0-1.6-.9-3.1-2.4-3.8.5-.8.8-1.5.6-2zM10.5 13c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm5 0c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"
        fill="#4D6BFE"
      />
    </svg>
  );
}

/* ── Grok (xAI): bold X mark ── */
export function GrokLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label="Grok">
      <path
        d="M4 4l7.5 8L4 20h3l5.8-6.2L18 20h3l-7.5-8L20.5 4h-3L12.7 10 7.5 4z"
        fill="currentColor"
      />
    </svg>
  );
}

/* ── NVIDIA: green eye logo abstraction ── */
export function NvidiaLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label="NVIDIA">
      <path
        d="M9.5 7.5c-3.6 0-6 2.6-6 4.5s2 4.5 6 4.5c3.4 0 6-2 7.5-4-1.2.8-2.5 1.3-3.7 1.3-2 0-3.5-1.4-3.5-2.8 0-1.5 1.6-2.8 3.5-2.8 1.2 0 2.5.4 3.7 1.2-1.5-2-4-2.9-7.5-2.9zm0 2c1.4 0 2.6.5 3.3 1.2-.9-.3-1.8-.4-2.6-.4-1.7 0-3.2 1-3.2 2.2 0 1.1 1.5 2.2 3.2 2.2.8 0 1.7-.1 2.6-.4-.7.7-1.9 1.2-3.3 1.2-2.5 0-4-1.4-4-2.9 0-1.6 1.5-3.1 4-3.1z"
        fill="#76B900"
      />
    </svg>
  );
}

/* ── Perplexity: blue "P" with citation arc ── */
export function PerplexityLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label="Perplexity">
      <path
        d="M12 2.5L4 7v10l8 4.5L20 17V7L12 2.5zm0 2.3l5.5 3.1v8.2L12 19.2 6.5 16.1V7.9L12 4.8zm-2 5.2v6h1.5v-2.3h.7l1.5 2.3h1.8l-1.7-2.5c.7-.3 1.2-1 1.2-1.8 0-1.2-.9-2-2.2-2H10zm1.5 1.4h1.3c.6 0 1 .3 1 .8s-.4.8-1 .8h-1.3v-1.6z"
        fill="#20B8CD"
      />
    </svg>
  );
}

/* ── Groq: simple coral G in Groq's brand color ── */
export function GroqLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img">
      {/* Open ring with a tail — abstract "G" suggesting Groq's
          asymmetric geometric mark. Uses brand coral on transparent. */}
      <path
        d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"
        stroke="#F55036"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M12 12h6"
        stroke="#F55036"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── GitHub Copilot: official mark. The source SVG paints it solid white
 *  (the "dark background" variant); we drop that fill so the path inherits
 *  currentColor and adapts to light/dark themes, with the eyes as evenodd
 *  cut-outs. ── */
export function GitHubCopilotLogo({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 2.5 24 19"
      fill="currentColor"
      fillRule="evenodd"
      role="img"
      aria-label="GitHub Copilot"
    >
      <path d="M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z" />
    </svg>
  );
}

/* ── Get logo by tool name ── */
export function ProviderLogo({ tool, size = 18 }: { tool: string; size?: number }) {
  switch (tool) {
    case "claude":     return <ImgIcon src={claudeIcon} size={size} label="Claude Code" />;
    case "anthropic":  return <ImgIcon src={claudeIcon} size={size} label="Claude Code" />;
    case "codex":      return <ImgIcon src={codexIcon} size={size} label="Codex" />;
    case "cursor":     return <CursorLogo size={size} />;
    case "gemini":     return <ImgIcon src={geminiIcon} size={size} label="Gemini" />;
    case "ollama":     return <MaskIcon src={ollamaIcon} size={size} label="Ollama" />;
    case "kimi":       return <ImgIcon src={kimiIcon} size={size} label="Kimi" />;
    case "kimi-api":   return <ImgIcon src={kimiIcon} size={size} label="Kimi" />;
    case "openai":     return <MaskIcon src={openaiIcon} size={size} label="OpenAI" />;
    case "groq":       return <GroqLogo size={size} />;
    case "deepseek":   return <ImgIcon src={deepseekIcon} size={size} label="DeepSeek" />;
    case "grok":       return <ThemedImgIcon light={grokIcon} dark={grokDarkIcon} size={size} label="Grok" />;
    case "nvidia-nim": return <ImgIcon src={nvidiaIcon} size={size} label="NVIDIA" />;
    case "perplexity": return <ImgIcon src={perplexityIcon} size={size} label="Perplexity" />;
    case "gemini-api": return <ImgIcon src={geminiIcon} size={size} label="Gemini" />;
    case "agy":            return <ImgIcon src={antigravityIcon} size={size} label="Antigravity" />;
    case "antigravity":    return <ImgIcon src={antigravityIcon} size={size} label="Antigravity" />;
    case "antigravity-sdk":return <ImgIcon src={antigravityIcon} size={size} label="Antigravity" />;
    case "github-copilot": return <GitHubCopilotLogo size={size} />;
    case "opencode":   return <ThemedImgIcon light={opencodeLightIcon} dark={opencodeIcon} size={size} label="OpenCode" />;
    case "aider":      return <AiderLogo size={size} />;
    default:           return <CustomAgentLogo size={size} />;
  }
}

export function providerName(tool: string): string {
  const names: Record<string, string> = {
    claude: "Claude", codex: "Codex", cursor: "Cursor", gemini: "Gemini",
    ollama: "Ollama", kimi: "Kimi", agy: "Antigravity CLI",
    "antigravity-sdk": "Antigravity SDK",
    opencode: "OpenCode", "github-copilot": "GitHub Copilot", aider: "Aider",
  };
  return names[tool] ?? "Custom";
}
