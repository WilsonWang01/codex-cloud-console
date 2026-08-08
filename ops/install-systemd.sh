#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${1:-/home/ubuntu/codex-cloud/console}"
ENV_FILE="${CODEX_CLOUD_ENV_FILE:-/etc/codex-cloud-console.env}"
RELEASE_ROOT="${CODEX_CLOUD_RELEASE_ROOT:-/home/ubuntu/codex-cloud/releases/console}"
CURRENT_LINK="${CODEX_CLOUD_CURRENT_LINK:-/home/ubuntu/codex-cloud/console-current}"
HEALTH_URL="${CODEX_CLOUD_HEALTH_URL:-http://127.0.0.1:8787/healthz}"
HEALTH_ATTEMPTS="${CODEX_CLOUD_HEALTH_ATTEMPTS:-90}"
HEALTH_INTERVAL_SECONDS="${CODEX_CLOUD_HEALTH_INTERVAL_SECONDS:-2}"
KEEP_RELEASES="${CODEX_CLOUD_KEEP_RELEASES:-1}"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RELEASE_DIR="${RELEASE_ROOT}/${RELEASE_ID}"
PREVIOUS_TARGET=""
SWITCHED=0

rollback_on_error() {
  local status=$?
  local active_target=""
  local failed_release_target=""
  trap - EXIT
  if [[ "$status" -ne 0 ]]; then
    if [[ "$SWITCHED" == "1" && -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
      echo "Deployment failed after release switch; rolling back to $PREVIOUS_TARGET." >&2
      rm -f "${CURRENT_LINK}.rollback"
      ln -s "$PREVIOUS_TARGET" "${CURRENT_LINK}.rollback"
      mv -Tf "${CURRENT_LINK}.rollback" "$CURRENT_LINK"
      sudo systemctl restart codex-cloud-console.service || true
    elif [[ "$SWITCHED" == "1" ]]; then
      echo "Deployment failed after the first release switch; removing the failed link." >&2
      rm -f "$CURRENT_LINK"
      sudo systemctl stop codex-cloud-console.service || true
    fi
    active_target="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
    failed_release_target="$(readlink -f "$RELEASE_DIR" 2>/dev/null || true)"
    if [[ -d "$RELEASE_DIR" && ( -z "$active_target" || "$active_target" != "$failed_release_target" ) ]]; then
      rm -rf -- "$RELEASE_DIR"
    fi
  fi
  exit "$status"
}

trap rollback_on_error EXIT

if [[ ! -f "${SOURCE_ROOT}/package-lock.json" ]]; then
  echo "Source root is not a deployable console checkout: ${SOURCE_ROOT}" >&2
  exit 1
fi

if ! [[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "CODEX_CLOUD_HEALTH_ATTEMPTS must be a positive integer." >&2
  exit 1
fi

if ! [[ "$HEALTH_INTERVAL_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "CODEX_CLOUD_HEALTH_INTERVAL_SECONDS must be a non-negative number." >&2
  exit 1
fi

if ! [[ "$KEEP_RELEASES" =~ ^[1-9][0-9]*$ ]]; then
  echo "CODEX_CLOUD_KEEP_RELEASES must be a positive integer." >&2
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

mkdir -p "$RELEASE_ROOT" "$(dirname "$CURRENT_LINK")"

if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  if [[ -z "$PREVIOUS_TARGET" || ! -d "$PREVIOUS_TARGET" ]]; then
    echo "Current release link is dangling: $CURRENT_LINK" >&2
    exit 1
  fi
elif [[ -e "$CURRENT_LINK" ]]; then
  echo "Current release path must be a symbolic link: $CURRENT_LINK" >&2
  exit 1
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
health_payload=""
for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if health_payload="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
    if grep -Eq '"strictOk"[[:space:]]*:[[:space:]]*true' <<<"$health_payload" \
      && grep -Eq '"partial"[[:space:]]*:[[:space:]]*false' <<<"$health_payload"; then
      healthy=1
      break
    fi
  fi
  sleep "$HEALTH_INTERVAL_SECONDS"
done

if [[ "$healthy" != "1" ]]; then
  echo "Deployment strict health check failed: $HEALTH_URL" >&2
  [[ -n "$health_payload" ]] && echo "Last health response: $health_payload" >&2
  sudo systemctl status codex-cloud-console.service --no-pager >&2 || true
  exit 1
fi

sudo systemctl status codex-cloud-console.service --no-pager
SWITCHED=0
trap - EXIT

active_target="$(readlink -f "$CURRENT_LINK")"
retained=1
while IFS= read -r release_path; do
  [[ -z "$release_path" ]] && continue
  release_target="$(readlink -f "$release_path" 2>/dev/null || true)"
  [[ -n "$release_target" && "$release_target" == "$active_target" ]] && continue
  if (( retained < KEEP_RELEASES )); then
    retained=$((retained + 1))
    continue
  fi
  rm -rf -- "$release_path"
done < <(find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d -print | LC_ALL=C sort -r)

echo "Deployed release: $RELEASE_DIR"
echo "Retained releases: $retained"
