#!/usr/bin/env bash
set -euo pipefail

LOCAL_PORT="${CODEX_CLOUD_CONSOLE_PORT:-18787}"
URL="http://127.0.0.1:${LOCAL_PORT}/"
LABEL="${CODEX_CLOUD_CONSOLE_AGENT_LABEL:-com.codex.cloud-console-proxy}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

is_listening() {
  lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

if is_listening; then
  echo "Codex Cloud Console local proxy is already listening on ${URL}"
else
  echo "Starting Codex Cloud Console local proxy on ${URL}"
  if [[ -f "${PLIST}" ]]; then
    launchctl bootstrap "gui/$(id -u)" "${PLIST}" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  else
    bash "${ROOT}/scripts/install-cloud-console-agent.sh"
  fi
fi

for _ in {1..20}; do
  if curl -fsS --max-time 2 "${URL}api/status" >/dev/null 2>&1; then
    echo "Codex Cloud Console is ready: ${URL}"
    if command -v open >/dev/null 2>&1; then
      open "${URL}"
    fi
    exit 0
  fi
  sleep 0.5
done

echo "Local proxy started, but the console did not respond at ${URL}api/status." >&2
echo "Check: tail -n 80 ~/.codex/cloud-console-local-proxy.err.log" >&2
exit 1
