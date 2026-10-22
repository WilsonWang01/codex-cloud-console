#!/usr/bin/env python3
"""Standalone stdlib client. Discovery is read-only; submit/heartbeat can incur model costs."""
import argparse
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, origin, token, automation_id, timeout=60):
        url = urllib.parse.urlsplit(origin)
        if (url.username or url.password or url.query or url.fragment or url.path not in ("", "/")
                or not url.hostname or not (url.scheme == "https" or
                (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1")))):
            raise ValueError("Use an HTTPS origin without credentials; loopback HTTP is allowed")
        if not token or not automation_id or not 0 < timeout <= 3600:
            raise ValueError("Token, automation ID and a timeout between 0 and 3600 seconds are required")
        self.base = origin.rstrip("/") + "/api/automations/" + urllib.parse.quote(automation_id, safe="")
        self.token, self.automation_id = token, automation_id
        self.deadline = time.monotonic() + timeout
        self.opener = urllib.request.build_opener(NoRedirect)

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Local deadline expired; query the known run or retry the SAME event ID; no cancellation sent")
        return remaining

    def sleep(self, seconds):
        time.sleep(min(seconds, self.remaining()))
        self.remaining()

    def request(self, suffix, body=None, event_id=None, discovery=False):
        headers = {"Authorization": "Bearer " + self.token} if discovery else {"x-codex-cloud-token": self.token}
        payload = None if body is None else json.dumps(body).encode()
        if body is not None:
            headers["Content-Type"] = "application/json"
        if event_id:
            if not re.fullmatch(r"[A-Za-z0-9._:-]{8,160}", event_id):
                raise ValueError("event ID must be stable across retries and contain 8-160 safe characters")
            headers["Idempotency-Key"] = event_id
        for attempt in range(3):
            delay = min(0.25 * 2 ** attempt, 2)
            try:
                req = urllib.request.Request(self.base + suffix, data=payload, headers=headers)
                with self.opener.open(req, timeout=min(15, self.remaining())) as response:
                    chunks, size = [], 0
                    while True:
                        self.remaining()
                        chunk = response.read1(65536)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > 4 * 1024 * 1024:
                            raise ValueError("Response exceeds the example client's 4 MiB limit")
                        chunks.append(chunk)
                    data = json.loads(b"".join(chunks))
                if not isinstance(data, dict):
                    raise ValueError("Invalid JSON object response")
                return data
            except urllib.error.HTTPError as error:
                if error.code not in (429, 502, 503, 504) or attempt == 2:
                    raise RuntimeError(f"HTTP {error.code}; request rejected, do not change the event ID blindly") from None
                retry = error.headers.get("Retry-After", "")
                if retry.isdigit():
                    delay = int(retry)
            except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ConnectionError):
                self.remaining()
                if attempt == 2:
                    raise RuntimeError("Network outcome unknown; query the known run or retry the SAME event ID") from None
            self.sleep(delay)

    def execute(self, command, value=None, wait=False, prompt=None):
        if command in ("models", "capabilities"):
            data = self.request("/v1/" + command, discovery=True)
            if (command == "models" and (data.get("object") != "list" or not isinstance(data.get("data"), list))
                    or command == "capabilities" and (data.get("object") != "codex_cloud.capabilities"
                    or data.get("automation_id") != self.automation_id)):
                raise ValueError("Invalid discovery response")
            return data
        if not value:
            raise ValueError("A stable event ID (submit/heartbeat) or run ID (status/cancel) is required")
        if command in ("submit", "heartbeat"):
            body = {"runner": "app-server", "worktree": True}
            if prompt is not None:
                body["prompt"] = prompt
            data = self.request("/" + ("webhook" if command == "submit" else "heartbeat"), body, value)
            known_id = None
        else:
            known_id = value
            data = self.request("/runs/" + urllib.parse.quote(value, safe="") + ("/cancel" if command == "cancel" else ""), {} if command == "cancel" else None)
        while True:
            run = data.get("run", {})
            status = run.get("status")
            if (data.get("ok") is not True or not isinstance(run.get("id"), str) or not run["id"]
                    or run.get("automationId") != self.automation_id or (known_id and run["id"] != known_id)
                    or status not in ("queued", "running", "canceling", "completed", "failed", "canceled", "cancelled", "interrupted", "needs_reconciliation")):
                raise ValueError("Invalid or mismatched run response")
            known_id = run["id"]
            print(f"run-id: {known_id}; status: {status}", file=sys.stderr)
            if not wait or command == "cancel" or status not in ("queued", "running", "canceling"):
                return run
            self.sleep(5)
            data = self.request("/runs/" + urllib.parse.quote(known_id, safe=""))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("models", "capabilities", "submit", "heartbeat", "status", "cancel"))
    parser.add_argument("automation_id")
    parser.add_argument("value", nargs="?")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--prompt")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    try:
        client = Client(os.environ.get("CODEX_CLOUD_URL", ""), os.environ.get("CODEX_CLOUD_API_TOKEN", ""), args.automation_id, args.timeout)
        result = client.execute(args.command, args.value, args.wait, args.prompt)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(1 if result.get("status") in ("failed", "canceled", "cancelled", "interrupted", "needs_reconciliation") else 0)
    except (ValueError, RuntimeError, TimeoutError, KeyboardInterrupt) as error:
        print(str(error) or "Local wait interrupted; no cancellation sent", file=sys.stderr)
        sys.exit(1)
