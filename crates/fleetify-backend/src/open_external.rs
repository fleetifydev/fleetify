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
//!   body (no `;` in the fields), and only when the serialized URL holds no
//!   `"`, whitespace or control character. It drops a link's username and
//!   password, and percent-encodes `$` and backticks for PowerShell under
//!   WSL (refusing them in a host).
//! - [`open_url`] validates, then opens the serialized URL, never the raw
//!   input.
//! - [`open_path`] opens a file or folder the app chose itself,
//!   [`open_ui_path`] a folder or document the UI asks for, and
//!   [`path_to_reveal`] resolves an item to show in the file manager. All
//!   three refuse a Windows network or device path before anything touches
//!   it, resolve the path, and check what it resolved to (an absolute path;
//!   from the UI, a folder or a document; for what is launched, no package
//!   on macOS and no character PowerShell acts on under WSL). The first two
//!   open that resolved path; Reveal shows the item itself in its resolved
//!   folder, so a symlink is selected rather than its target.
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
use std::path::{Component, Path, PathBuf};

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
    /// A mailto link whose fields hold a `;`: some mail clients split fields
    /// on it as well as on `&`, so a field hidden in a value would get past
    /// [`MAIL_FIELDS`].
    MailSemicolon,
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
            Self::MailSemicolon => write!(f, "a mail link's fields can't hold a ;"),
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
/// or a mailto link that fills in only [`MAIL_FIELDS`], with no `;` in its
/// fields (some mail clients split on it too).
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
            // Fields split on `&` (RFC 6068); a client that also splits on
            // `;` would find a field hidden in a value.
            if url.query().is_some_and(|query| query.contains(';')) {
                return Err(UrlRejected::MailSemicolon);
            }
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

/// Why a path isn't opened or revealed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathRefused {
    /// A Windows network (`\\server\share`, `\\?\UNC\…`) or device (`\\.\…`)
    /// path: looking at one signs in to the host.
    NetworkOrDevice,
    /// Not an absolute path.
    Relative,
    /// It can't be resolved: it doesn't exist, or can't be read (why).
    Unresolvable(String),
    /// Opened from the UI, it is neither a folder nor a file with one of the
    /// [`DOCUMENT_EXTENSIONS`].
    NotDocumentOrFolder,
    /// Under WSL, a character PowerShell acts on.
    UnsafeCharacter(char),
    /// On macOS, an app bundle or another package, which `open` launches.
    Package,
}

impl fmt::Display for PathRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NetworkOrDevice => write!(f, "it is a network or device path"),
            Self::Relative => write!(f, "it isn't an absolute path"),
            Self::Unresolvable(error) => write!(f, "it can't be resolved ({error})"),
            Self::NotDocumentOrFolder => write!(f, "it is neither a folder nor a document"),
            Self::UnsafeCharacter(c) => {
                write!(f, "it holds a character that isn't allowed here: {c:?}")
            }
            Self::Package => write!(f, "it is an application or another package"),
        }
    }
}

impl std::error::Error for PathRefused {}

impl From<PathRefused> for io::Error {
    fn from(refused: PathRefused) -> Self {
        let kind = match refused {
            PathRefused::Unresolvable(_) => io::ErrorKind::NotFound,
            _ => io::ErrorKind::InvalidInput,
        };
        io::Error::new(kind, format!("this path can't be opened: {refused}"))
    }
}

/// Why opening a path from the UI failed.
#[derive(Debug)]
pub enum OpenPathError {
    /// The path was refused, so nothing was launched.
    Refused(PathRefused),
    /// The system couldn't open it.
    Launch(io::Error),
}

