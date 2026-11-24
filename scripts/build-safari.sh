#!/usr/bin/env bash
# Builds the Safari version of the extension (macOS app + Safari Web Extension).
# The Xcode project in safari/ references extension/ directly, so there is a
# single source of truth: edit extension/, then rebuild.
#
# Usage: scripts/build-safari.sh            -> Debug build, ad-hoc signed
#        scripts/build-safari.sh --open     -> also launches the app to enable it in Safari
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/safari/Discord Orb Collector/Discord Orb Collector.xcodeproj"
OUT="$ROOT/build/safari"

xcodebuild \
  -project "$PROJECT" \
  -scheme "Discord Orb Collector" \
  -configuration Debug \
  -derivedDataPath "$OUT" \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
  build | grep -E '(^| )error|warning: |BUILD' || true

APP="$OUT/Build/Products/Debug/Discord Orb Collector.app"
[ -d "$APP" ] || { echo "Build failed: $APP not found" >&2; exit 1; }
echo "Built: $APP"

if [ "${1:-}" = "--open" ]; then
  open "$APP"
fi
