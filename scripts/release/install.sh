#!/bin/sh
# install.sh: install Fleetify on macOS or Linux from its GitHub release,
# once the download matches the release's SHA256SUMS.
#
#   sh install.sh [--version X.Y.Z] [--appimage | --deb | --rpm] [--dir PATH] [--download-only]
#
# Piped into sh, it takes its options after "sh -s --".
#
# It downloads SHA256SUMS and the release's file for this machine from
# https://github.com/fleetifydev/fleetify/releases/download/v<version>/, or
# from $FLEETIFY_INSTALL_BASE/download/v<version>/ when that is set. Without
# --version, the version is the latest release's, read from
# latest/download/latest.json there. The file must match its line in
# SHA256SUMS (sha256sum -c, or shasum -a 256 -c on macOS) before anything is
# installed:
#
#   macOS  Fleetify.app, from the app archive for this Mac (Apple silicon or
#          Intel), into --dir: by default /Applications when you can write to
#          it, else ~/Applications. An earlier Fleetify.app is replaced.
#   Linux  the AppImage, as --dir/fleetify (by default ~/.local/bin), with a
#          menu entry, fleetify.desktop, and the AppImage's own icon, under
#          $XDG_DATA_HOME (by default ~/.local/share). With --deb or --rpm, the
#          package instead, through sudo and apt-get, or dnf or zypper; each
#          command is printed before it runs.
#
# With --download-only, it saves the checked file in --dir (by default the
# current folder), installs nothing, and prints the command that installs a
# package. Only --deb and --rpm use sudo. Running it again replaces the
# install. Each step is printed, prefixed "fleetify-install:".
#
# Exit codes: 0 installed (or downloaded); 1 failed, with nothing installed
# when the download didn't match SHA256SUMS; 2 usage.
set -eu

DEFAULT_BASE=https://github.com/fleetifydev/fleetify/releases
NL='
'

# The folders and files a run makes, which cleanup removes or puts back.
tmp=
staged=
old=
target=

say() { printf 'fleetify-install: %s\n' "$*"; }
warn() { printf 'fleetify-install: warning: %s\n' "$*" >&2; }
die() {
  printf 'fleetify-install: error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'usage: install.sh [--version X.Y.Z] [--appimage | --deb | --rpm] [--dir PATH] [--download-only]' \
    '' \
    "Installs Fleetify from its GitHub release, once the download matches the" \
    "release's SHA256SUMS. Piped into sh, give the options after: sh -s --" \
    '' \
    '  --version X.Y.Z  the release to install; by default the latest' \
    '  --appimage       Linux: the AppImage, with a menu entry (the default)' \
    '  --deb            Linux: the .deb, through sudo apt-get' \
    '  --rpm            Linux: the .rpm, through sudo dnf or zypper' \
    '  --dir PATH       where the AppImage or Fleetify.app goes, by default' \
    '                   ~/.local/bin, or /Applications (~/Applications when you' \
    "                   can't write to it); with --download-only, where the file" \
    '                   goes, by default the current folder' \
    '  --download-only  download and check the file, and install nothing' \
    '  -h, --help       show this help' \
    '' \
    "FLEETIFY_INSTALL_BASE replaces $DEFAULT_BASE."
}

usage_error() {
  printf 'fleetify-install: %s\n' "$1" >&2
  usage >&2
  exit 2
}

# Whether $1 is a version as releases are numbered: MAJOR.MINOR.PATCH.
is_version() {
  case $1 in
  '' | *[!0-9.]*) return 1 ;;
  esac
  printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
}

# $1 as a shell word: as it is when it holds only safe characters, else in
# single quotes.
shell_word() {
  case $1 in
  '' | *[!A-Za-z0-9_./:@%+=,-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
  *) printf '%s' "$1" ;;
  esac
}

# A command line, its words quoted for a shell where they need it.
command_line() {
  line=
  for word in "$@"; do line="$line${line:+ }$(shell_word "$word")"; done
  printf '%s' "$line"
}

# $1, a path, as an argument of a desktop entry's Exec key: as it is when it
# holds only safe characters, else in double quotes, escaped as the Desktop
# Entry Specification asks: a backslash before each \ " ` and $, then each
# backslash doubled, as the value is a string, and each % doubled.
desktop_arg() {
  case $1 in
  *[!A-Za-z0-9_./+@,-]*) printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g')" ;;
  *) printf '%s' "$1" ;;
  esac
}

# Remove what a run leaves half done, and put back an app it moved aside.
cleanup() {
  if [ -n "$staged" ]; then rm -rf "$staged"; fi
  if [ -n "$old" ] && [ -e "$old" ] && [ ! -e "$target" ]; then mv "$old" "$target"; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}

