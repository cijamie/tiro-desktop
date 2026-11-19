#!/bin/bash
# Syncs the shared web files into dist/, then bundles with the Tauri CLI.
# ./build.sh        release bundle (the Windows installer)
# ./build.sh dev    debug binary only, faster
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
cp ../desktop.html dist/
cp -R ../theme ../overlay ../onboarding ../panel dist/
../tauri/sidecar/bundle.sh
# Ship a Node.js runtime with the app, for the target being built (--target <triple>, else this machine).
TARGET=""; prev=""; for a in "$@"; do [ "$prev" = "--target" ] && TARGET="$a"; prev="$a"; done
../tauri/sidecar/fetch-node.sh ${TARGET:+"$TARGET"}
# The Windows helpers: voice (Parakeet speech on the PC) and hands (windows, capture, UI Automation, OCR).
# Always optimised: a debug voice build is far too slow at reading speech.
TRIPLE="${TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
case "$TRIPLE" in
  *-windows-*) ;;
  *) echo "Tiro desktop builds for Windows only (got $TRIPLE)" >&2; exit 1 ;;
esac
mkdir -p src-tauri/binaries
for h in voice hands; do
  cargo build --release --locked --manifest-path "src-tauri/$h-win/Cargo.toml" --target "$TRIPLE"
  cp "src-tauri/$h-win/target/$TRIPLE/release/tiro-$h.exe" "src-tauri/binaries/tiro-$h-$TRIPLE.exe"
done
cd src-tauri
# ./build.sh release --target <triple> builds for one target (used by the release workflow).
MODE="${1:-}"; [ $# -gt 0 ] && shift
if [ "$MODE" = "dev" ]; then cargo build; else cargo tauri build ${TAURI_BUNDLES:+--bundles $TAURI_BUNDLES} "$@"; fi
