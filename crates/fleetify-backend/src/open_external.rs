//! Opening a link or a path with the system's default handler: the one way
//! the app does it, for the shell and the backend alike.
//!
//! On Windows, `open::that` runs `cmd /c start "" "<arg>"` with the argument
//! inserted raw. A `"` ends the quoting, `&` chains another command, and
//! `%NAME%` expands even inside the quotes. URL parsing lets `"` and `&` into
//! a host: the markdown link `https://x%22&calc.exe&%22y.com/` comes out as
//! `https://x"&calc.exe&"y.com/`. The links the app opens come from markdown
//! it didn't write, provider CLI output and repository remotes.
//!
//! - [`validate_external_url`] accepts only http and https links with a
//!   host, and mailto links that fill in only the recipients, subject and
//!   body, and only when the serialized URL holds no `"`, whitespace or
//!   control character. It drops a link's username and password, and
//!   percent-encodes `$` and backticks for PowerShell under WSL (refusing
//!   them in a host).
//! - [`open_url`] validates, then opens the serialized URL, never the raw
//!   input.
//! - [`open_path`] opens a file or folder the app chose itself; it must be
//!   an absolute path, without `$` or backticks under WSL. A path the UI asks
//!   for must also pass [`is_document_or_folder`].
//!
//! On Windows they launch through `ShellExecuteExW` (`open::that_detached`
//! with the crate's `shellexecute-on-windows` feature): no command shell,
//! no `%` expansion. Elsewhere they use `open::that`, as before: it reports
//! a launcher's failed exit status, which callers rely on to fall back.
//!
//! The workspace's `clippy.toml` forbids every `open` launcher outside this
//! module.

use std::ffi::OsStr;
use std::fmt;
use std::io;
use std::path::Path;

use url::Url;

/// Why a link can't be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlRejected {
    /// It doesn't parse as an absolute URL (the parser's error).
    Unparsable(String),
    /// Its scheme is not http, https or mailto.
    Scheme(String),
    /// An http or https link without a host.
    NoHost,
    /// The serialized URL holds a `"`, whitespace or a control character,
    /// which a command line could act on.
    UnsafeCharacter(char),
    /// A mailto link with a field other than [`MAIL_FIELDS`]: some mail
    /// clients attach the local file an `attach` field names.
    MailField(String),
}

impl fmt::Display for UrlRejected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unparsable(error) => write!(f, "it isn't a URL ({error})"),
            Self::Scheme(scheme) => write!(
                f,
                "only http, https and mailto links are opened, not {scheme}:"
            ),
            Self::NoHost => write!(f, "it has no host"),
            Self::UnsafeCharacter(c) => write!(f, "it holds a character that isn't allowed: {c:?}"),
            Self::MailField(field) => {
                write!(f, "a mail link can't set the {field:?} field")
            }
        }
    }
}

impl std::error::Error for UrlRejected {}

