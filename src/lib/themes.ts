export interface ThemeDef {
  id: string;
  name: string;
  type: "dark" | "light";
  description: string;
  // Mini preview colors
  preview: {
    sidebar: string;
    card: string;
    border: string;
    text: string;
    accent: string; // a highlight color shown as a dot
  };
}

export const THEMES: ThemeDef[] = [
  // ── Dark themes ─────────────────────────────────────────
  {
    id: "pure-black",
    name: "Pure Black",
    type: "dark",
    description: "OLED-friendly, everything black",
    preview: { sidebar: "#000000", card: "#000000", border: "#1c1c1c", text: "#f0f0f0", accent: "#333333" },
  },
  {
    id: "zinc",
    name: "Zinc",
    type: "dark",
    description: "Clean neutral dark",
    preview: { sidebar: "#0a0a0a", card: "#141414", border: "#262626", text: "#e0e0e0", accent: "#888888" },
  },
  {
    id: "obsidian",
    name: "Obsidian",
    type: "dark",
    description: "True black, maximum contrast",
    preview: { sidebar: "#000000", card: "#0a0a0a", border: "#222222", text: "#f5f5f5", accent: "#555555" },
  },
  {
    id: "slate",
    name: "Slate",
    type: "dark",
    description: "Cool blue-grey, GitHub style",
    preview: { sidebar: "#0d1117", card: "#161b22", border: "#30363d", text: "#e6edf3", accent: "#5c7fa6" },
  },
  {
    id: "warm",
    name: "Warm",
    type: "dark",
    description: "Brownish tones, easy on the eyes",
    preview: { sidebar: "#0f0e09", card: "#18170f", border: "#2e2c22", text: "#eeead8", accent: "#9c7c4a" },
  },
  {
    id: "one-dark",
    name: "One Dark",
    type: "dark",
    description: "Atom's iconic dark theme",
    preview: { sidebar: "#21252b", card: "#282c34", border: "#3e4451", text: "#abb2bf", accent: "#61afef" },
  },
  {
    id: "dracula",
    name: "Dracula",
    type: "dark",
    description: "Dark with purple accents",
    preview: { sidebar: "#191a21", card: "#21222c", border: "#44475a", text: "#f8f8f2", accent: "#bd93f9" },
  },
  {
    id: "catppuccin",
    name: "Catppuccin Mocha",
    type: "dark",
    description: "Pastel dark, soothing palette",
    preview: { sidebar: "#181825", card: "#1e1e2e", border: "#45475a", text: "#cdd6f4", accent: "#cba6f7" },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    type: "dark",
    description: "Deep blue night aesthetic",
    preview: { sidebar: "#16161e", card: "#1a1b26", border: "#292e42", text: "#c0caf5", accent: "#7aa2f7" },
  },
  {
    id: "nord",
    name: "Nord",
    type: "dark",
    description: "Arctic, blue-tinted nordic",
    preview: { sidebar: "#242933", card: "#2e3440", border: "#434c5e", text: "#eceff4", accent: "#88c0d0" },
  },
  {
    id: "vesper",
    name: "Vesper",
    type: "dark",
    description: "Minimal dark with warm orange",
    preview: { sidebar: "#0d0d0d", card: "#101010", border: "#222222", text: "#eeeeee", accent: "#ff9966" },
  },
  {
    id: "viper",
    name: "Viper",
    type: "dark",
    description: "Deep black with jade green undertones",
    preview: { sidebar: "#070807", card: "#0b0d0b", border: "#202520", text: "#e3ede5", accent: "#3dba7e" },
  },
  // ── Light themes ─────────────────────────────────────────
  {
    id: "light",
    name: "Default Light",
    type: "light",
    description: "Clean and minimal",
    preview: { sidebar: "#e3e4e7", card: "#f7f7f8", border: "#d9d9dc", text: "#111111", accent: "#888888" },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    type: "light",
    description: "Familiar developer UI",
    preview: { sidebar: "#f6f8fa", card: "#ffffff", border: "#d0d7de", text: "#24292f", accent: "#0969da" },
  },
];

export function getTheme(id: string): ThemeDef {
  return THEMES.find(t => t.id === id) ?? THEMES[0]!;
}
