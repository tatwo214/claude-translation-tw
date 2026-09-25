#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/staging"
# Do not inherit a future macOS deployment target from the developer environment.
xcrun swiftc -O -target "$(uname -m)-apple-macos13.0" "$ROOT/claude-tw/menubar.swift" -o "$ROOT/staging/ClaudeTW"
otool -l "$ROOT/staging/ClaudeTW" | grep -A4 LC_BUILD_VERSION
