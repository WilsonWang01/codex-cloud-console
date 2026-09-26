#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${1:-/home/ubuntu/codex-cloud/console-current}"
if [[ ! -f "${SOURCE_ROOT}/server/personal-worker.mjs" || ! -f "${SOURCE_ROOT}/server/personal-file-bridge.mjs" || ! -f "${SOURCE_ROOT}/server/personal-files.mjs" ]]; then
  echo "Personal worker source is missing: ${SOURCE_ROOT}" >&2
  exit 1
fi
if ! id ubuntu >/dev/null 2>&1 || ! command -v codex >/dev/null 2>&1; then
  echo "Existing console user or Codex CLI is unavailable" >&2
  exit 1
fi
if ! getent group codex-personal-console >/dev/null; then
  groupadd --system codex-personal-console
fi
if ! getent group codex-personal >/dev/null; then
  groupadd --system codex-personal
fi
if ! id codex-personal >/dev/null 2>&1; then
  useradd --system --gid codex-personal --create-home --home-dir /var/lib/codex-personal --shell /usr/sbin/nologin codex-personal
fi
if [[ "$(stat -c %U /var/lib/codex-personal)" != codex-personal ]]; then
  echo "Refusing to modify a personal home owned by another user" >&2
  exit 1
fi
install -d -m 0700 -o codex-personal -g codex-personal /var/lib/codex-personal /var/lib/codex-personal/.codex /var/lib/codex-personal/workspace
install -d -m 0755 /usr/local/libexec /etc/systemd/system/codex-cloud-console.service.d
install -m 0755 "${SOURCE_ROOT}/server/personal-worker.mjs" /usr/local/libexec/codex-personal-worker.mjs
install -m 0644 "${SOURCE_ROOT}/server/personal-file-bridge.mjs" /usr/local/libexec/personal-file-bridge.mjs
install -m 0644 "${SOURCE_ROOT}/server/personal-files.mjs" /usr/local/libexec/personal-files.mjs
install -m 0755 "${SOURCE_ROOT}/ops/check-personal-isolation.mjs" /usr/local/libexec/codex-personal-isolation-check.mjs
install -m 0644 "${SOURCE_ROOT}/ops/codex-personal-worker.service" /etc/systemd/system/codex-personal-worker.service
install -m 0644 "${SOURCE_ROOT}/ops/codex-cloud-console-personal.conf" /etc/systemd/system/codex-cloud-console.service.d/personal.conf
systemctl daemon-reload
systemctl enable codex-personal-worker.service
systemctl restart codex-personal-worker.service
for _ in $(seq 1 100); do
  if systemctl is-active --quiet codex-personal-worker.service && test -S /run/codex-personal/worker.sock && test -S /run/codex-personal/files.sock; then
    echo "Personal worker installed. The console drop-in takes effect on its next restart."
    exit 0
  fi
  sleep 0.1
done
systemctl status codex-personal-worker.service --no-pager >&2 || true
test -S /run/codex-personal/worker.sock
test -S /run/codex-personal/files.sock
exit 1
