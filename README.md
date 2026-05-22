# Codex Cloud Console

Browser console for the Codex worker running on EC2. It mirrors the Codex desktop shape: workspace rail, automation runs, repo status, cloud health, and live operation logs.

## Local development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5174`.

## Cloud deployment

Run the app on the EC2 instance that already hosts `/home/ubuntu/codex-cloud`. The API reads:

- `/home/ubuntu/codex-cloud/workspace/*` repositories
- `/home/ubuntu/codex-cloud/logs`
- `systemctl list-timers 'codex-auto-*'`
- `codex login status`

If those paths or commands are unavailable, the console uses a local mock snapshot.

Recommended EC2 install path:

```bash
mkdir -p /home/ubuntu/codex-cloud/console
cd /home/ubuntu/codex-cloud/console
npm install
npm run build
bash ops/install-systemd.sh
```

The systemd service listens on `127.0.0.1:8787` by default. Put Nginx, Caddy, or an SSH tunnel in front of it if you want browser access from outside the instance.
