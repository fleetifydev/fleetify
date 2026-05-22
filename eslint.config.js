import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "electron/**/*.cjs",
      "*.config.{js,ts}",
      // Build artefacts — Cargo + Tauri codegen drop .js stubs under
      // target/ that eslint's tseslint preset otherwise tries to parse
      // and chokes on (binary-ish content, 100s of files per worktree).
      "**/target/**",
      ".claude/**",
      "src-tauri/gen/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler lint rules describe optimization opportunities, not
      // bugs. Surface them as warnings but don't block CI — addressing them
      // properly needs a focused refactor of effect/memo patterns across
      // the renderer.
      "react-hooks/set-state-in-effect":        "warn",
      "react-hooks/static-components":          "warn",
      "react-hooks/purity":                     "warn",
      "react-hooks/immutability":               "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/refs":                       "warn",
      // Surface real bugs, not stylistic noise. The codebase still has many
      // generic-tools `any` casts; warn instead of error so lint stays useful.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "prefer-const": "warn",
    },
  },
);
