//! `fleet-wipe` — clears Fleetify's OS-credential-store entries as the
//! credential half of `npm run wipe` (the file half lives in `scripts/wipe.mjs`).
//!
//! Why a Rust helper instead of a CLI inside wipe.mjs? The app stores secrets
//! through the `keyring` crate, whose backend differs per OS — and on Linux
//! that backend is the **kernel keyring** (`linux-keyutils`), *not* the Secret
//! Service. So `secret-tool` (what wipe.mjs used) targets the wrong store and
//! the OIDC refresh token survives a wipe → the app silently re-logs-in on the
//! next launch. This helper clears creds the SAME way the app wrote them.
//!
//! - Linux: enumerate the session + persistent kernel keyrings and invalidate
//!   every `keyring-rs:*@Fleetify*` key (OIDC refresh token, GitHub link,
//!   per-provider keys, per-router keys).
//! - macOS: wipe.mjs's `security delete-generic-password` already clears the
//!   login Keychain; here we also delete the refresh-token entry via the
//!   keyring crate as a backstop.
//! - Windows: same backstop, behind wipe.mjs's `cmdkey`.
//!
//! Reads only key *descriptions* (never secret values) and only ever touches
//! keys whose service is `Fleetify` / `Fleetify-*`. Pass `--dry-run` (or
//! `--check`) to list what WOULD be removed without changing anything.

fn main() {
    let dry = std::env::args()
        .skip(1)
        .any(|a| a == "--dry-run" || a == "--check");
    let removed = wipe(dry);
    let verb = if dry { "would remove" } else { "removed" };
    println!("fleet-wipe: {verb} {removed} Fleetify credential(s)");
}

/// True for `keyring`-crate key descriptions that belong to Fleetify. The
/// linux-keyutils backend names keys `keyring-rs:<account>@<service>`; we match
/// on the `<service>` half being `Fleetify` or `Fleetify-*` so a stray
/// `NotFleetify` or another app's key is never touched.
// Only the Linux `wipe` enumerates key descriptions; on Windows/macOS this
// helper is unused, so silence dead-code there (keeps `clippy -D warnings` green).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_fleetify_desc(desc: &str) -> bool {
    let Some(rest) = desc.strip_prefix("keyring-rs:") else {
        return false;
    };
    let Some(at) = rest.rfind('@') else {
        return false;
    };
    let service = &rest[at + 1..];
    service == "Fleetify" || service.starts_with("Fleetify-")
}

#[cfg(target_os = "linux")]
fn wipe(dry: bool) -> usize {
    use linux_keyutils::{KeyRing, KeyRingIdentifier};
    use std::collections::HashSet;

    // The keyring crate adds keys to the SESSION keyring and links them into the
    // PERSISTENT keyring (keyring-3 `keyutils.rs::set_secret`). Scan both — plus
    // the user/process keyrings — so we catch the key wherever it's linked.
    let mut rings: Vec<KeyRing> = Vec::new();
    for id in [
        KeyRingIdentifier::Session,
        KeyRingIdentifier::UserSession,
        KeyRingIdentifier::User,
        KeyRingIdentifier::Process,
        KeyRingIdentifier::Thread,
    ] {
        if let Ok(r) = KeyRing::from_special_id(id, false) {
            rings.push(r);
        }
    }
    if let Ok(p) = KeyRing::get_persistent(KeyRingIdentifier::Session) {
        rings.push(p);
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut count = 0usize;
    for ring in &rings {
        // get_links lists DIRECT links only (non-recursive) — exactly what we
        // want since the backend links Fleetify keys directly into these rings.
        let Ok(links) = ring.get_links(1000) else {
            continue;
        };
        for node in links.iter() {
            let Some(key) = node.as_key() else { continue };
            let Ok(meta) = key.metadata() else { continue };
            let desc = meta.get_description();
            if !is_fleetify_desc(desc) {
                continue;
            }
            // A key linked into several rings shows up once per ring; dedupe by
            // description so the count is honest and we don't double-invalidate.
            if !seen.insert(desc.to_string()) {
                continue;
            }
            count += 1;
            println!("  {} {desc}", if dry { "·" } else { "✓" });
            if !dry {
                if let Err(e) = key.invalidate() {
                    eprintln!("    ! failed to invalidate {desc}: {e:?}");
                }
            }
        }
    }
    count
}

#[cfg(not(target_os = "linux"))]
fn wipe(dry: bool) -> usize {
    // macOS Keychain / Windows Credential Manager. wipe.mjs's `security` /
    // `cmdkey` enumeration clears every `Fleetify*` service by name; this is a
    // backstop that removes the fixed login refresh-token entry directly via the
    // keyring crate so "still signed in" can't survive even if that step was
    // skipped. (Provider/GitHub/router entries are keyed by the OIDC sub, which
    // we don't have here — those rely on the wipe.mjs enumeration.)
    let entry = match keyring::Entry::new("Fleetify", "refresh_token") {
        Ok(e) => e,
        Err(e) => {
            eprintln!("fleet-wipe: keyring unavailable: {e}");
            return 0;
        }
    };
    if dry {
        return match entry.get_password() {
            Ok(_) => {
                println!("  · refresh_token@Fleetify");
                1
            }
            _ => 0,
        };
    }
    match entry.delete_credential() {
        Ok(()) => {
            println!("  ✓ refresh_token@Fleetify");
            1
        }
        Err(keyring::Error::NoEntry) => 0,
        Err(e) => {
            eprintln!("fleet-wipe: delete failed: {e}");
            0
        }
    }
}
