#!/usr/bin/env bash
set -euo pipefail

LOCAL_PORT="${CODEX_CLOUD_CONSOLE_PORT:-18787}"
LABEL="${CODEX_CLOUD_CONSOLE_AGENT_LABEL:-com.codex.cloud-console-proxy}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.codex"
UID_VALUE="$(id -u)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${CODEX_CLOUD_CONSOLE_NODE:-$(command -v node)}"

mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "node is required but was not found in PATH." >&2
  exit 1
fi

cat > "${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${ROOT}/scripts/local-cloud-console-proxy.mjs</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/cloud-console-local-proxy.out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/cloud-console-local-proxy.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/${UID_VALUE}" "${PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_VALUE}" "${PLIST}"
launchctl kickstart -k "gui/${UID_VALUE}/${LABEL}"

echo "Installed ${LABEL}"
echo "Console URL: http://127.0.0.1:${LOCAL_PORT}/"
