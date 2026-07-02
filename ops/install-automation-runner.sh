#!/usr/bin/env bash
set -euo pipefail

CONSOLE_ROOT="${1:-/home/ubuntu/codex-cloud/console}"
CLOUD_ROOT="${CODEX_CLOUD_ROOT:-/home/ubuntu/codex-cloud}"
BIN_DIR="$CLOUD_ROOT/bin"
TARGET="$BIN_DIR/run-local-automation"

sudo install -d -m 0755 "$BIN_DIR"
if [[ -f "$TARGET" && ! -f "$TARGET.codex-exec.bak" ]]; then
  sudo cp "$TARGET" "$TARGET.codex-exec.bak"
fi

sudo tee "$TARGET" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
export CODEX_CLOUD_ROOT="${CLOUD_ROOT}"
export CODEX_CLOUD_CONSOLE_URL="\${CODEX_CLOUD_CONSOLE_URL:-http://127.0.0.1:8787}"
exec /usr/bin/env node "${CONSOLE_ROOT}/scripts/run-cloud-automation-via-api.mjs" "\$@"
EOF
sudo chmod 0755 "$TARGET"

echo "Installed app-server automation runner at $TARGET"