impl fmt::Display for OpenPathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(refused) => write!(f, "this path can't be opened: {refused}"),
            Self::Launch(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for OpenPathError {}

/// Opens a file or folder the app chose itself (the logs folder, its own
/// config file) with the system's default handler. `path` must be absolute:
/// a relative one would be resolved against the working directory.
pub fn open_path(path: &Path) -> io::Result<()> {
    let target = checked_path(path, Check::AppChosen, PathRules::current(), &SystemFs)?;
    launch(target.as_os_str())
}

/// Opens a folder, or a file with one of the [`DOCUMENT_EXTENSIONS`], that
/// the UI asks for (`shell_open_path`), with the system's default handler.
pub fn open_ui_path(path: &Path) -> Result<(), OpenPathError> {
    let target = checked_path(path, Check::FromUi, PathRules::current(), &SystemFs)
        .map_err(OpenPathError::Refused)?;
    launch(target.as_os_str()).map_err(OpenPathError::Launch)
}

/// The path of an existing item to show, selected, in the file manager
/// (`shell_show_item_in_folder`). Nothing is launched: a fallback that opens
/// its folder goes through [`open_path`]. The whole path is resolved and
/// checked, but what comes back is the item itself in its resolved folder:
/// a symlink is selected, not its target. An unusual name (on Windows, one
/// that reads as a drive path) falls back to the resolved path.
pub fn path_to_reveal(path: &Path) -> Result<PathBuf, PathRefused> {
    checked_path(path, Check::Reveal, PathRules::current(), &SystemFs)
}

/// Extensions of the files the UI may open (`shell_open_path`), compared
/// case-insensitively: the documents and config files the Library lists
/// (`.md` and Cursor's `.mdc` rules, `.toml`, `.json`, `.yaml`, OpenCode's
/// `.ts` plugin hooks) and a few plain-text kinds. Nothing Windows runs:
/// ShellExecute starts executables, scripts and shortcuts.
pub const DOCUMENT_EXTENSIONS: [&str; 11] = [
    "md", "markdown", "mdc", "txt", "json", "jsonc", "yaml", "yml", "toml", "log", "ts",
];

/// Extensions of the macOS packages `/usr/bin/open` launches instead of
/// showing (application bundles, plug-ins, installers), compared
/// case-insensitively.
pub const MACOS_PACKAGE_EXTENSIONS: [&str; 16] = [
    "app",
    "appex",
    "bundle",
    "framework",
    "plugin",
    "prefpane",
    "kext",
    "pkg",
    "mpkg",
    "xpc",
    "qlgenerator",
    "mdimporter",
    "saver",
    "service",
    "action",
    "workflow",
];

/// Whether `path`, read as a Windows path, is a network path
/// (`\\server\share…`, `//server/share…`, `\\?\UNC\…`) or a device path
/// (`\\.\…`, any other `\\?\` path, an NT `\??\` path). That is any path
/// starting with two separators, except a verbatim local disk path
/// (`\\?\C:\…`). On Windows, looking at such a path, even to check that it
/// exists, can sign in to its host over SMB and hand it the user's NTLM
/// hash; Explorer and ShellExecute connect the same way. A string helper, so
/// it is tested on every platform; the checks apply it on Windows.
pub fn is_windows_network_or_device_path(path: &str) -> bool {
    let separator = |b: &u8| matches!(b, b'\\' | b'/');
    match path.as_bytes() {
        [first, b'?', b'?', fourth, ..] if separator(first) && separator(fourth) => true,
        [first, second, ..] if separator(first) && separator(second) => {
            !is_verbatim_disk_path(path)
        }
        _ => false,
    }
}

/// Whether `path` is a verbatim local disk path: `\\?\`, a drive letter and
/// `:`, then nothing or `\`.
fn is_verbatim_disk_path(path: &str) -> bool {
    path.strip_prefix(r"\\?\")
        .is_some_and(|rest| match rest.as_bytes() {
            [drive, b':'] => drive.is_ascii_alphabetic(),
            [drive, b':', b'\\', ..] => drive.is_ascii_alphabetic(),
            _ => false,
        })
}

/// Whether `path`'s last component names a package: lowercased, it ends in
/// `.` and one of the [`MACOS_PACKAGE_EXTENSIONS`], so a folder named just
/// `.app` counts too (`Path::extension` sees no extension in a dot name).
/// On macOS, `open` would launch it.
pub fn is_macos_package(path: &Path) -> bool {
    let Some(name) = path.file_name() else {
        return false;
    };
    let name = name.to_string_lossy().to_lowercase();
    MACOS_PACKAGE_EXTENSIONS.iter().any(|extension| {
        name.strip_suffix(extension)
            .is_some_and(|stem| stem.ends_with('.'))
    })
}

/// Whether a path is refused because the app runs under WSL (`is_wsl`):
/// `open::that` hands it to `wslview` there, which resolves it and pastes it
/// into PowerShell's `Start "<path>"`. A path holding a character that would
/// end that string or act inside it ([`powershell_character`]) is refused.
/// The checks apply it to the resolved path, which is what wslview pastes.
pub fn refused_under_wsl(path: &Path, is_wsl: bool) -> bool {
    is_wsl && powershell_character(path).is_some()
}

/// The first character of `path` that PowerShell acts on inside a
/// double-quoted string: a double quote, or a typographic quote it reads as
/// one (U+201C, U+201D, U+201E), a backtick, a `$` (`$(…)` runs, `$env:X`
/// expands), or a control character.
fn powershell_character(path: &Path) -> Option<char> {
    path.to_string_lossy().chars().find(|c| {
        matches!(c, '"' | '\u{201C}' | '\u{201D}' | '\u{201E}' | '`' | '$') || c.is_control()
    })
}

/// Whether `path` names a file with one of the [`DOCUMENT_EXTENSIONS`].
fn has_document_extension(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            DOCUMENT_EXTENSIONS
                .iter()
                .any(|document| document.eq_ignore_ascii_case(extension))
        })
}

