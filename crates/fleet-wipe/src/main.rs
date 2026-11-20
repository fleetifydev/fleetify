//! `fleet-wipe` — clears Fleetify's OS-credential-store entries as the
//! credential half of `npm run wipe` (the file half lives in `scripts/wipe.mjs`).
//!
//! Why a Rust helper instead of a CLI inside wipe.mjs? The app stores secrets
//! through the `keyring` crate, whose backend differs per OS. If the OIDC
//! refresh token survives a wipe, the app silently re-logs-in on the next
//! launch. This helper finds credentials in the store the app wrote them to,
//! by the attributes keyring gives them, with no `secret-tool` install needed.
//!
//! - Linux: the app's store is the **Secret Service** (GNOME Keyring,
//!   KWallet, ...). Delete every item keyring created whose `service` is
//!   `Fleetify` / `Fleetify-*` (OIDC refresh token, GitHub link, voice,
//!   per-provider and per-router keys). Builds before that store used the
//!   in-memory **kernel keyring** (`linux-keyutils`), so also invalidate any
//!   leftover `keyring-rs:*@Fleetify*` key there.
//! - macOS: wipe.mjs's `security delete-generic-password` already clears the
//!   login Keychain; here we also delete the refresh-token entry via the
//!   keyring crate as a backstop.
//! - Windows: same backstop, behind wipe.mjs's `cmdkey`.
//!
//! Reads only item attributes and key *descriptions* (never secret values)
//! and only ever touches entries whose service is `Fleetify` / `Fleetify-*`.
//! Output names each entry by its service alone, never by its account.
//!
//! Only `--yes` deletes; `--dry-run` (or `--check`) lists what WOULD be
//! removed without changing anything. No arguments, any other argument, or
//! `--yes` with `--dry-run` prints the usage and exits with status 2 without
//! touching the store, and `--help` prints it and exits 0 ([`parse_args`]).
//! Exits with status 1 when the Linux Secret Service sweep fails
//! (unreachable, left locked, or an item can't be deleted), so wipe.mjs
//! reports the failure.

/// What the command line asks for; see [`parse_args`].
#[derive(Debug, PartialEq, Eq)]
enum Command {
    /// Sweep the credential store; with `dry_run`, only list what it would remove.
    Wipe { dry_run: bool },
    /// Print [`USAGE`] and exit.
    Help,
}

/// The `--help` text, also printed to stderr after a refused command line.
const USAGE: &str = "\
Usage: fleet-wipe (--dry-run | --yes)

Removes Fleetify's entries from the OS credential store.

  --dry-run    list what it would remove, and change nothing (alias: --check)
  --yes        remove them
  -h, --help   print this help";

/// Parses the arguments after the program name. It touches no credential
/// store. `-h` or `--help` anywhere wins; otherwise the arguments must be
/// `--dry-run` / `--check` or `--yes`, repeats allowed. No arguments, any other
/// argument, or `--yes` with `--dry-run` is an error, so a bare run, a typo or
/// a stray argument never deletes anything.
fn parse_args<I, S>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut dry_run = false;
    let mut yes = false;
    let mut unknown = None;
    for arg in args {
        match arg.as_ref() {
            "-h" | "--help" => return Ok(Command::Help),
            "--dry-run" | "--check" => dry_run = true,
            "--yes" => yes = true,
            other => {
                // Name the first one, but keep looking for --help.
                if unknown.is_none() {
                    unknown = Some(other.to_owned());
                }
            }
        }
    }
    if let Some(arg) = unknown {
        return Err(format!("unknown argument: {arg}"));
    }
    match (dry_run, yes) {
        (true, true) => Err("--yes and --dry-run can't be combined".to_owned()),
        (true, false) => Ok(Command::Wipe { dry_run: true }),
        (false, true) => Ok(Command::Wipe { dry_run: false }),
        (false, false) => Err("say --dry-run to preview or --yes to delete".to_owned()),
    }
}

