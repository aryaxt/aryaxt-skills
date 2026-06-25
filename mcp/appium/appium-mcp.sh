#!/usr/bin/env bash
# Launcher for the Appium MCP server bundled with the aryaxt-skills plugin.
# Wired into the plugin-root .mcp.json, so every project that enables the plugin
# gets the same mobile-automation MCP (drive the iOS sim / Android emulator:
# navigate, tap, type, read page source, screenshot — to verify a feature on device).
#
# Why a wrapper instead of a bare `npx appium-mcp`:
#   Appium 3 requires Node ^20.19 || ^22.12 || >=24. Machines here often default to
#   an older Node, so we source nvm and select a compatible version first, then exec
#   the globally-installed package (fast + offline). It also resolves ANDROID_HOME.
#
# One-time setup per machine (under Node >= 22):
#   npm install -g appium-mcp@latest
#   # platform drivers ship bundled; if a session reports one missing:
#   #   appium driver install uiautomator2   (Android)
#   #   appium driver install xcuitest        (iOS)
set -uo pipefail

# --- Node: pick an Appium-compatible version via nvm if available ---
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
command -v nvm >/dev/null 2>&1 && {
  nvm use 24 >/dev/null 2>&1 || nvm use 23 >/dev/null 2>&1 || nvm use 22 >/dev/null 2>&1 || true
}

# --- Android SDK: autodetect if the caller didn't export ANDROID_HOME ---
if [ -z "${ANDROID_HOME:-}" ]; then
  for p in "/opt/homebrew/share/android-commandlinetools" \
           "$HOME/Library/Android/sdk" \
           "$HOME/Android/Sdk"; do
    if [ -d "$p" ]; then export ANDROID_HOME="$p"; break; fi
  done
fi

# --- Screenshots dir must exist before the server writes to it ---
mkdir -p "${SCREENSHOTS_DIR:-/tmp/appium-screenshots}" 2>/dev/null || true

# --- Exec the globally-installed server; fall back to npx ---
GLOBAL_ENTRY="$(npm root -g 2>/dev/null)/appium-mcp/dist/index.js"
if [ -f "$GLOBAL_ENTRY" ]; then
  exec node "$GLOBAL_ENTRY"
fi

echo "appium-mcp not installed globally. Run: npm install -g appium-mcp@latest" >&2
exec npx -y appium-mcp@latest