/// What a path is checked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Check {
    /// A file or folder the app chose itself ([`open_path`]).
    AppChosen,
    /// A folder or document the UI asks for ([`open_ui_path`]).
    FromUi,
    /// An item to show in the file manager ([`path_to_reveal`]).
    Reveal,
}

/// The platform rules a path is checked against.
#[derive(Debug, Clone, Copy, Default)]
struct PathRules {
    /// Windows: network and device paths are refused.
    windows: bool,
    /// macOS: packages are refused.
    macos: bool,
    /// WSL: characters PowerShell acts on are refused.
    wsl: bool,
}

impl PathRules {
    /// The rules of the platform the app runs on.
    fn current() -> Self {
        Self {
            windows: cfg!(windows),
            macos: cfg!(target_os = "macos"),
            wsl: running_under_wsl(),
        }
    }
}

/// What a resolved path is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Folder,
    File,
    Other,
}

/// The filesystem as the checks use it, so tests can see which calls run.
trait PathFs {
    /// `path` with its symlinks and `..` resolved: on Windows without the
    /// `\\?\` prefix, which the shell doesn't take.
    fn resolve(&self, path: &Path) -> io::Result<PathBuf>;
    /// What the resolved `path` is.
    fn kind(&self, path: &Path) -> io::Result<Kind>;
}

/// The real filesystem.
struct SystemFs;

impl PathFs for SystemFs {
    fn resolve(&self, path: &Path) -> io::Result<PathBuf> {
        fleetify_core::canonicalize_no_verbatim(path)
    }

    fn kind(&self, path: &Path) -> io::Result<Kind> {
        let metadata = std::fs::metadata(path)?;
        Ok(if metadata.is_dir() {
            Kind::Folder
        } else if metadata.is_file() {
            Kind::File
        } else {
            Kind::Other
        })
    }
}

