#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${1:-/home/ubuntu/codex-cloud/console}"
ENV_FILE="${CODEX_CLOUD_ENV_FILE:-/etc/codex-cloud-console.env}"
RELEASE_ROOT="${CODEX_CLOUD_RELEASE_ROOT:-/home/ubuntu/codex-cloud/releases/console}"
CURRENT_LINK="${CODEX_CLOUD_CURRENT_LINK:-/home/ubuntu/codex-cloud/console-current}"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RELEASE_DIR="${RELEASE_ROOT}/${RELEASE_ID}"
PREVIOUS_TARGET=""
SWITCHED=0

rollback_on_error() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$SWITCHED" == "1" && -n "$PREVIOUS_TARGET" ]]; then
    echo "Deployment failed after release switch; rolling back to $PREVIOUS_TARGET." >&2
    rm -f "${CURRENT_LINK}.rollback"
    ln -s "$PREVIOUS_TARGET" "${CURRENT_LINK}.rollback"
    mv -Tf "${CURRENT_LINK}.rollback" "$CURRENT_LINK"
    sudo systemctl restart codex-cloud-console.service || true
  fi
  exit "$status"
}

trap rollback_on_error EXIT

if [[ ! -f "${SOURCE_ROOT}/package-lock.json" ]]; then
  echo "Source root is not a deployable console checkout: ${SOURCE_ROOT}" >&2
  exit 1
fi

if ! sudo test -f "$ENV_FILE"; then
  sudo install -m 0600 "${SOURCE_ROOT}/ops/codex-cloud-console.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE. Set CODEX_CLOUD_WEBHOOK_TOKEN and CODEX_CLOUD_PUBLIC_ORIGIN, then rerun this installer." >&2
  exit 1
fi

if ! sudo awk -F= '$1 == "CODEX_CLOUD_WEBHOOK_TOKEN" && length($2) >= 16 && $2 !~ /^replace-me/' "$ENV_FILE" | grep -q .; then
  echo "$ENV_FILE must contain a non-placeholder CODEX_CLOUD_WEBHOOK_TOKEN with at least 16 characters." >&2
  exit 1
fi

if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_TARGET="$(readlink -f "$CURRENT_LINK")"
elif [[ -d "$SOURCE_ROOT" ]]; then
  PREVIOUS_TARGET="$(cd "$SOURCE_ROOT" && pwd -P)"
fi

mkdir -p "$RELEASE_DIR"
tar -C "$SOURCE_ROOT" \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=.codex-cloud-state \
  --exclude=.codex-cloud-local \
  -cf - . | tar -C "$RELEASE_DIR" -xf -

(
  cd "$RELEASE_DIR"
  npm ci
  npm run build
  npm run codex:schema:check
  npm run verify:normalizers
)

rm -f "${CURRENT_LINK}.next"
ln -s "$RELEASE_DIR" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"
SWITCHED=1

sudo install -m 0644 "${RELEASE_DIR}/ops/codex-cloud-console.service" /etc/systemd/system/codex-cloud-console.service
sudo systemctl daemon-reload
sudo systemctl enable codex-cloud-console.service
sudo systemctl restart codex-cloud-console.service

healthy=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:8787/api/status >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done

if [[ "$healthy" != "1" ]]; then
  echo "Deployment health check failed." >&2
  sudo systemctl status codex-cloud-console.service --no-pager >&2 || true
  exit 1
fi

sudo systemctl status codex-cloud-console.service --no-pager
SWITCHED=0
trap - EXIT
echo "Deployed release: $RELEASE_DIR"
echo "Previous release retained: ${PREVIOUS_TARGET:-none}"