# Download $1 to $2, following redirects, with a progress bar for $3 = progress
# when someone watches.
fetch() {
  if [ "${3:-}" = progress ] && [ -t 2 ]; then
    curl --fail --location --proto "$proto" --proto-redir "$proto" --retry 3 --progress-bar --output "$2" "$1"
  else
    curl --fail --location --proto "$proto" --proto-redir "$proto" --retry 3 --silent --show-error --output "$2" "$1"
  fi
}

# Check the checksum file $1, in the current folder, with sha256sum, or
# shasum on macOS.
sum_check() {
  if [ "$sum_tool" = shasum ]; then shasum -a 256 -c "$1"; else sha256sum -c "$1"; fi
}

# Check $tmp/$asset against its line in $tmp/SHA256SUMS.
verify() {
  say "checking $asset against SHA256SUMS"
  expected=$(awk -v name="$asset" 'NF == 2 && ($2 == name || $2 == "*" name) { print $1 }' "$tmp/SHA256SUMS") ||
    die "can't read SHA256SUMS"
  case $expected in
  '') die "SHA256SUMS has no line for $asset; nothing was installed" ;;
  *[!0-9a-f]*) die "SHA256SUMS has more than one line for $asset, or a malformed one; nothing was installed" ;;
  esac
  [ ${#expected} -eq 64 ] || die "SHA256SUMS has a malformed line for $asset; nothing was installed"
  printf '%s  %s\n' "$expected" "$asset" >"$tmp/$asset.sha256"
  if ! (cd "$tmp" && sum_check "$asset.sha256") >"$tmp/check.log" 2>&1; then
    die "checksum mismatch: $asset doesn't match its line in SHA256SUMS; nothing was installed"
  fi
  say "checksum OK: $expected"
}

# The package manager here for the package: apt-get for a .deb, dnf or else
# zypper for an .rpm. Prints nothing when there is none.
package_manager() {
  case $kind in
  deb) if command -v apt-get >/dev/null 2>&1; then echo apt-get; fi ;;
  rpm)
    if command -v dnf >/dev/null 2>&1; then
      echo dnf
    elif command -v zypper >/dev/null 2>&1; then
      echo zypper
    fi
    ;;
  esac
}

# The command that installs the package file $2 with the package manager $1,
# through sudo unless this runs as root. With $3 = run, it is printed, then
# run; otherwise it is printed after the text $3.
package_command() {
  manager=$1
  package=$2
  action=$3
  case $manager in
  apt-get) set -- apt-get install -y "$package" ;;
  dnf) set -- dnf install -y "$package" ;;
  *) set -- zypper --non-interactive install --allow-unsigned-rpm "$package" ;;
  esac
  if [ "$(id -u)" -ne 0 ]; then set -- sudo "$@"; fi
  if [ "$action" != run ]; then
    say "$action$(command_line "$@")"
    return 0
  fi
  if [ "$1" = sudo ] && ! command -v sudo >/dev/null 2>&1; then die "sudo is needed to install the package"; fi
  say "running: $(command_line "$@")"
  "$@" || die "$manager couldn't install $asset"
}

# Install the checked package with its package manager.
install_package() {
  manager=$(package_manager) || true
  if [ -z "$manager" ]; then
    case $kind in
    deb) die "apt-get isn't here: --deb is for Debian and Ubuntu" ;;
    *) die "neither dnf nor zypper is here: --rpm is for Fedora and openSUSE" ;;
    esac
  fi
  # Readable by the package manager's own users; only you can change it.
  chmod 755 "$tmp"
  chmod 644 "$tmp/$asset"
  package_command "$manager" "$tmp/$asset" run
  say "Fleetify $version is installed, from $asset"
}

