#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${ROOT}/RouteCare"
SCHEME="RouteCare"

destination="${DESTINATION:-generic/platform=iOS Simulator}"

echo "Building ${SCHEME} (${destination})…"
xcodebuild \
  -project "${PROJECT_DIR}/RouteCare.xcodeproj" \
  -scheme "${SCHEME}" \
  -configuration "${CONFIGURATION:-Debug}" \
  -destination "${destination}" \
  build