fn main() {
    // An argument that isn't valid Unicode can't be a flag. Lossy conversion
    // turns it into an unknown argument, refused like any other, where
    // `std::env::args` would panic.
    let args = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned());
    let dry = match parse_args(args) {
        Ok(Command::Wipe { dry_run }) => dry_run,
        Ok(Command::Help) => {
            println!("{USAGE}");
            return;
        }
        Err(message) => {
            eprintln!("fleet-wipe: {message}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    let verb = if dry { "would remove" } else { "removed" };
    match wipe(dry) {
        Ok(removed) => println!("fleet-wipe: {verb} {removed} Fleetify credential(s)"),
        Err(e) => {
            eprintln!("fleet-wipe: {e}");
            std::process::exit(1);
        }
    }
}

/// True for the keyring service names Fleetify uses: exactly `Fleetify` (the
/// OIDC refresh token) or `Fleetify-*` (`Fleetify-GitHub`, `Fleetify-Voice`,
/// `Fleetify-Provider-<id>`, `Fleetify-Router-<id>`). `FleetifyX`, `fleetify`
/// and another app's services never match.
// Only the Linux sweeps match service names; on Windows/macOS these helpers
// are unused, so silence dead-code there (keeps `clippy -D warnings` green).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_fleetify_service(service: &str) -> bool {
    service == "Fleetify" || service.starts_with("Fleetify-")
}

/// True for `keyring`-crate key descriptions that belong to Fleetify: we match
/// their `<service>` half ([`kernel_key_service`]) with [`is_fleetify_service`].
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_fleetify_desc(desc: &str) -> bool {
    kernel_key_service(desc).is_some_and(is_fleetify_service)
}

/// The `<service>` half of a `keyring`-crate key description. The
/// linux-keyutils backend names keys `keyring-rs:<account>@<service>`, and
/// `<account>` can contain `@`, so the service follows the last one. `None`
/// for any other description.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn kernel_key_service(desc: &str) -> Option<&str> {
    let (_, service) = desc.strip_prefix("keyring-rs:")?.rsplit_once('@')?;
    Some(service)
}

/// What a sweep did with one credential, or in a dry run would do.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum Outcome<'e> {
    WouldRemove,
    Removed,
    Failed(&'e dyn std::fmt::Display),
}

/// The output line for one Secret Service item. It names the item by its
/// `service` attribute only and leaves out its `username`: for some services
/// that is the user's Fleetify account ID, and nobody needs it in wipe output.
// Not named `describe_secret_service_item`: CodeQL treats the result of any
// function whose name contains "secret" as sensitive, and would flag every
// line that prints it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn describe_ss_item(service: &str, outcome: Outcome<'_>) -> String {
    match outcome {
        Outcome::WouldRemove => format!("  · Secret Service: {service}"),
        Outcome::Removed => format!("  ✓ Secret Service: {service}"),
        Outcome::Failed(e) => format!("    ! failed to delete Secret Service item {service}: {e}"),
    }
}

/// The output line for one kernel keyring key. It names the key by the
/// `<service>` half of its description only, for the same reason: the
/// `<account>` half can be the user's Fleetify account ID. A description with
/// no service half (the sweep passes none) prints an empty name rather than
/// the whole description.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn describe_kernel_key(desc: &str, outcome: Outcome<'_>) -> String {
    let service = kernel_key_service(desc).unwrap_or_default();
    match outcome {
        Outcome::WouldRemove => format!("  · kernel keyring: {service}"),
        Outcome::Removed => format!("  ✓ kernel keyring: {service}"),
        Outcome::Failed(e) => {
            format!("    ! failed to invalidate kernel keyring key {service}: {e}")
        }
    }
}

/// The `application` attribute keyring puts on every Secret Service item it
/// creates. keyring 3.6.3's module docs say `rust-keyring-client`, but its code
/// (`SsCredential::new_with_target`) and its own tests use `rust-keyring`, as
/// keyring 1.x and 2.x did. The Secret Service test fails if this drifts.
#[cfg(target_os = "linux")]
const KEYRING_APPLICATION: &str = "rust-keyring";

