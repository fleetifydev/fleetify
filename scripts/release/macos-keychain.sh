#!/usr/bin/env bash
# macos-keychain.sh — give codesign a signing identity in a keychain of the
# job's own, and check that it signs with it the way Tauri will, before
# tauri bundle runs. Both macOS identity steps of build.yml run it, so every
# dry run also goes through the release's import path.
#
#   IDENTITY=<name> P12=<file> P12_PASSWORD=<password> bash scripts/release/macos-keychain.sh import
#   IDENTITY=<name> bash scripts/release/macos-keychain.sh dry-run
#   IDENTITY=<name> bash scripts/release/macos-keychain.sh make-dry-run-identity
#   IDENTITY=<name> bash scripts/release/macos-keychain.sh cert-config
#
# import puts the identity in the PKCS#12 file P12 into a new keychain in
# CODESIGN_DIR, puts that keychain first in the user's search list, trusts
# the certificate for code signing, checks that `security find-identity -v`
# lists the identity with no complaint, and signs a probe binary with it as
# Tauri will. It then writes APPLE_SIGNING_IDENTITY to $GITHUB_ENV, for
# tauri bundle; CODESIGN_KEYCHAIN goes there as soon as the keychain exists,
# for the step that deletes it.
#
# dry-run makes an identity for the run (make-dry-run-identity: a
# self-signed certificate, from the OpenSSL config cert-config prints) and
# imports it.
#
# No password is ever an argument of openssl: it reads them from the
# environment (-passin env: / -passout env:). security import takes a
# password only as an argument, so it gets a copy of the p12 re-encrypted,
# through a pipe, under a password made here: the key is never in a file
# unencrypted, and P12_PASSWORD never reaches a command line. The key goes
# into the keychain non-extractable (-x).
#
# Environment:
#   IDENTITY          the identity's name: its certificate's common name
#   P12, P12_PASSWORD the identity to import, and its password (import)
#   GITHUB_ENV        the file later steps read their environment from
#                     (import, dry-run)
#   CODESIGN_DIR      the folder for the keychain and the files made on the
#                     way (default: $RUNNER_TEMP/codesign)
#   ENTITLEMENTS      the entitlements the probe is signed with, as Tauri
#                     signs the app (default: src-tauri/Entitlements.plist)
#   CODESIGN_TIMEOUT  how many seconds each codesign call may take
#                     (default: 60)
#
# Exit codes: 0 done; 1 a step failed, said with a ::error:: line; 2 usage.
set -euo pipefail
umask 077

usage() {
  echo "usage: IDENTITY=<name> [P12=<file> P12_PASSWORD=<password>] bash scripts/release/macos-keychain.sh import|dry-run|make-dry-run-identity|cert-config" >&2
  exit 2
}

fail() {
  echo "::error::$*"
  exit 1
}

# Each named variable must be set and not empty.
require() {
  local name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      echo "macos-keychain.sh: $name is not set" >&2
      usage
    fi
  done
}

# Hide a password made here from the job's log.
mask() {
  echo "::add-mask::$1"
}

# Every codesign call runs under this watchdog: SIGALRM stops one that
# waits on a dialog after CODESIGN_TIMEOUT seconds (exit 142), so the
# diagnostics below still run before the step's own timeout.
watchdog() {
  perl -e 'alarm shift; exec @ARGV' "$CODESIGN_TIMEOUT" "$@"
}

# The dry run's identity name goes into an OpenSSL config, where # and $
# mean something: it may hold only plain characters.
plain_identity() {
  require IDENTITY
  local plain='^[A-Za-z0-9][A-Za-z0-9 ._-]*$'
  if [[ ! $IDENTITY =~ $plain ]]; then
    fail "the dry run's identity name must be letters, digits, spaces, dots, dashes and underscores: \"$IDENTITY\""
  fi
}

