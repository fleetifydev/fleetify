# Installing Fleetify

> [!NOTE]
> Applies from the first public release (v0.2.0). Until it ships there is nothing to download: [build Fleetify from source](../README.md#build-from-source), as [CONTRIBUTING.md](../CONTRIBUTING.md#development-setup) describes.

Every release is published on the [Releases page](https://github.com/fleetifydev/fleetify/releases). Pick the file for your system, [verify it](#verify-a-download), and follow the steps for your OS below. To use Fleetify you sign in with a free Fleetify account the first time it starts; the [README](../README.md#requirements) lists the other requirements.

- [macOS](#macos)
- [Windows](#windows)
- [Linux](#linux)
- [Updates](#updates)
- [Verify a download](#verify-a-download)
- [Uninstall](#uninstall)

## macOS

Fleetify runs on macOS 11 or later. Its macOS build is signed with Fleetify's own certificate rather than one issued by Apple, and Apple hasn't notarized it, so macOS can't verify it and asks you to allow it once.

1. Download the `.dmg` for your Mac: the `aarch64` one for Apple silicon, the `x64` one for an Intel Mac.
2. Open the `.dmg` and drag **Fleetify** into **Applications**.
3. Open Fleetify. macOS refuses to open it and says it can't verify the app. Close the warning, without moving Fleetify to the Trash.
4. Open the security settings:
   - macOS 13 or later: choose **Apple menu → System Settings**, click **Privacy & Security** in the sidebar, and scroll down to **Security**;
   - macOS 11 or 12: choose **Apple menu → System Preferences → Security & Privacy**, then click **General**.
5. Next to the message about Fleetify, click **Open**, then **Open Anyway**; on some versions the first button already reads **Open Anyway**. The button is there for about an hour after you tried to open the app.
6. When macOS asks for your login password, enter it, then click **OK**. If it shows its warning once more, click **Open**.

macOS saves Fleetify as an exception, so it opens normally from then on. On macOS 14 and earlier you can instead Control-click Fleetify in the Applications folder in Finder and choose **Open**; macOS 15 removed that shortcut for apps that aren't notarized.

### The microphone permission

Voice dictation asks for access to the microphone the first time you use it. macOS records that permission against the app's code signature, and every macOS release of Fleetify is signed with the same certificate, so an update still matches it and macOS shouldn't ask again. If Fleetify ever moves to a different certificate, such as one issued by Apple, macOS asks once more.

## Windows

Fleetify runs on Windows 10 and 11, 64-bit. Its installer isn't signed, so Microsoft Defender SmartScreen warns you before it runs.

1. Download the installer, the file that ends in `x64-setup.exe`. Your browser may warn that the file isn't commonly downloaded. In Microsoft Edge, choose **…** next to the download, then **Keep**, **Show more** and **Keep anyway**; other browsers offer a similar **Keep** option.
2. Open it. Windows shows **Windows protected your PC**. Click **More info**: the dialog shows the file name and **Unknown publisher**. Check the file name, then click **Run anyway**.
3. Follow the installer. It installs Fleetify for your user account only, in `%LOCALAPPDATA%\Fleetify`, so it doesn't ask for administrator rights. If Windows lacks the Microsoft Edge WebView2 runtime, which Fleetify needs, the installer downloads it.

If there's no **Run anyway** button, a policy set by your organisation blocks apps that SmartScreen doesn't recognise. SmartScreen may warn again when you download a later version by hand, since every unsigned release starts with no reputation.

### Smart App Control

On Windows 11, Smart App Control, when it is on, blocks unsigned apps that Microsoft's cloud service can't vouch for, and it has no exception for a single app. Expect it to block Fleetify.

To run Fleetify then, you have to turn it off: **Windows Security → App & browser control → Smart App Control settings**. It also protects you from other unsigned apps, so weigh that first. Turning it back on later may not be simple. Microsoft says that recent Windows updates let you turn it on again in the Windows Security app without a clean installation. It also says that when Smart App Control is off because optional diagnostic data is turned off, "you'll need to reset this PC, or reinstall Windows, and select Send optional diagnostic data during the setup process" to turn it on.

## Linux

Fleetify runs on 64-bit x86 Linux with WebKitGTK 4.1, which Ubuntu 22.04, Debian 12 and newer releases provide. It comes in three packages.

**AppImage**, for most distributions, with nothing to install:

```bash
chmod +x Fleetify_*_amd64.AppImage
./Fleetify_*_amd64.AppImage
```

Keep the AppImage in a folder you own, such as `~/Applications`, so that it can replace itself when it updates.

AppImages need FUSE 2. If yours doesn't start and the error mentions FUSE or `libfuse.so.2`, install it:

- Ubuntu 24.04 or later, Debian 13 or later: `sudo apt install libfuse2t64`
- Ubuntu 22.04, Debian 12: `sudo apt install libfuse2`
- Fedora: `sudo dnf install fuse fuse-libs`

On Ubuntu the package comes from the universe repository. Don't install the package named `fuse` on Ubuntu 22.04 or later: it can break your system. To run Fleetify without FUSE, start it with `./Fleetify_*_amd64.AppImage --appimage-extract-and-run`, which unpacks it to a temporary folder at every start and so starts more slowly.

**`.deb`**, for Debian and Ubuntu:

```bash
sudo apt install ./Fleetify_*_amd64.deb
```

**`.rpm`**, for Fedora and openSUSE:

```bash
sudo dnf install ./Fleetify-*.x86_64.rpm      # Fedora
sudo zypper install ./Fleetify-*.x86_64.rpm   # openSUSE
```

The package manager also installs WebKitGTK and the other libraries Fleetify needs. The packages aren't GPG-signed: zypper says so and asks what to do, and answering **i** (ignore) installs the package.

Fleetify keeps your sign-in and your API keys in the desktop's keyring, the Secret Service that GNOME Keyring and KWallet provide. Most desktops run one; without one, Fleetify can't save them.

## Updates

Once installed, Fleetify updates itself.

- **macOS:** the microphone permission should carry over, as [above](#the-microphone-permission).
- **Linux:** the AppImage replaces itself in place. A `.deb` or `.rpm` install updates through `dpkg` or `rpm`, which install a system package, so Linux asks for your password.

## Verify a download

Each release comes with a `SHA256SUMS` file, which lists the SHA-256 checksum of every file in the release, and with GitHub build provenance attestations.

**Compare the checksum.** Download `SHA256SUMS` into the folder that holds the file, then run:

- Linux: `sha256sum --check --ignore-missing SHA256SUMS`, which checks every file it lists that is in the folder;
- macOS: `shasum -a 256 <file>`, then compare the result with the file's line in `SHA256SUMS`;
- Windows, in PowerShell: `Get-FileHash <file>`, then compare the hash with the file's line in `SHA256SUMS`; the case of the letters doesn't matter.

**Check where it was built**, with the [GitHub CLI](https://cli.github.com):

```bash
gh attestation verify <file> --repo fleetifydev/fleetify
```

A pass shows that the file was built by this repository's GitHub Actions and hasn't changed since. [SECURITY.md](../SECURITY.md#verifying-a-release) covers the same checks.

## Uninstall

Uninstalling removes the app but not your data, and it changes nothing on fleetify.dev: your account stays, and so does what dashboard sync already sent.

- **macOS:** quit Fleetify, then drag **Fleetify** from **Applications** to the Trash.
- **Windows:** open **Settings → Apps → Installed apps** (on Windows 10, **Apps & features**), then choose **Fleetify → Uninstall**. In the uninstaller, **Delete the application data** also removes Fleetify's settings and webview data, the two `com.fleetify.app` folders listed below.
- **Linux:** delete the AppImage, or remove the package with `sudo apt remove fleetify`, `sudo dnf remove fleetify` or `sudo zypper remove fleetify`.

### Remove your data

Quit Fleetify first. Fleetify's own data, such as your sessions and chat history (`fleet.db`), your Library, installed plugins, MCP servers, device ID and telemetry queues, is in `~/.fleetify`, or in the folder `FLEETIFY_HOME` names if you set it. The rest depends on your OS.

**macOS:**

- `~/.fleetify`
- settings: `~/Library/Application Support/com.fleetify.app`
- webview data and caches: `~/Library/WebKit/com.fleetify.app`, `~/Library/HTTP Storages/com.fleetify.app` and `~/Library/Caches/com.fleetify.app`
- logs: `~/Library/Logs/Fleetify`
- window state and preferences, if present: `~/Library/Saved Application State/com.fleetify.app.savedState` and `~/Library/Preferences/com.fleetify.app.plist`
- the built-in browser's profile: the `fleetify-browser-…` folders in `$TMPDIR`
- credentials: open **Keychain Access**, search for `Fleetify`, and delete the items named `Fleetify` and `Fleetify-…`: your sign-in, the GitHub link, and the voice, provider and router API keys.

**Windows:**

- `%USERPROFILE%\.fleetify`
- settings: `%APPDATA%\com.fleetify.app`
- webview data: `%LOCALAPPDATA%\com.fleetify.app`
- logs: `%LOCALAPPDATA%\Fleetify\logs`. The uninstaller leaves them, and with them the `%LOCALAPPDATA%\Fleetify` folder.
- the built-in browser's profile: the `fleetify-browser-…` folders in `%TEMP%`
- credentials: open **Control Panel → Credential Manager → Windows Credentials**, and remove each generic credential whose name contains `Fleetify`, such as `refresh_token.Fleetify`.

**Linux:**

- `~/.fleetify`
- settings and webview data: `~/.local/share/com.fleetify.app`, and the cache in `~/.cache/com.fleetify.app`
- logs: `~/.local/state/fleetify/logs`
- the built-in browser's profile: the `fleetify-browser-…` folders in `/tmp`, or in `$TMPDIR` if it is set
- credentials: in your keyring app, such as **Passwords and Keys** (Seahorse) or **KWallet Manager**, search for `Fleetify` and delete the items it finds. Fleetify also caches them in the kernel keyring, which clears when you restart.

If you set `XDG_DATA_HOME`, `XDG_CACHE_HOME` or `XDG_STATE_HOME`, the Linux folders are under those instead.

### In your projects, agents and Docker

- A session that runs in a git worktree creates it in `.fleetify-worktrees/` inside the project, on a branch whose name starts with `fleet/`. Remove the ones you don't need with `git worktree remove`, then delete their branches.
- In container mode, a container Fleetify started for a session, `fleetify-…`, stays in Docker until you delete the session, and so does the image it built from your Dockerfile, `fleetify-img-…`. Delete those sessions before you uninstall, or remove what's left with `docker rm -f` and `docker image rm`.
- Session rules add a block marked `fleetify:rule:session-…` to the project's rule file, such as `CLAUDE.md`. Clearing a session's rules removes its block.
- Library items and plugins you installed for an agent live in that agent's own configuration, for example in `~/.claude/skills/`. When you delete them in Fleetify, it removes what it wrote; after you uninstall, they stay. Delete the ones you don't want before you uninstall.

### `fleet-wipe`, from a source checkout

The installers don't include a reset tool, but a [source checkout](../README.md#build-from-source) has `fleet-wipe`, which removes Fleetify's entries from the OS credential store. Preview what it would remove first:

```bash
cargo run -p fleet-wipe -- --dry-run
```

It names each entry by its service only, and changes nothing. To delete the entries:

```bash
cargo run -p fleet-wipe -- --yes
```

`--help` lists the options, and any other argument is refused without changing anything, as is a run with no arguments.

On Linux it removes every Fleetify item from the Secret Service and from the kernel keyring cache. On macOS and Windows it removes only your sign-in, so delete the other entries by hand, as listed above. It doesn't touch any files.
