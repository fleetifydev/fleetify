# Fleetify (Rust + Tauri)

Faithful Rust+Tauri rebuild of Fleetify. One Tauri v2 process; embedded axum
backend on 127.0.0.1:8765 serving the React UI + API. See
`docs/superpowers/specs/2026-05-19-fleetify-rust-tauri-rebuild-design.md` in the
original repo for the full analysis & design.

## Dev
- `make dev` — Vite (:3000) + `cargo tauri dev`

## Build
- `make build` — `cargo tauri build`