/// Why opening a link failed.
#[derive(Debug)]
pub enum OpenError {
    /// The link was refused, so nothing was launched.
    Rejected(UrlRejected),
    /// The system couldn't open it.
    Launch(io::Error),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(rejected) => write!(f, "this link can't be opened: {rejected}"),
            Self::Launch(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for OpenError {}

/// The fields a mailto link may fill in, compared case-insensitively: the
/// recipients, the subject and the body.
pub const MAIL_FIELDS: [&str; 5] = ["to", "cc", "bcc", "subject", "body"];

/// `raw` as a URL the system may open: an http or https link with a host,
/// or a mailto link that fills in only [`MAIL_FIELDS`].
///
/// - An http or https link loses its username and password: the browser
///   never sees credentials a remote or a link carried.
/// - The serialized URL must hold no `"`, whitespace or control character.
///   The parser drops tabs and newlines and percent-encodes a `"` or space
///   in a path, query or fragment; what it keeps (a `"` in a host, a space
///   in a mailto address) is refused.
/// - Under WSL, `open::that` hands the URL to `wslview`, which runs it
///   through PowerShell, where `$(…)` runs and `$env:X` expands: a `$` or
///   backtick in the host is refused, and anywhere else it is
///   percent-encoded (`%24`, `%60`). The URL returned is that encoded form.
pub fn validate_external_url(raw: &str) -> Result<Url, UrlRejected> {
    let mut url = Url::parse(raw).map_err(|error| UrlRejected::Unparsable(error.to_string()))?;
    match url.scheme() {
        "http" | "https" => {
            if url.host_str().is_none_or(str::is_empty) {
                return Err(UrlRejected::NoHost);
            }
            // Can't fail: an http(s) URL with a host can have credentials.
            let _ = url.set_username("");
            let _ = url.set_password(None);
        }
        "mailto" => {
            if let Some((field, _)) = url
                .query_pairs()
                .find(|(field, _)| !MAIL_FIELDS.iter().any(|f| f.eq_ignore_ascii_case(field)))
            {
                return Err(UrlRejected::MailField(field.into_owned()));
            }
        }
        other => return Err(UrlRejected::Scheme(other.to_string())),
    }
    if let Some(c) = url
        .host_str()
        .and_then(|host| host.chars().find(|c| matches!(c, '$' | '`')))
    {
        return Err(UrlRejected::UnsafeCharacter(c));
    }
    if let Some(c) = url
        .as_str()
        .chars()
        .find(|c| *c == '"' || c.is_whitespace() || c.is_control())
    {
        return Err(UrlRejected::UnsafeCharacter(c));
    }
    if url.as_str().contains(['$', '`']) {
        let encoded = url.as_str().replace('$', "%24").replace('`', "%60");
        url = Url::parse(&encoded).map_err(|error| UrlRejected::Unparsable(error.to_string()))?;
    }
    Ok(url)
}

/// Opens `raw` with the system's default handler, when
/// [`validate_external_url`] accepts it. What is opened is the serialized
/// URL, never `raw` itself.
pub fn open_url(raw: &str) -> Result<(), OpenError> {
    let url = validate_external_url(raw).map_err(OpenError::Rejected)?;
    launch(url.as_str()).map_err(OpenError::Launch)
}

/// Opens a file or folder the app chose itself (the logs folder, its own
/// config file) with the system's default handler. `path` must be absolute:
/// a relative one would be resolved against the working directory.
pub fn open_path(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not an absolute path", path.display()),
        ));
    }
    if refused_under_wsl(path, running_under_wsl()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} can't be opened under WSL: it holds a $ or a backtick",
                path.display()
            ),
        ));
    }
    launch(path.as_os_str())
}

/// Extensions of the files the UI may open (`shell_open_path`), compared
/// case-insensitively: the documents and config files the Library lists
/// (`.md` and Cursor's `.mdc` rules, `.toml`, `.json`, `.yaml`, OpenCode's
/// `.ts` plugin hooks) and a few plain-text kinds. Nothing Windows runs:
/// ShellExecute starts executables, scripts and shortcuts.
pub const DOCUMENT_EXTENSIONS: [&str; 11] = [
    "md", "markdown", "mdc", "txt", "json", "jsonc", "yaml", "yml", "toml", "log", "ts",
];

/// Whether the UI may open `path` ([`open_path`] through `shell_open_path`):
/// an absolute path to an existing folder, or to a regular file with one of
/// the [`DOCUMENT_EXTENSIONS`].
pub fn is_document_or_folder(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if metadata.is_dir() {
        return true;
    }
    metadata.is_file()
        && path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| {
                DOCUMENT_EXTENSIONS
                    .iter()
                    .any(|document| document.eq_ignore_ascii_case(extension))
            })
}

/// Whether [`open_path`] refuses `path` because the app runs under WSL
/// (`is_wsl`): `open::that` hands it to `wslview` there, which runs it
/// through PowerShell, where `$(…)` runs and `$env:X` expands. A path with
/// a `$` or backtick is refused.
pub fn refused_under_wsl(path: &Path, is_wsl: bool) -> bool {
    is_wsl && path.to_string_lossy().contains(['$', '`'])
}

