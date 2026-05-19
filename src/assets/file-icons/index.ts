// Auto-generated icon registry — Material Icon Theme SVGs (local bundle)
import python   from "./python.svg?url";
import javascript from "./javascript.svg?url";
import typescript from "./typescript.svg?url";
import react    from "./react.svg?url";
import react_ts from "./react_ts.svg?url";
import json     from "./json.svg?url";
import markdown from "./markdown.svg?url";
import html     from "./html.svg?url";
import css      from "./css.svg?url";
import sass     from "./sass.svg?url";
import rust     from "./rust.svg?url";
import go       from "./go.svg?url";
import java     from "./java.svg?url";
import kotlin   from "./kotlin.svg?url";
import ruby     from "./ruby.svg?url";
import php      from "./php.svg?url";
import swift    from "./swift.svg?url";
import c        from "./c.svg?url";
import cpp      from "./cpp.svg?url";
import csharp   from "./csharp.svg?url";
import yaml     from "./yaml.svg?url";
import toml     from "./toml.svg?url";
import database from "./database.svg?url";
import svgIcon  from "./svg.svg?url";
import image    from "./image.svg?url";
import pdf      from "./pdf.svg?url";
import log      from "./log.svg?url";
import xml      from "./xml.svg?url";
import lock     from "./lock.svg?url";
import zip      from "./zip.svg?url";
import nodejs   from "./nodejs.svg?url";
import tsconfig from "./tsconfig.svg?url";
import docker   from "./docker.svg?url";
import git      from "./git.svg?url";
import vite     from "./vite.svg?url";
import prettier from "./prettier.svg?url";
import eslint   from "./eslint.svg?url";
import makefile from "./makefile.svg?url";
import less     from "./less.svg?url";
import table    from "./table.svg?url";
import tailwind from "./tailwindcss.svg?url";
import powershell from "./powershell.svg?url";

// extension → icon URL
export const EXT_ICON_URL: Record<string, string> = {
  // Python
  py: python, pyw: python,
  // JavaScript
  js: javascript, mjs: javascript, cjs: javascript,
  // TypeScript
  ts: typescript,
  // React
  jsx: react, tsx: react_ts,
  // Data
  json: json, jsonc: json,
  // Docs
  md: markdown, mdx: markdown,
  // Web
  html: html, htm: html,
  css: css,
  scss: sass, sass: sass, less: less,
  // Systems
  rs: rust, go: go,
  c: c, cpp: cpp, h: c,
  cs: csharp,
  // JVM
  java: java, kt: kotlin,
  // Other langs
  rb: ruby, php: php, swift: swift,
  // Config
  yml: yaml, yaml: yaml, toml: toml, xml: xml,
  // Shell
  sh: powershell, bash: powershell, zsh: powershell,
  // DB
  sql: database, db: database,
  // Images
  svg: svgIcon, png: image, jpg: image, jpeg: image, gif: image, webp: image, ico: image, bmp: image,
  // Misc
  pdf: pdf, log: log, csv: table, tsv: table,
  lock: lock, zip: zip, gz: zip, tar: zip, rar: zip,
};

// filename → icon URL (exact match, lowercase)
export const FILE_ICON_URL: Record<string, string> = {
  "package.json":         nodejs,
  "package-lock.json":   nodejs,
  "tsconfig.json":       tsconfig,
  "tsconfig.base.json":  tsconfig,
  "jsconfig.json":       tsconfig,
  "dockerfile":          docker,
  "docker-compose.yml":  docker,
  "docker-compose.yaml": docker,
  ".dockerignore":       docker,
  ".gitignore":          git,
  ".gitattributes":      git,
  ".gitmodules":         git,
  "vite.config.ts":      vite,
  "vite.config.js":      vite,
  "tailwind.config.js":  tailwind,
  "tailwind.config.ts":  tailwind,
  ".prettierrc":         prettier,
  ".prettierrc.js":      prettier,
  ".prettierrc.json":    prettier,
  "prettier.config.js":  prettier,
  ".eslintrc":           eslint,
  ".eslintrc.js":        eslint,
  ".eslintrc.json":      eslint,
  ".eslintrc.cjs":       eslint,
  "eslint.config.js":    eslint,
  "makefile":            makefile,
  "readme.md":           markdown,
  "changelog.md":        markdown,
};
