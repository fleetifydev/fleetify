.PHONY: dev build test fmt lint

dev:
	cargo tauri dev

build:
	cargo tauri build

test:
	cargo test --workspace

fmt:
	cargo fmt --all

lint:
	cargo clippy --workspace --all-targets
