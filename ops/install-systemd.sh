#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/home/ubuntu/codex-cloud/console}"

cd "$ROOT"
npm install
npm run build

sudo install -m 0644 ops/codex-cloud-console.service /etc/systemd/system/codex-cloud-console.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-cloud-console.service
sudo systemctl status codex-cloud-console.service --no-pager