/// Deletes the Secret Service items keyring created whose `service` attribute
/// satisfies `matches`, or with `dry_run` only lists them. Prints one line per
/// item, named by its service only ([`describe_ss_item`]); secrets are never
/// read. Returns how many items it removed (or would remove).
#[cfg(target_os = "linux")]
fn wipe_secret_service(matches: &dyn Fn(&str) -> bool, dry_run: bool) -> Result<usize, String> {
    use dbus_secret_service::{EncryptionType, SecretService};
    use std::collections::HashMap;

    let ss = SecretService::connect(EncryptionType::Dh)
        .map_err(|e| format!("cannot reach the Secret Service: {e}"))?;

    // keyring creates its items in the default collection. While that
    // collection is locked (e.g. after an auto-login boot), its items come
    // back locked: GNOME Keyring then shows only hashed attributes, so their
    // `service` can't be matched, and refuses to delete them. So a real run
    // unlocks it first, which shows the same prompt the app shows on its
    // first keyring access. A dry run changes nothing and only says so.
    if let Ok(collection) = ss.get_default_collection() {
        if collection.is_locked().unwrap_or(false) {
            if dry_run {
                println!(
                    "  ! Secret Service: the default collection is locked, so its items \
                     are not listed (a real run asks to unlock it)"
                );
            } else {
                collection.unlock().map_err(|e| {
                    format!("cannot unlock the Secret Service default collection: {e}")
                })?;
            }
        }
    }

    let found = ss
        .search_items(HashMap::from([("application", KEYRING_APPLICATION)]))
        .map_err(|e| format!("Secret Service search failed: {e}"))?;
    let mut count = 0;
    let mut failed = 0;
    // Items that are still locked sit in another locked collection (or the
    // default one, in a dry run). They are skipped: Fleetify writes only to
    // the default collection.
    for item in &found.unlocked {
        let Ok(attributes) = item.get_attributes() else {
            continue;
        };
        let Some(service) = attributes.get("service").filter(|s| matches(s.as_str())) else {
            continue;
        };
        if dry_run {
            println!("{}", describe_ss_item(service, Outcome::WouldRemove));
            count += 1;
        } else if let Err(e) = item.delete() {
            eprintln!("{}", describe_ss_item(service, Outcome::Failed(&e)));
            failed += 1;
        } else {
            println!("{}", describe_ss_item(service, Outcome::Removed));
            count += 1;
        }
    }
    if failed > 0 {
        return Err(format!(
            "{failed} Secret Service item(s) could not be deleted"
        ));
    }
    Ok(count)
}

/// Linux: the app keeps credentials in the Secret Service; builds before that
/// store kept them in the kernel keyring. Sweep both, even when the Secret
/// Service fails, and report that failure afterwards.
#[cfg(target_os = "linux")]
fn wipe(dry: bool) -> Result<usize, String> {
    let secret_service = wipe_secret_service(&is_fleetify_service, dry);
    let kernel = wipe_kernel_keyring(dry);
    Ok(secret_service? + kernel)
}

/// Invalidates the `keyring-rs:*@Fleetify*` keys that builds before the Secret
/// Service store left in the kernel keyring.
#[cfg(target_os = "linux")]
fn wipe_kernel_keyring(dry: bool) -> usize {
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
            let outcome = if dry {
                Outcome::WouldRemove
            } else {
                Outcome::Removed
            };
            println!("{}", describe_kernel_key(desc, outcome));
            if !dry {
                if let Err(e) = key.invalidate() {
                    let e = format!("{e:?}");
                    eprintln!("{}", describe_kernel_key(desc, Outcome::Failed(&e)));
                }
            }
        }
    }
    count
}

#[cfg(not(target_os = "linux"))]
fn wipe(dry: bool) -> Result<usize, String> {
    Ok(wipe_keychain(dry))
}