/// Whether the app runs under WSL, decided the way `open::that` decides to
/// try `wslview` (`is_wsl::is_wsl`, in open 5.3.5's `unix.rs`).
fn running_under_wsl() -> bool {
    #[cfg(target_os = "linux")]
    {
        is_wsl::is_wsl()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// The one call into the system opener. On Windows, `ShellExecuteExW`
/// (`that_detached` with `shellexecute-on-windows`), never `cmd`. Elsewhere
/// `open::that`, which reports a launcher's failed exit status.
#[allow(clippy::disallowed_methods)]
fn launch(target: impl AsRef<OsStr>) -> io::Result<()> {
    #[cfg(windows)]
    {
        open::that_detached(target)
    }
    #[cfg(not(windows))]
    {
        open::that(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The links an app link opener must open: web pages and mail.
    const ACCEPTED: [&str; 3] = [
        "https://example.com/a?b=c#d",
        "http://localhost:5173/",
        "mailto:hello@example.com",
    ];

    #[test]
    fn web_and_mail_links_are_accepted_and_opened_as_serialized() {
        for raw in ACCEPTED {
            let url = validate_external_url(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
            assert_eq!(url.as_str(), raw);
        }
    }

    #[test]
    fn other_schemes_and_non_urls_are_rejected() {
        for raw in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,x",
            "vbscript:x",
            "ms-msdt:/id x",
            "search-ms:query=x",
            r"\\server\share\x.exe",
            r"C:\Windows\System32\calc.exe",
            "calc",
            "",
        ] {
            assert!(
                validate_external_url(raw).is_err(),
                "{raw:?} was accepted as {:?}",
                validate_external_url(raw).map(|url| url.to_string())
            );
        }
    }

    #[test]
    fn a_quote_that_reaches_the_serialized_url_is_rejected() {
        // The N1 payload: host parsing keeps `"` and `&`, so on Windows
        // `cmd /c start "" "<url>"` would end the quoting and run calc.
        let payload = "https://x%22&calc.exe&%22y.com/";
        assert_eq!(
            validate_external_url(payload),
            Err(UrlRejected::UnsafeCharacter('"')),
            "{payload}"
        );
        for raw in ["https://x\"y.com/", "mailto:\"evil\"@example.com"] {
            assert_eq!(
                validate_external_url(raw),
                Err(UrlRejected::UnsafeCharacter('"')),
                "{raw}"
            );
        }
    }

    #[test]
    fn a_quote_the_parser_percent_encodes_is_harmless() {
        // In the path, query and fragment the parser writes `%22`: the
        // string handed to the opener holds no quote at all.
        let url = validate_external_url("https://example.com/a\"b?c=\"d\"#\"e").unwrap();
        assert!(!url.as_str().contains('"'), "{url}");
    }

    #[test]
    fn whitespace_and_control_characters_never_reach_the_opener() {
        // The parser drops tabs and newlines, and percent-encodes spaces in
        // paths; whatever comes back must hold none of them.
        for raw in [
            "https://example.com/a\nb",
            "https://example.com/a\tb",
            "https://example.com/a\r\nb",
            "https://example.com/a b",
            " https://example.com/ ",
            "mailto:a b@example.com",
            "mailto:a\u{7f}b@example.com",
        ] {
            if let Ok(url) = validate_external_url(raw) {
                assert!(
                    !url.as_str()
                        .chars()
                        .any(|c| c == '"' || c.is_whitespace() || c.is_control()),
                    "{raw:?} came back as {:?}",
                    url.as_str()
                );
            }
        }
    }

    #[test]
    fn a_rejected_link_is_never_launched() {
        // open_url validates first: these come back Rejected, so no browser
        // starts while the tests run.
        for raw in ["javascript:alert(1)", "https://x%22&calc.exe&%22y.com/", ""] {
            assert!(
                matches!(open_url(raw), Err(OpenError::Rejected(_))),
                "{raw:?}"
            );
        }
    }

    /// A file named `name` in `dir`, created empty.
    fn file_in(dir: &Path, name: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"").unwrap();
        path
    }

    #[test]
    fn a_folder_or_a_document_the_library_lists_may_be_opened_from_the_ui() {
        let dir = tempfile::tempdir().unwrap();
        assert!(is_document_or_folder(dir.path()), "a folder");
        for name in [
            "SKILL.md",
            "NOTES.MD",
            "rule.mdc",
            "notes.markdown",
            "readme.txt",
            "settings.json",
            "tsconfig.jsonc",
            "HOOK.yaml",
            "ci.yml",
            "reviewer.toml",
            "fleet.log",
            "plugin.ts",
        ] {
            let path = file_in(dir.path(), name);
            assert!(is_document_or_folder(&path), "{name}");
        }
    }

    #[test]
    fn a_program_script_shortcut_or_extensionless_file_is_not_opened_from_the_ui() {
        // On Windows ShellExecute runs these: executables, scripts, shortcuts.
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "setup.exe",
            "SETUP.EXE",
            "run.bat",
            "run.cmd",
            "run.ps1",
            "app.lnk",
            "run.sh",
            "handler.py",
            "script.js",
            "Makefile",
        ] {
            let path = file_in(dir.path(), name);
            assert!(!is_document_or_folder(&path), "{name}");
        }
    }

    #[test]
    fn a_relative_or_missing_path_is_not_opened_from_the_ui() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_document_or_folder(Path::new("notes.md")));
        assert!(!is_document_or_folder(Path::new("./docs")));
        assert!(!is_document_or_folder(&dir.path().join("missing.md")));
        assert!(!is_document_or_folder(&dir.path().join("missing-folder")));
    }

    #[test]
    fn a_dollar_or_backtick_is_percent_encoded_for_powershell_under_wsl() {
        // Under WSL, open::that tries wslview, which hands the URL to
        // PowerShell: `$(…)` runs there and `$env:X` expands.
        let url = validate_external_url("https://x.com/$(calc)").unwrap();
        assert_eq!(url.as_str(), "https://x.com/%24(calc)");
        let url = validate_external_url("https://example.com/?q=a`b#c$d").unwrap();
        assert_eq!(url.as_str(), "https://example.com/?q=a%60b#c%24d");
        let url = validate_external_url("mailto:x@example.com?subject=$env:USERNAME").unwrap();
        assert_eq!(url.as_str(), "mailto:x@example.com?subject=%24env:USERNAME");
        // The encoded form re-parses to itself, and validates to itself.
        for raw in [
            "https://x.com/$(calc)",
            "https://example.com/?q=a`b#c$d",
            "mailto:x@example.com?subject=$env:USERNAME",
        ] {
            let opened = validate_external_url(raw).unwrap();
            assert_eq!(
                Url::parse(opened.as_str()).unwrap().as_str(),
                opened.as_str()
            );
            assert_eq!(validate_external_url(opened.as_str()), Ok(opened.clone()));
        }
    }

    #[test]
    fn a_dollar_or_backtick_in_a_host_is_refused() {
        for raw in [
            "https://x$y.com/",
            "https://x`y.com/",
            "http://$(calc).example/",
        ] {
            assert!(
                matches!(
                    validate_external_url(raw),
                    Err(UrlRejected::UnsafeCharacter(_))
                ),
                "{raw:?} gave {:?}",
                validate_external_url(raw)
            );
        }
    }

    #[test]
    fn under_wsl_a_path_with_a_dollar_or_backtick_is_refused() {
        for path in ["/home/u/$(calc).md", "/home/u/a`b.md", "/home/u/$HOME/x.md"] {
            assert!(refused_under_wsl(Path::new(path), true), "{path}");
            assert!(!refused_under_wsl(Path::new(path), false), "{path}");
        }
        assert!(!refused_under_wsl(Path::new("/home/u/notes.md"), true));
    }

    #[test]
    fn a_mail_link_may_only_fill_in_the_message() {
        // Some mail clients attach the local file an `attach` field names.
        for raw in [
            "mailto:x@example.com?attach=/home/u/.ssh/id_rsa",
            "mailto:x@example.com?Attachment=/etc/passwd",
            "mailto:x@example.com?subject=Hi&attach=x",
            "mailto:x@example.com?=x",
        ] {
            assert!(
                matches!(validate_external_url(raw), Err(UrlRejected::MailField(_))),
                "{raw:?} gave {:?}",
                validate_external_url(raw)
            );
        }
        for raw in [
            "mailto:x@example.com?subject=Hi&body=x",
            "mailto:x@example.com?To=y@example.com&CC=z@example.com&bcc=w@example.com",
            "mailto:x@example.com",
        ] {
            assert!(validate_external_url(raw).is_ok(), "{raw:?}");
        }
    }

    #[test]
    fn credentials_never_reach_the_browser() {
        for (raw, opened) in [
            ("https://user:tok@example.com/x", "https://example.com/x"),
            ("http://token@example.com/", "http://example.com/"),
            ("https://:secret@example.com/a?b", "https://example.com/a?b"),
        ] {
            assert_eq!(
                validate_external_url(raw).unwrap().as_str(),
                opened,
                "{raw}"
            );
        }
    }

    #[test]
    fn a_relative_path_is_refused() {
        for path in ["logs", "./mcp.json", "../x"] {
            let error = open_path(Path::new(path)).expect_err(path);
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{path}");
        }
    }

    #[test]
    fn the_windows_launcher_is_shell_execute() {
        // open's `shellexecute-on-windows` feature makes `that_detached` call
        // ShellExecuteExW instead of `cmd /c start`.
        let manifest: toml::Value = toml::from_str(include_str!("../Cargo.toml")).unwrap();
        let open = &manifest["dependencies"]["open"];
        let features = open
            .get("features")
            .and_then(toml::Value::as_array)
            .unwrap_or_else(|| panic!("open has no features: {open}"));
        assert!(
            features
                .iter()
                .any(|feature| feature.as_str() == Some("shellexecute-on-windows")),
            "{open}"
        );
    }
}
