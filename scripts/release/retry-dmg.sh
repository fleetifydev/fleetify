#!/usr/bin/env bash
# retry-dmg.sh — run a command that makes a macOS disk image, and run it
# again when it fails on one of hdiutil's passing errors.
#
#   bash scripts/release/retry-dmg.sh <command> [<argument>...]
#
# GitHub's macOS runners sometimes have hdiutil fail with "Resource busy" or
# "couldn't eject" / "couldn't unmount" while tauri bundle makes the disk
# image: another process, such as Spotlight, holds the volume for a moment.
# When the command's output shows one of those, this detaches any Fleetify
# volume the attempt left mounted, removes the bundler's half-made
# read-write images, waits, and runs the command again, three attempts in
# all. Any other failure ends it at once. It exits with the command's status:
# 0 once an attempt succeeds, else the last attempt's.
#
# RETRY_DMG_ATTEMPTS (default 3) and RETRY_DMG_DELAY_S (default 15, times
# the attempt's number) are for the tests.

set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/release/retry-dmg.sh <command> [<argument>...]" >&2
  exit 2
fi

attempts=${RETRY_DMG_ATTEMPTS:-3}
delay=${RETRY_DMG_DELAY_S:-15}
log=$(mktemp)
trap 'rm -f "$log"' EXIT

passing="hdiutil: .*(Resource busy|couldn't eject|couldn't unmount)"

attempt=1
while :; do
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ "$status" -eq 0 ]; then exit 0; fi
  if ! grep -Eq "$passing" "$log"; then exit "$status"; fi
  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error::hdiutil failed in each of $attempts attempts"
    exit "$status"
  fi
  echo "::warning::hdiutil failed (attempt $attempt of $attempts); detaching what it left mounted and trying again"
  if command -v hdiutil > /dev/null 2>&1; then
    hdiutil info 2> /dev/null | awk '$1 ~ /^\/dev\/disk/ && /\/Volumes\/Fleetify/ { print $1 }' | while IFS= read -r device; do
      hdiutil detach "$device" -force || true
    done
  fi
  rm -f target/*/release/bundle/dmg/rw.*.dmg
  sleep $((delay * attempt))
  attempt=$((attempt + 1))
done