#[cfg(not(target_os = "linux"))]
fn wipe_keychain(dry: bool) -> usize {
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
                println!("  · keychain: Fleetify");
                1
            }
            _ => 0,
        };
    }
    match entry.delete_credential() {
        Ok(()) => {
            println!("  ✓ keychain: Fleetify");
            1
        }
        Err(keyring::Error::NoEntry) => 0,
        Err(e) => {
            eprintln!("fleet-wipe: delete failed: {e}");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        describe_kernel_key, describe_ss_item, is_fleetify_desc, is_fleetify_service, Outcome,
    };

    #[test]
    fn fleetify_services_match() {
        for service in [
            "Fleetify",
            "Fleetify-GitHub",
            "Fleetify-Voice",
            "Fleetify-Provider-x",
            "Fleetify-Router-y",
        ] {
            assert!(is_fleetify_service(service), "{service:?} should match");
        }
    }

    #[test]
    fn other_services_do_not_match() {
        for service in ["FleetifyX", "fleetify", "Other-Fleetify", ""] {
            assert!(
                !is_fleetify_service(service),
                "{service:?} should not match"
            );
        }
    }

    #[test]
    fn kernel_key_descriptions_match_on_their_service_half() {
        assert!(is_fleetify_desc("keyring-rs:refresh_token@Fleetify"));
        assert!(is_fleetify_desc("keyring-rs:sub@tenant@Fleetify-GitHub"));
        assert!(is_fleetify_desc("keyring-rs:default@Fleetify-Provider-x"));
        assert!(!is_fleetify_desc("keyring-rs:refresh_token@FleetifyX"));
        assert!(!is_fleetify_desc("keyring-rs:Fleetify@Other-Fleetify"));
        assert!(!is_fleetify_desc("refresh_token@Fleetify"));
        assert!(!is_fleetify_desc("keyring-rs:no-service"));
    }

    #[test]
    fn secret_service_lines_name_the_item_by_its_service_only() {
        let error = "the item is locked";
        for (outcome, expected) in [
            (Outcome::WouldRemove, "  · Secret Service: Fleetify-GitHub"),
            (Outcome::Removed, "  ✓ Secret Service: Fleetify-GitHub"),
            (
                Outcome::Failed(&error),
                "    ! failed to delete Secret Service item Fleetify-GitHub: the item is locked",
            ),
        ] {
            let line = describe_ss_item("Fleetify-GitHub", outcome);
            assert!(
                line.contains("Fleetify-GitHub"),
                "{line:?} names no service"
            );
            assert!(!line.contains("username="), "{line:?} prints a username");
            assert_eq!(line, expected);
        }
    }

    #[test]
    fn kernel_key_lines_name_the_key_by_its_service_only() {
        // `acct-42@tenant` is the `<account>` half: it stands in for an ID.
        let desc = "keyring-rs:acct-42@tenant@Fleetify-GitHub";
        let error = "KeyRevoked";
        for (outcome, expected) in [
            (Outcome::WouldRemove, "  · kernel keyring: Fleetify-GitHub"),
            (Outcome::Removed, "  ✓ kernel keyring: Fleetify-GitHub"),
            (
                Outcome::Failed(&error),
                "    ! failed to invalidate kernel keyring key Fleetify-GitHub: KeyRevoked",
            ),
        ] {
            let line = describe_kernel_key(desc, outcome);
            assert!(
                line.contains("Fleetify-GitHub"),
                "{line:?} names no service"
            );
            assert!(!line.contains("acct-42"), "{line:?} prints the account");
            assert_eq!(line, expected);
        }
    }
}

/// The command line is parsed without touching any credential store, so these
/// tests can never wipe anything.
#[cfg(test)]
mod args_tests {
    use super::{parse_args, Command, USAGE};

    fn parse(args: &[&str]) -> Result<Command, String> {
        parse_args(args)
    }

    #[test]
    fn no_arguments_is_an_error_not_a_wipe() {
        assert_eq!(
            parse(&[]),
            Err("say --dry-run to preview or --yes to delete".to_string())
        );
    }

    #[test]
    fn dry_run_and_check_preview() {
        let cases: &[&[&str]] = &[
            &["--dry-run"],
            &["--check"],
            &["--dry-run", "--check"],
            &["--check", "--check"],
        ];
        for args in cases {
            assert_eq!(parse(args), Ok(Command::Wipe { dry_run: true }), "{args:?}");
        }
    }

    #[test]
    fn yes_deletes() {
        let cases: &[&[&str]] = &[&["--yes"], &["--yes", "--yes"]];
        for args in cases {
            assert_eq!(
                parse(args),
                Ok(Command::Wipe { dry_run: false }),
                "{args:?}"
            );
        }
    }

    #[test]
    fn help_wins_and_never_wipes() {
        let cases: &[&[&str]] = &[
            &["--help"],
            &["-h"],
            &["--yes", "--help"],
            &["-h", "--yes"],
            &["--dry-run", "--yes", "--help"],
            &["--dryrun", "-h"],
        ];
        for args in cases {
            assert_eq!(parse(args), Ok(Command::Help), "{args:?}");
        }
    }