# The dry run's certificate, shaped like the release one: self-signed, for
# code signing only, each extension once. openssl req reads this file alone
# (-config), never the system's openssl.cnf: the runner's openssl applied
# that file's x509_extensions (a CA's, basicConstraints among them) besides
# the ones it was given, so the certificate carried basicConstraints twice
# and codesign skipped the identity for an "Unknown critical cert
# extension". authorityKeyIdentifier needs keyid:always: OpenSSL 3 leaves a
# plain keyid out of a self-signed certificate, and the release certificate
# has it.
cert_config() {
  plain_identity
  cat <<EOF
[req]
prompt = no
distinguished_name = dn
x509_extensions = ext
default_md = sha256

[dn]
CN = $IDENTITY
O = The Fleetify Authors

[ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
}

# Make the run's identity in CODESIGN_DIR: identity.p12, under a password
# made here, which P12 and P12_PASSWORD then name. The key is written only
# encrypted, under that password.
make_dry_run_identity() {
  local dir=$CODESIGN_DIR
  plain_identity
  cert_config > "$dir/identity.cnf"
  echo "OpenSSL: $(openssl version)"
  P12_PASSWORD=$(openssl rand -hex 24)
  export P12_PASSWORD
  mask "$P12_PASSWORD"
  openssl req -x509 -newkey rsa:2048 -days 2 -config "$dir/identity.cnf" \
    -keyout "$dir/identity.key" -passout env:P12_PASSWORD -out "$dir/identity.pem"
  echo "The run's certificate, made for this run alone:"
  openssl x509 -in "$dir/identity.pem" -noout -text -certopt no_pubkey,no_sigdump
  openssl pkcs12 -export -name "$IDENTITY" -inkey "$dir/identity.key" -passin env:P12_PASSWORD \
    -in "$dir/identity.pem" -out "$dir/identity.p12" -passout env:P12_PASSWORD \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
  rm -f "$dir/identity.key"
  P12="$dir/identity.p12"
}

# The identity must be listed as valid, and nothing may follow its quoted
# name: find-identity -v still counts an identity whose certificate codesign
# refuses, with the reason after the name, such as "(Unknown critical cert
# extension)" or "(CSSMERR_TP_NOT_TRUSTED)".
check_identity() {
  local keychain=$1 listing line rest found=""
  local entry='^[[:space:]]*[0-9]+\) ([0-9A-F]{40}) "(.*)$'
  listing=$(security find-identity -v -p codesigning "$keychain")
  echo "$listing"
  while IFS= read -r line; do
    [[ $line =~ $entry ]] || continue
    rest=${BASH_REMATCH[2]}
    if [[ $rest == "$IDENTITY\"" ]]; then
      found=yes
    elif [[ $rest == "$IDENTITY\""* ]]; then
      fail "codesign won't sign as \"$IDENTITY\": security find-identity marks it: ${line#"${line%%[![:space:]]*}"}"
    fi
  done <<< "$listing"
  if [ -z "$found" ]; then
    security find-identity -p codesigning "$keychain" || true
    fail "codesign can't sign as \"$IDENTITY\": security find-identity -v doesn't list it as valid"
  fi
}

# Sign the probe as Tauri signs a binary: codesign --force -s <identity>
# --options runtime --entitlements <file>, with no --keychain, so codesign
# finds the identity by name in the search list; then verify it.
sign_probe() {
  watchdog codesign --force "$@" --options runtime --entitlements "$ENTITLEMENTS" "$PROBE" \
    && watchdog codesign --verify --strict "$PROBE"
}

retry() {
  local how=$1 status=0
  shift
  sign_probe "$@" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "Retry $how: signed"
  else
    echo "Retry $how: failed (exit $status)"
  fi
}

# The probe: a binary like the ones Tauri signs (built here with cc: thin,
# of this machine's arch, linker-signed on arm64). A refusal shows here,
# with what codesign sees, rather than inside tauri bundle.
probe() {
  local keychain=$1 cert=$2 status=0 sha1
  PROBE="$CODESIGN_DIR/probe"
  printf 'int main(void) { return 0; }\n' | cc -x c -o "$PROBE" -
  sign_probe -s "$IDENTITY" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "codesign signs a probe as \"$IDENTITY\", the way Tauri will"
    return 0
  fi
  if [ "$status" -eq 142 ]; then
    echo "codesign didn't finish within ${CODESIGN_TIMEOUT}s, so the watchdog stopped it: it may wait on a dialog"
  fi
  echo "Code-signing identities in the whole keychain search list:"
  security find-identity -v -p codesigning || true
  echo "The user keychain search list:"
  security list-keychains -d user || true
  retry "with --keychain $keychain" -s "$IDENTITY" --keychain "$keychain"
  sha1=$(openssl x509 -in "$cert" -noout -fingerprint -sha1 | sed -e 's/^[^=]*=//' -e 's/://g')
  retry "by the certificate's SHA-1, $sha1" -s "$sha1"
  fail "codesign can't sign as \"$IDENTITY\" the way Tauri does; the lines above show what it sees"
}

import_identity() {
  require IDENTITY P12 P12_PASSWORD GITHUB_ENV
  export P12_PASSWORD
  local dir=$CODESIGN_DIR
  local keychain="$dir/fleetify.keychain-db" cert="$dir/certificate.pem" keychain_password
  # The certificates alone: the identity's, for the trust setting and the
  # SHA-1, and all of them, for the copy below.
  openssl pkcs12 -in "$P12" -passin env:P12_PASSWORD -nokeys -clcerts | openssl x509 -out "$cert"
  openssl pkcs12 -in "$P12" -passin env:P12_PASSWORD -nokeys -out "$dir/certificates.pem"
  IMPORT_PASSWORD=$(openssl rand -hex 24)
  export IMPORT_PASSWORD
  mask "$IMPORT_PASSWORD"
  # The copy security import reads, in the older PKCS#12 ciphers, which are
  # the ones it reads. The key comes through a pipe, so no file holds it
  # unencrypted; it can't come on stdin with the certificates, as
  # openssl pkcs12 -export reads its -in twice, for the key and for them.
  openssl pkcs12 -in "$P12" -passin env:P12_PASSWORD -nocerts -nodes \
    | openssl pkcs12 -export -name "$IDENTITY" -in "$dir/certificates.pem" -inkey /dev/stdin \
      -out "$dir/import.p12" -passout env:IMPORT_PASSWORD -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
  keychain_password=$(openssl rand -hex 24)
  mask "$keychain_password"
  security create-keychain -p "$keychain_password" "$keychain"
  echo "CODESIGN_KEYCHAIN=$keychain" >> "$GITHUB_ENV"
  # No timeout: the keychain doesn't lock while the job runs.
  security set-keychain-settings "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$dir/import.p12" -k "$keychain" -f pkcs12 -x -P "$IMPORT_PASSWORD" -T /usr/bin/codesign
  rm -f "$dir/import.p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
  local searched=() path
  while IFS= read -r path; do searched+=("$path"); done \
    < <(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')
  security list-keychains -d user -s "$keychain" ${searched[@]+"${searched[@]}"}
  # A self-signed certificate is valid only where it is trusted.
  sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$cert"
  check_identity "$keychain"
  probe "$keychain" "$cert"
  echo "APPLE_SIGNING_IDENTITY=$IDENTITY" >> "$GITHUB_ENV"
}

# The folder for the keychain and the files made on the way, for this user alone.
prepare_dir() {
  if [ -z "${CODESIGN_DIR:-}" ]; then
    require RUNNER_TEMP
    CODESIGN_DIR="$RUNNER_TEMP/codesign"
  fi
  mkdir -p "$CODESIGN_DIR"
  chmod 700 "$CODESIGN_DIR"
}

ENTITLEMENTS=${ENTITLEMENTS:-src-tauri/Entitlements.plist}
CODESIGN_TIMEOUT=${CODESIGN_TIMEOUT:-60}
if [[ ! $CODESIGN_TIMEOUT =~ ^[1-9][0-9]*$ ]]; then
  echo "macos-keychain.sh: CODESIGN_TIMEOUT must be a whole number of seconds" >&2
  usage
fi

[ $# -eq 1 ] || usage
case "$1" in
  cert-config) cert_config ;;
  make-dry-run-identity)
    prepare_dir
    make_dry_run_identity
    ;;
  dry-run)
    require GITHUB_ENV
    prepare_dir
    make_dry_run_identity
    import_identity
    ;;
  import)
    prepare_dir
    import_identity
    ;;
  *) usage ;;
esac
