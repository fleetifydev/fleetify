//! Shared test fixtures. Only compiled in tests via `#[cfg(test)]`
//! gating at the call sites, but kept in a regular module so the
//! `static` Mutex has a single canonical definition.

/// Mutex tests must hold while mutating `HOME` / `USERPROFILE`.
/// Multiple modules' tests touch these env vars; serialising on a
/// single static keeps them from racing each other.
pub fn home_lock() -> &'static std::sync::Mutex<()> {
    static M: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(()))
}