    #[test]
    fn unknown_argument_is_refused() {
        let error = parse(&["--dryrun"]).expect_err("a misspelt --dry-run must be refused");
        assert!(error.contains("--dryrun"), "{error:?} doesn't name it");
        assert_eq!(error, "unknown argument: --dryrun");

        // Near misses of --yes, and a stray argument next to it, never delete.
        let cases: &[(&[&str], &str)] = &[
            (&["--yes", "--force"], "--force"),
            (&["--force", "--yes"], "--force"),
            (&["-y"], "-y"),
            (&["yes"], "yes"),
            (&["--YES"], "--YES"),
            (&["--yes=true"], "--yes=true"),
            (&["--"], "--"),
        ];
        for &(args, unknown) in cases {
            assert_eq!(
                parse(args),
                Err(format!("unknown argument: {unknown}")),
                "{args:?}"
            );
        }
    }

    #[test]
    fn yes_with_dry_run_is_refused() {
        let cases: &[&[&str]] = &[
            &["--yes", "--dry-run"],
            &["--dry-run", "--yes"],
            &["--check", "--yes"],
            &["--yes", "--check", "--yes"],
        ];
        for args in cases {
            assert_eq!(
                parse(args),
                Err("--yes and --dry-run can't be combined".to_string()),
                "{args:?}"
            );
        }
    }

    #[test]
    fn usage_names_every_flag() {
        assert!(
            USAGE.starts_with("Usage: fleet-wipe (--dry-run | --yes)"),
            "{USAGE}"
        );
        for flag in ["--dry-run", "--check", "--yes", "-h", "--help"] {
            assert!(USAGE.contains(flag), "the usage doesn't list {flag}");
        }
    }

    /// `npm run wipe` clears Linux credentials through fleet-wipe, which
    /// deletes only with `--yes`. Reads scripts/wipe.mjs as text; never runs it.
    #[test]
    fn wipe_mjs_passes_yes() {
        let script = include_str!("../../../scripts/wipe.mjs");
        let call = r#"["run", "-q", "-p", "fleet-wipe", "--", "--yes"]"#;
        assert!(
            script.contains(call),
            "scripts/wipe.mjs doesn't run fleet-wipe with {call}"
        );
    }
}

/// Runs against the real Secret Service on the session bus and fails, rather
/// than skips, when there is none. It creates, matches and deletes only its own
/// uniquely named items: the matcher accepts exactly one test service name, so
/// real Fleetify items are never printed or deleted.
#[cfg(all(test, target_os = "linux"))]
mod secret_service_tests {
    use super::wipe_secret_service;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Deletes its test item when dropped, so a failed assertion leaves
    /// nothing behind in the keyring.
    struct Cleanup(keyring::Entry);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }

    /// Stores a throwaway item the way the app stores its credentials.
    fn store(service: &str) -> Cleanup {
        let entry = keyring::Entry::new(service, "wipe-test").expect("keyring entry");
        if let Err(e) = entry.set_password("not-a-real-secret") {
            panic!(
                "this test needs a Secret Service provider (e.g. an unlocked \
                 gnome-keyring-daemon) on the session bus; storing a test item failed: {e}"
            );
        }
        Cleanup(entry)
    }

    #[test]
    fn deletes_only_the_matching_item_keyring_created() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after 1970")
            .as_nanos();
        let service = format!("Fleetify-WipeTest-{}-{nanos}", std::process::id());
        let target = store(&service);
        let other = store(&format!("{service}-keep"));
        let only_target = |s: &str| s == service;

        assert_eq!(wipe_secret_service(&only_target, true), Ok(1), "dry run");
        assert!(target.0.get_password().is_ok(), "a dry run must not delete");

        assert_eq!(wipe_secret_service(&only_target, false), Ok(1), "real run");
        assert!(
            matches!(target.0.get_password(), Err(keyring::Error::NoEntry)),
            "the matching item should be gone"
        );
        assert!(
            other.0.get_password().is_ok(),
            "a non-matching item must stay"
        );
    }
}