/// The path to open (or reveal) for `path`, or why it isn't opened:
///
/// 1. On Windows, a network or device path is refused as given, before
///    anything touches the filesystem: resolving it would already sign in to
///    its host. It must also be absolute.
/// 2. It is resolved: symlinks and `..` (`fs.resolve`).
/// 3. What it resolved to is checked, so a symlink is judged by where it
///    leads: for a path from the UI, a folder or a document extension; for
///    anything launched, the macOS package and WSL rules. (The resolved path
///    isn't checked for a network path: a mapped network drive resolves to
///    its share, and resolving has already made any connection.)
/// 4. The resolved path is returned: it is what gets opened, never `path`.
///    An item to reveal is returned as itself, in its resolved folder
///    (`fs.resolve(parent)` joined with its name), so the file manager
///    selects what was clicked: a symlink, not where it leads. A root, a
///    path ending in `..`, or a name that isn't one plain component on its
///    own ([`is_plain_name`]) is revealed as resolved: the path checked.
fn checked_path(
    path: &Path,
    check: Check,
    rules: PathRules,
    fs: &impl PathFs,
) -> Result<PathBuf, PathRefused> {
    if rules.windows && is_windows_network_or_device_path(&path.to_string_lossy()) {
        return Err(PathRefused::NetworkOrDevice);
    }
    if !path.is_absolute() {
        return Err(PathRefused::Relative);
    }
    let unresolvable = |error: io::Error| PathRefused::Unresolvable(error.to_string());
    let resolved = fs.resolve(path).map_err(unresolvable)?;
    if check == Check::FromUi {
        match fs.kind(&resolved) {
            Ok(Kind::Folder) => {}
            Ok(Kind::File) if has_document_extension(&resolved) => {}
            _ => return Err(PathRefused::NotDocumentOrFolder),
        }
    }
    // Revealing selects the item in the file manager and launches nothing;
    // a fallback that opens its folder goes through `open_path`.
    if check == Check::Reveal {
        return match (path.parent(), path.file_name()) {
            (Some(parent), Some(name)) if is_plain_name(name) => fs
                .resolve(parent)
                .map(|folder| folder.join(name))
                .map_err(unresolvable),
            _ => Ok(resolved),
        };
    }
    if rules.macos && is_macos_package(&resolved) {
        return Err(PathRefused::Package);
    }
    if rules.wsl {
        if let Some(c) = powershell_character(&resolved) {
            return Err(PathRefused::UnsafeCharacter(c));
        }
    }
    Ok(resolved)
}