# Take the AppImage's icon out of it: .DirIcon, followed while it is a link.
# A Tauri AppImage's .DirIcon is an absolute link into the folder it was built
# in, so an absolute link is followed by its name, from the AppImage's root.
# Prints the icon's path; fails when there is none.
extract_icon() {
  work=$tmp/icon
  mkdir -p "$work" || return 1
  entry=.DirIcon
  hops=0
  while :; do
    (cd "$work" && "$1" --appimage-extract "$entry") >/dev/null 2>&1 || return 1
    file=$work/squashfs-root/$entry
    if [ -f "$file" ] && [ ! -L "$file" ]; then break; fi
    [ -L "$file" ] || return 1
    hops=$((hops + 1))
    [ "$hops" -le 4 ] || return 1
    link=$(readlink "$file") || return 1
    case $link in
    /*) entry=${link##*/} ;;
    *) case $entry in */*) entry=${entry%/*}/$link ;; *) entry=$link ;; esac ;;
    esac
    case $entry in
    '' | /* | .. | ../* | */.. | */../* | *[!A-Za-z0-9._@/-]*) return 1 ;;
    esac
  done
  printf '%s\n' "$file"
}

install_appimage() {
  [ -n "${HOME:-}" ] || die "HOME isn't set"
  bin_dir=${dir:-$HOME/.local/bin}
  mkdir -p "$bin_dir" || die "can't make $bin_dir"
  bin_dir=$(CDPATH='' cd -- "$bin_dir" && pwd) || die "can't use $bin_dir"
  case $bin_dir in *"$NL"*) die "can't put Fleetify in a folder with a line break in its name" ;; esac
  target=$bin_dir/fleetify
  [ ! -d "$target" ] || die "$target is a folder"
  staged=$bin_dir/.fleetify.install.$$
  mv "$tmp/$asset" "$staged" || die "can't write to $bin_dir"
  chmod 755 "$staged"
  mv -f "$staged" "$target" || die "can't install $target"
  staged=
  say "installed $target"

  case ${XDG_DATA_HOME:-} in
  /*) data=$XDG_DATA_HOME ;;
  *) data=$HOME/.local/share ;;
  esac
  apps=$data/applications
  mkdir -p "$apps" || die "can't make $apps"
  {
    printf '%s\n' "# Fleetify's menu entry, written by its install.sh" '[Desktop Entry]' 'Type=Application' 'Name=Fleetify' \
      'Comment=A command center for AI agents.'
    printf 'Exec=%s %%U\n' "$(desktop_arg "$target")"
    printf '%s\n' 'Icon=fleetify' 'Terminal=false' 'Categories=Development;' 'StartupWMClass=fleetify-app'
  } >"$apps/fleetify.desktop" || die "can't write $apps/fleetify.desktop"
  say "added the menu entry $apps/fleetify.desktop"

  icons=$data/icons/hicolor/256x256/apps
  if icon=$(extract_icon "$target") && mkdir -p "$icons" && cp "$icon" "$icons/fleetify.png"; then
    say "added the icon $icons/fleetify.png"
  else
    warn "couldn't take the icon out of the AppImage; the menu entry shows a generic one"
  fi

  say "Fleetify $version is installed: $target"
  case :${PATH:-}: in
  *:"$bin_dir":*) ;;
  *) say "$bin_dir isn't on your PATH: start Fleetify from your app menu, or as $target" ;;
  esac
}

install_app() {
  apps_dir=$dir
  if [ -z "$apps_dir" ]; then
    if [ -w /Applications ]; then
      apps_dir=/Applications
    else
      [ -n "${HOME:-}" ] || die "HOME isn't set: give --dir"
      apps_dir=$HOME/Applications
    fi
  fi
  mkdir -p "$apps_dir" || die "can't make $apps_dir"
  apps_dir=$(CDPATH='' cd -- "$apps_dir" && pwd) || die "can't use $apps_dir"
  unpacked=$tmp/unpacked
  mkdir "$unpacked"
  tar -xzf "$tmp/$asset" -C "$unpacked" || die "can't unpack $asset"
  [ -f "$unpacked/Fleetify.app/Contents/Info.plist" ] || die "$asset holds no Fleetify.app"
  target=$apps_dir/Fleetify.app
  staged=$apps_dir/.Fleetify.app.install.$$
  mv "$unpacked/Fleetify.app" "$staged" || die "can't write to $apps_dir"
  if [ -e "$target" ] || [ -L "$target" ]; then
    old=$apps_dir/.Fleetify.app.old.$$
    mv "$target" "$old" || die "can't replace $target"
  fi
  mv "$staged" "$target" || die "can't install $target"
  staged=
  if [ -n "$old" ]; then rm -rf "$old"; fi
  old=
  say "Fleetify $version is installed: $target"
}

main() {
  version=
  kind=
  dir=
  download_only=
  while [ $# -gt 0 ]; do
    case $1 in
    --version)
      if [ $# -lt 2 ] || [ -z "$2" ]; then usage_error "--version needs a value"; fi
      version=$2
      shift 2
      ;;
    --version=*)
      version=${1#*=}
      [ -n "$version" ] || usage_error "--version needs a value"
      shift
      ;;
    --dir)
      if [ $# -lt 2 ] || [ -z "$2" ]; then usage_error "--dir needs a value"; fi
      case $2 in -*) usage_error "--dir needs a value" ;; esac
      dir=$2
      shift 2
      ;;
    --dir=*)
      dir=${1#*=}
      [ -n "$dir" ] || usage_error "--dir needs a value"
      shift
      ;;
    --appimage | --deb | --rpm)
      if [ -n "$kind" ] && [ "$kind" != "${1#--}" ]; then usage_error "choose one of --appimage, --deb and --rpm"; fi
      kind=${1#--}
      shift
      ;;
    --download-only)
      download_only=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) usage_error "unknown option: $1" ;;
    esac
  done
  case $version in v[0-9]*) version=${version#v} ;; esac
  if [ -n "$version" ] && ! is_version "$version"; then
    usage_error "--version takes a release's version, MAJOR.MINOR.PATCH, such as 0.2.0"
  fi
  case $dir in *"$NL"*) usage_error "--dir can't hold a line break" ;; esac
  if [ -n "$dir" ] && [ -z "$download_only" ] && { [ "$kind" = deb ] || [ "$kind" = rpm ]; }; then
    usage_error "--dir goes with the AppImage, Fleetify.app or --download-only, not with --$kind"
  fi

  base=${FLEETIFY_INSTALL_BASE:-$DEFAULT_BASE}
  base=${base%/}
  case $base in
  https://*) proto='=https' ;;
  http://*) proto='=http,https' ;;
  *) usage_error "FLEETIFY_INSTALL_BASE must be an http or https URL, not $base" ;;
  esac

  os=$(uname -s)
  machine=$(uname -m)
  case $os in
  Linux)
    case $machine in
    x86_64 | amd64) ;;
    *) die "Fleetify's Linux builds are for x86_64, and this machine is $machine" ;;
    esac
    [ -n "$kind" ] || kind=appimage
    ;;
  Darwin)
    if [ -n "$kind" ]; then usage_error "--$kind is for Linux; on macOS, install.sh installs Fleetify.app"; fi
    kind=app
    case $machine in
    arm64) mac_arch=aarch64 ;;
    x86_64)
      # A shell under Rosetta sees x86_64 on Apple silicon.
      if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then mac_arch=aarch64; else mac_arch=x64; fi
      ;;
    *) die "Fleetify's macOS builds are for Apple silicon and Intel, and this Mac is $machine" ;;
    esac
    ;;
  *) die "install.sh installs Fleetify on macOS and Linux, not on $os; on Windows, use install.ps1" ;;
  esac

  command -v curl >/dev/null 2>&1 || die "curl is needed: install it, then run this again"
  if [ "$os" = Linux ] && command -v sha256sum >/dev/null 2>&1; then
    sum_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    sum_tool=shasum
  else
    die "sha256sum or shasum is needed to check the download"
  fi

  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  tmp_root=${TMPDIR:-/tmp}
  tmp=$(mktemp -d "${tmp_root%/}/fleetify-install.XXXXXX") || die "can't make a folder in $tmp_root"

  if [ -z "$version" ]; then
    url=$base/latest/download/latest.json
    say "finding the latest release: $url"
    fetch "$url" "$tmp/latest.json" || die "can't download $url"
    version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9.]*\)".*/\1/p' "$tmp/latest.json") || true
    is_version "$version" || die "$url names no version"
    say "the latest release is $version"
  fi

  case $kind in
  appimage) asset=Fleetify_${version}_amd64.AppImage ;;
  deb) asset=Fleetify_${version}_amd64.deb ;;
  rpm) asset=Fleetify-${version}-1.x86_64.rpm ;;
  app) asset=Fleetify_${version}_${mac_arch}.app.tar.gz ;;
  esac
  release=$base/download/v$version
  say "Fleetify $version: $asset, from $release"
  say "downloading SHA256SUMS"
  fetch "$release/SHA256SUMS" "$tmp/SHA256SUMS" || die "can't download $release/SHA256SUMS"
  say "downloading $asset"
  fetch "$release/$asset" "$tmp/$asset" progress || die "can't download $release/$asset"
  verify

  if [ -n "$download_only" ]; then
    dest=${dir:-.}
    mkdir -p "$dest" || die "can't make $dest"
    mv -f "$tmp/$asset" "$dest/$asset" || die "can't write $dest/$asset"
    say "downloaded and checked $dest/$asset; nothing was installed"
    case $kind in
    deb | rpm)
      manager=$(package_manager) || true
      if [ -n "$manager" ]; then
        package_command "$manager" "$dest/$asset" "to install it, run: "
      elif [ "$kind" = deb ]; then
        package_command apt-get "$dest/$asset" "to install it, run: "
      else
        package_command dnf "$dest/$asset" "to install it on Fedora, run: "
        package_command zypper "$dest/$asset" "or on openSUSE: "
      fi
      ;;
    esac
    return 0
  fi

  case $kind in
  appimage) install_appimage ;;
  deb | rpm) install_package ;;
  app) install_app ;;
  esac
}

main "$@"