/// Whether `name`, on its own, is one plain path component, which `join`
/// appends to a folder. On Windows a name that starts with a drive letter
/// and `:` (`Z::$DATA` names the default stream of a file `Z`) reads as a
/// path on that drive, and `join` would put it in the folder's place.
fn is_plain_name(name: &OsStr) -> bool {
    let mut components = Path::new(name).components();
    matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    )
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

    /// What `shell_open_path` would open for `path`, checked on the real
    /// filesystem without any platform's rules. Nothing is launched.
    fn from_ui(path: &Path) -> Result<PathBuf, PathRefused> {
        checked_path(path, Check::FromUi, PathRules::default(), &SystemFs)
    }

    #[test]
    fn a_folder_or_a_document_the_library_lists_may_be_opened_from_the_ui() {
        let dir = tempfile::tempdir().unwrap();
        assert!(from_ui(dir.path()).is_ok(), "a folder");
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
            assert!(from_ui(&path).is_ok(), "{name}: {:?}", from_ui(&path));
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
            assert_eq!(
                from_ui(&path),
                Err(PathRefused::NotDocumentOrFolder),
                "{name}"
            );
        }
    }

    #[test]
    fn a_relative_or_missing_path_is_not_opened_from_the_ui() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(from_ui(Path::new("notes.md")), Err(PathRefused::Relative));
        assert_eq!(from_ui(Path::new("./docs")), Err(PathRefused::Relative));
        for missing in ["missing.md", "missing-folder"] {
            assert!(
                matches!(
                    from_ui(&dir.path().join(missing)),
                    Err(PathRefused::Unresolvable(_))
                ),
                "{missing}"
            );
        }
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
    fn under_wsl_a_path_that_could_end_powershells_string_is_refused() {
        // wslview pastes the resolved path into `Start "<path>"`: a double
        // quote, or one of the typographic quotes PowerShell reads as one,
        // ends the string; a control character has no business in a path.
        for path in [
            "/home/u/x\";calc;\"/notes.md",
            "/home/u/x\u{201C};calc;\u{201C}",
            "/home/u/x\u{201D}y",
            "/home/u/x\u{201E}y",
            "/home/u/a\nb",
            "/home/u/a\u{7}b",
        ] {
            assert!(refused_under_wsl(Path::new(path), true), "{path:?}");
            assert!(!refused_under_wsl(Path::new(path), false), "{path:?}");
        }
        // Single typographic quotes and other punctuation are fine.
        for path in ["/home/u/it\u{2019}s.md", "/home/u/a&b (c)#d!.md"] {
            assert!(!refused_under_wsl(Path::new(path), true), "{path:?}");
        }
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

    #[test]
    fn a_mail_link_with_a_semicolon_in_its_fields_is_refused() {
        // Some mail clients split fields on `;` as well as `&`.
        for raw in [
            "mailto:a@example.com?subject=x;attach=/etc/passwd",
            "mailto:a@example.com?subject=Hi&body=a;attach=/etc/passwd",
            "mailto:a@example.com?;attach=/etc/passwd",
        ] {
            assert_eq!(
                validate_external_url(raw),
                Err(UrlRejected::MailSemicolon),
                "{raw}"
            );
        }
        // An encoded semicolon is text in a value, whoever splits.
        assert!(validate_external_url("mailto:a@example.com?subject=a%3Bb").is_ok());
    }

    // ── Paths: resolve, check what they resolve to, launch that ──

    /// Windows network and device paths, in the forms the launchers refuse.
    const NETWORK_OR_DEVICE: [&str; 13] = [
        r"\\server\share\notes.md",
        r"\\server\share",
        "//server/share/notes.md",
        r"\/server/share\notes.md",
        r"/\server\share\notes.md",
        r"\\localhost\C$\Users\u\notes.md",
        r"\\?\UNC\server\share\notes.md",
        r"\\?\unc\server\share\notes.md",
        r"\\.\pipe\x",
        r"\\.\C:\Users\u\notes.md",
        r"\\?\GLOBALROOT\Device\Mup\server\share\notes.md",
        r"\\?\Volume{0a1b2c3d-0000-0000-0000-000000000000}\notes.md",
        r"\??\UNC\server\share\notes.md",
    ];

    #[test]
    fn windows_network_and_device_paths_are_told_from_local_ones() {
        for path in NETWORK_OR_DEVICE {
            assert!(is_windows_network_or_device_path(path), "{path}");
        }
        for path in [
            r"C:\Users\u\notes.md",
            "C:/Users/u/notes.md",
            r"c:\notes.md",
            r"\\?\C:\Users\u\notes.md",
            r"\\?\d:\notes.md",
            r"\\?\C:",
            "C:notes.md",
            r"notes\x.md",
            r"\Users\u\notes.md",
            "/home/u/notes.md",
        ] {
            assert!(!is_windows_network_or_device_path(path), "{path}");
        }
    }

    /// An absolute path on the platform the tests run on.
    fn abs(path: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"C:\{}", path.replace('/', r"\")))
        } else {
            PathBuf::from(format!("/{path}"))
        }
    }

    /// A filesystem where each `(path, resolved, kind)` entry resolves `path`
    /// to `resolved`, which is a `kind`. Nothing else exists.
    struct FakeFs(Vec<(PathBuf, PathBuf, Kind)>);

    impl PathFs for FakeFs {
        fn resolve(&self, path: &Path) -> io::Result<PathBuf> {
            self.0
                .iter()
                .find(|(given, ..)| given == path)
                .map(|(_, resolved, _)| resolved.clone())
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no such file"))
        }

        fn kind(&self, path: &Path) -> io::Result<Kind> {
            self.0
                .iter()
                .find(|(_, resolved, _)| resolved == path)
                .map(|(.., kind)| *kind)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no such file"))
        }
    }

    /// A filesystem the checks must not touch.
    struct Untouchable;

    impl PathFs for Untouchable {
        fn resolve(&self, path: &Path) -> io::Result<PathBuf> {
            panic!("{path:?} was resolved before it was refused")
        }

        fn kind(&self, path: &Path) -> io::Result<Kind> {
            panic!("{path:?} was looked at before it was refused")
        }
    }

    const CHECKS: [Check; 3] = [Check::AppChosen, Check::FromUi, Check::Reveal];

    fn windows() -> PathRules {
        PathRules {
            windows: true,
            ..PathRules::default()
        }
    }

    #[test]
    fn on_windows_a_network_path_is_refused_before_anything_looks_at_it() {
        // Resolving it, or even checking that it exists, signs in to the host
        // over SMB, which hands it the user's NTLM hash.
        for check in CHECKS {
            for path in NETWORK_OR_DEVICE {
                assert_eq!(
                    checked_path(Path::new(path), check, windows(), &Untouchable),
                    Err(PathRefused::NetworkOrDevice),
                    "{check:?} {path}"
                );
            }
        }
    }

    #[test]
    fn on_windows_a_mapped_network_drive_still_opens() {
        // `Z:\…` on a drive the user mapped resolves to its share's UNC path.
        // Only a network path given as one is refused: by the time a path
        // has resolved, any connection has been made.
        let share = PathBuf::from(r"\\nas\projects");
        let fs = FakeFs(vec![
            (abs("p"), share.clone(), Kind::Folder),
            (abs("p/notes.md"), share.join("notes.md"), Kind::File),
        ]);
        for check in CHECKS {
            assert_eq!(
                checked_path(&abs("p/notes.md"), check, windows(), &fs),
                Ok(share.join("notes.md")),
                "{check:?}"
            );
        }
    }

    #[test]
    fn the_resolved_path_is_checked_and_is_what_gets_opened() {
        let fs = FakeFs(vec![
            (abs("p"), abs("p"), Kind::Folder),
            (abs("p/notes.md"), abs("p/notes.md"), Kind::File),
            // Document-named symlinks: to a script, and to a document.
            (abs("p/readme.md"), abs("p/run.bat"), Kind::File),
            (abs("p/latest.md"), abs("p/v2/notes.md"), Kind::File),
            // A symlink to a folder.
            (abs("p/docs"), abs("shared/docs"), Kind::Folder),
        ]);
        let rules = PathRules::default();
        let check = |path: &str, check| checked_path(&abs(path), check, rules, &fs);
        assert_eq!(
            check("p/readme.md", Check::FromUi),
            Err(PathRefused::NotDocumentOrFolder)
        );
        assert_eq!(
            check("p/latest.md", Check::FromUi),
            Ok(abs("p/v2/notes.md"))
        );
        assert_eq!(check("p/docs", Check::FromUi), Ok(abs("shared/docs")));
        assert_eq!(check("p/notes.md", Check::FromUi), Ok(abs("p/notes.md")));
        // The app's own paths are resolved too.
        assert_eq!(
            check("p/latest.md", Check::AppChosen),
            Ok(abs("p/v2/notes.md"))
        );
        // A revealed item is checked by where it leads, but it is the item
        // that was clicked that gets selected: the symlink, not its target.
        assert_eq!(check("p/readme.md", Check::Reveal), Ok(abs("p/readme.md")));
    }

    #[test]
    fn a_revealed_item_is_shown_as_itself_in_its_resolved_folder() {
        // The folder is resolved (`alias` leads to `p`) and the name is kept:
        // the file manager opens the real folder and selects what was
        // clicked, a symlink rather than where it leads.
        let fs = FakeFs(vec![
            (abs("p"), abs("p"), Kind::Folder),
            (abs("alias"), abs("p"), Kind::Folder),
            (abs("alias/readme.md"), abs("scripts/run.bat"), Kind::File),
            (abs("p/sub/.."), abs("p"), Kind::Folder),
            (abs(""), abs(""), Kind::Folder),
        ]);
        let reveal =
            |path: &str| checked_path(&abs(path), Check::Reveal, PathRules::default(), &fs);
        assert_eq!(reveal("alias/readme.md"), Ok(abs("p/readme.md")));
        // The whole path is still resolved first: a link that leads nowhere
        // is refused, though its folder exists.
        assert!(
            matches!(reveal("p/dangling.md"), Err(PathRefused::Unresolvable(_))),
            "{:?}",
            reveal("p/dangling.md")
        );
        // A root, or a path ending in `..`, has no name to keep: it is
        // revealed as it resolves.
        assert_eq!(reveal("p/sub/.."), Ok(abs("p")));
        assert_eq!(reveal(""), Ok(abs("")));
    }

    #[test]
    fn only_a_plain_name_is_joined_to_the_revealed_folder() {
        for name in ["readme.md", ".hidden", "Evil.app"] {
            assert!(is_plain_name(OsStr::new(name)), "{name:?}");
        }
        // Nothing, `.`, `..`, a root, or more than one component.
        for name in ["", ".", "..", "/x", "a/b"] {
            assert!(!is_plain_name(OsStr::new(name)), "{name:?}");
        }
        // On Windows a drive letter and `:` start a prefix (`Z::$DATA` names
        // a file's stream) and `\` separates; elsewhere these are plain names.
        for name in ["Z:", "Z::$DATA", r"a\b"] {
            assert_eq!(is_plain_name(OsStr::new(name)), !cfg!(windows), "{name:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_revealed_name_that_reads_as_a_drive_path_falls_back_to_the_checked_path() {
        // `p\Z::$DATA` is the default stream of the file `p\Z`, which is what
        // it resolves to. On its own the name reads as a path on drive Z, so
        // it isn't joined to the folder: the resolved path that was checked
        // comes back.
        let fs = FakeFs(vec![
            (abs("p"), abs("p"), Kind::Folder),
            (abs("p/Z::$DATA"), abs("p/Z"), Kind::File),
        ]);
        let revealed = checked_path(&abs("p/Z::$DATA"), Check::Reveal, windows(), &fs);
        assert!(
            revealed.as_ref().is_ok_and(|path| path.is_absolute()),
            "{revealed:?}"
        );
        assert_eq!(revealed, Ok(abs("p/Z")));
    }

    #[test]
    fn macos_packages_are_told_from_folders() {
        for name in [
            "Evil.app",
            "EVIL.APP",
            "Foo.APP",
            // A dot name: no extension as `Path::extension` reads it.
            ".app",
            "x.appex",
            "x.bundle",
            "Foo.framework",
            "x.plugin",
            "x.prefpane",
            "x.kext",
            "Setup.pkg",
            "x.mpkg",
            "x.xpc",
            "x.qlgenerator",
            "x.mdimporter",
            "x.saver",
            "x.service",
            "x.action",
            "x.workflow",
        ] {
            assert!(is_macos_package(&abs(&format!("p/{name}"))), "{name}");
        }
        for name in [
            "project", "my-app", "app", "notes.md", "x.app.md", "Contents",
        ] {
            assert!(!is_macos_package(&abs(&format!("p/{name}"))), "{name}");
        }
    }

    #[test]
    fn the_macos_package_extensions_are_lowercase() {
        // is_macos_package lowercases the name before it compares, so an
        // entry with a capital letter would never match.
        for extension in MACOS_PACKAGE_EXTENSIONS {
            assert_eq!(extension, extension.to_lowercase(), "{extension}");
        }
    }

    #[test]
    fn on_macos_a_folder_named_just_dot_app_is_never_launched() {
        // `Path::extension` sees no extension in a dot name, but `.app` ends
        // in `.app` like any app bundle's name: the lowercased name decides.
        let dir = tempfile::tempdir().unwrap();
        let macos = PathRules {
            macos: true,
            ..PathRules::default()
        };
        for (name, refused) in [(".app", true), ("Foo.APP", true), ("app", false)] {
            let folder = dir.path().join(name);
            std::fs::create_dir(&folder).unwrap();
            for check in [Check::AppChosen, Check::FromUi] {
                let checked = checked_path(&folder, check, macos, &SystemFs);
                if refused {
                    assert_eq!(checked, Err(PathRefused::Package), "{check:?} {name}");
                } else {
                    assert!(checked.is_ok(), "{check:?} {name}: {checked:?}");
                }
            }
        }
    }

    #[test]
    fn on_macos_a_path_that_resolves_to_a_package_is_never_launched() {
        // `open <dir>` launches an app bundle, and a git checkout of one
        // carries no quarantine flag. A symlink is resolved first.
        let fs = FakeFs(vec![
            (abs("p"), abs("p"), Kind::Folder),
            (abs("p/Evil.app"), abs("p/Evil.app"), Kind::Folder),
            (abs("p/project"), abs("p/Evil.app"), Kind::Folder),
            (
                abs("p/Evil.app/Contents"),
                abs("p/Evil.app/Contents"),
                Kind::Folder,
            ),
        ]);
        let macos = PathRules {
            macos: true,
            ..PathRules::default()
        };
        for check in [Check::AppChosen, Check::FromUi] {
            for path in ["p/Evil.app", "p/project"] {
                assert_eq!(
                    checked_path(&abs(path), check, macos, &fs),
                    Err(PathRefused::Package),
                    "{check:?} {path}"
                );
            }
            // A folder inside a package opens as a folder.
            assert!(checked_path(&abs("p/Evil.app/Contents"), check, macos, &fs).is_ok());
        }
        // Revealing selects the clicked item in Finder (`open -R`), which
        // launches nothing: the link itself, and a package as itself.
        assert_eq!(
            checked_path(&abs("p/project"), Check::Reveal, macos, &fs),
            Ok(abs("p/project"))
        );
        assert_eq!(
            checked_path(&abs("p/Evil.app"), Check::Reveal, macos, &fs),
            Ok(abs("p/Evil.app"))
        );
        // Elsewhere it is a folder like any other.
        assert!(checked_path(&abs("p/Evil.app"), Check::FromUi, PathRules::default(), &fs).is_ok());
    }

    #[test]
    fn under_wsl_the_resolved_path_is_the_one_that_must_be_safe() {
        // wslview resolves the path (`readlink -f`) before it pastes it into
        // PowerShell: a clean name that resolves to a quoted folder is
        // refused, like the quoted folder itself.
        let quoted = abs("p/x\";calc;\"");
        let fs = FakeFs(vec![
            (quoted.clone(), quoted.clone(), Kind::Folder),
            (abs("p/clean"), quoted.clone(), Kind::Folder),
            (abs("p/notes.md"), abs("p/notes.md"), Kind::File),
        ]);
        let wsl = PathRules {
            wsl: true,
            ..PathRules::default()
        };
        for check in [Check::AppChosen, Check::FromUi] {
            for path in [quoted.clone(), abs("p/clean")] {
                assert_eq!(
                    checked_path(&path, check, wsl, &fs),
                    Err(PathRefused::UnsafeCharacter('"')),
                    "{check:?} {path:?}"
                );
            }
            assert!(checked_path(&abs("p/notes.md"), check, wsl, &fs).is_ok());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_judged_by_where_it_leads() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let script = file_in(dir.path(), "run.sh");
        let notes = file_in(dir.path(), "notes.md");
        symlink(&script, dir.path().join("readme.md")).unwrap();
        symlink(&notes, dir.path().join("latest.md")).unwrap();
        assert_eq!(
            from_ui(&dir.path().join("readme.md")),
            Err(PathRefused::NotDocumentOrFolder)
        );
        assert_eq!(
            from_ui(&dir.path().join("latest.md")),
            Ok(std::fs::canonicalize(&notes).unwrap())
        );
    }

    #[test]
    fn a_revealed_file_is_shown_in_its_resolved_folder() {
        // On every platform: on Windows the folder comes back with its long
        // name and without the `\\?\` prefix, as the file manager takes it.
        let dir = tempfile::tempdir().unwrap();
        let notes = file_in(dir.path(), "notes.md");
        let folder = fleetify_core::canonicalize_no_verbatim(dir.path()).unwrap();
        assert_eq!(path_to_reveal(&notes), Ok(folder.join("notes.md")));
    }

    #[cfg(unix)]
    #[test]
    fn revealing_a_symlink_selects_the_link_not_its_target() {
        // `real/readme.md` leads to `run.bat` in another folder. The file
        // manager must open `real` and select `readme.md`, the item that was
        // clicked, also when `real` is reached through a symlink (`alias`).
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let script = file_in(dir.path(), "run.bat");
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        symlink(&script, real.join("readme.md")).unwrap();
        symlink(&real, dir.path().join("alias")).unwrap();
        let folder = std::fs::canonicalize(&real).unwrap();
        for path in [real.join("readme.md"), dir.path().join("alias/readme.md")] {
            assert_eq!(
                path_to_reveal(&path),
                Ok(folder.join("readme.md")),
                "{path:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn revealing_a_link_to_a_network_path_is_refused() {
        // Revealing still resolves the whole path, the link's target
        // included, before it selects the link: a link to a share that
        // can't be reached (there is no host `server` here) is refused, not
        // shown.
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("notes.md");
        if let Err(error) = std::os::windows::fs::symlink_file(r"\\server\share\x", &link) {
            // Creating a symlink needs developer mode or an administrator.
            eprintln!("skipped: no symlink can be created here ({error})");
            return;
        }
        let revealed = path_to_reveal(&link);
        assert!(revealed.is_err(), "{revealed:?}");
    }
}
