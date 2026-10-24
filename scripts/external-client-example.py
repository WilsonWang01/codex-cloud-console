#!/usr/bin/env python3
"""Standalone stdlib client. Discovery is read-only; submit/heartbeat can incur model costs."""
import argparse
import base64
import http.client
import hashlib
import json
import os
import re
import stat
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

    def request(self, suffix, body=None, event_id=None, discovery=False, binary=False):
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
                        self.remaining()
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > (8 if binary else 20) * 1024 * 1024:
                            raise ValueError("Response exceeds the delivery size limit")
                        chunks.append(chunk)
                    if binary:
                        return {"buffer": b"".join(chunks), "sha256": response.headers.get("X-Content-SHA256")}
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

    def execute(self, command, value=None, wait=False, prompt=None, file_id=None, input_body=None):
        recovery = {
            "run_id": value if command in ("status", "cancel", "output", "download") else None,
            "event_id": value if command in ("submit", "heartbeat") else None,
        }
        try:
            return self._execute(command, value, wait, prompt, file_id, input_body, recovery)
        except (ValueError, RuntimeError, OSError, http.client.HTTPException, KeyboardInterrupt) as error:
            error.run_id = recovery["run_id"]
            error.event_id = recovery["event_id"]
            raise

    def _execute(self, command, value, wait, prompt, file_id, input_body, recovery):
        if command in ("models", "capabilities"):
            data = self.request("/v1/" + command, discovery=True)
            if (command == "models" and (data.get("object") != "list" or not isinstance(data.get("data"), list))
                    or command == "capabilities" and (data.get("object") != "codex_cloud.capabilities"
                    or data.get("automation_id") != self.automation_id)):
                raise ValueError("Invalid discovery response")
            return data
        if command in ("output", "download"):
            if not value:
                raise ValueError("run ID is required")
            prefix = "/runs/" + urllib.parse.quote(value, safe="") + "/output"
            data = self.request(prefix)
            result = data.get("result", {})
            if (data.get("ok") is not True or result.get("version") != 1 or result.get("runId") != value
                    or result.get("automationId") != self.automation_id or result.get("status") != "completed"
                    or not isinstance(result.get("text"), str) or not isinstance(result.get("artifacts"), list)
                    or len(result["artifacts"]) > 8):
                raise ValueError("Invalid result manifest")
            if command == "output":
                return result
            if not isinstance(file_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", file_id):
                raise ValueError("Valid artifact file ID is required")
            artifact = next((item for item in result["artifacts"] if item.get("id") == file_id), None)
            if (not artifact or type(artifact.get("size")) is not int or not 0 <= artifact["size"] <= 8 * 1024 * 1024
                    or not isinstance(artifact.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", artifact["sha256"])):
                raise ValueError("Artifact integrity metadata is invalid")
            # Ignore server-provided download URLs; build an authenticated same-origin path.
            downloaded = self.request(prefix + "/files/" + urllib.parse.quote(file_id, safe=""), binary=True)
            digest = hashlib.sha256(downloaded["buffer"]).hexdigest()
            if digest != artifact["sha256"] or downloaded["sha256"] != digest or len(downloaded["buffer"]) != artifact["size"]:
                raise ValueError("Artifact integrity check failed")
            return {"artifact": artifact, "buffer": downloaded["buffer"]}
        if not value:
            raise ValueError("A stable event ID (submit/heartbeat) or run ID (status/cancel) is required")
        if command in ("submit", "heartbeat"):
            body = {"runner": "app-server", "worktree": True}
            if input_body is not None:
                if not isinstance(input_body, dict):
                    raise ValueError("input must be a JSON object")
                body.update(input_body)
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
            recovery["run_id"] = known_id
            print(f"run-id: {known_id}; status: {status}", file=sys.stderr)
            if not wait or command == "cancel" or status not in ("queued", "running", "canceling"):
                return run
            self.sleep(5)
            data = self.request("/runs/" + urllib.parse.quote(known_id, safe=""))


def read_input_file(filename, limit):
    descriptor = os.open(filename, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise ValueError("Input must be a regular file within the documented size limit")
        data = source.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Input exceeds the documented size limit")
        return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("models", "capabilities", "submit", "heartbeat", "status", "cancel", "output", "download"))
    parser.add_argument("automation_id")
    parser.add_argument("value", nargs="?")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--prompt")
    parser.add_argument("--input")
    parser.add_argument("--attach", action="append", default=[])
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--file-id")
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        if (args.input or args.attach or args.prompt is not None) and args.command not in ("submit", "heartbeat"):
            raise ValueError("Input options are only for submit or heartbeat")
        body = json.loads(read_input_file(args.input, 12 * 1024 * 1024).decode("utf-8")) if args.input else {}
        if not isinstance(body, dict):
            raise ValueError("--input must contain a JSON object")
        mimes = {".txt": "text/plain", ".md": "text/markdown", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
        if args.attach:
            if "attachments" not in body:
                body["attachments"] = []
            if not isinstance(body["attachments"], list) or len(body["attachments"]) + len(args.attach) > 8:
                raise ValueError("At most eight attachments are allowed")
            for filename in args.attach:
                mime = mimes.get(os.path.splitext(filename)[1].lower())
                if not mime:
                    raise ValueError("Attachments must be txt/md/pdf/png/jpeg/webp files")
                data = read_input_file(filename, 4 * 1024 * 1024 if mime.startswith("image/") or mime == "application/pdf" else 64 * 1024)
                body["attachments"].append({"name": os.path.basename(filename), "mimeType": mime, "dataBase64": base64.b64encode(data).decode("ascii")})
        client = Client(os.environ.get("CODEX_CLOUD_URL", ""), os.environ.get("CODEX_CLOUD_API_TOKEN", ""), args.automation_id, args.timeout)
        if args.command == "download" and not args.output:
            raise ValueError("download requires --output; existing files are never overwritten")
        result = client.execute(args.command, args.value, args.wait, args.prompt, args.file_id, body)
        if args.command == "download":
            with open(args.output, "xb") as destination:
                destination.write(result.pop("buffer"))
            result["destination"] = args.output
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(1 if result.get("status") in ("failed", "canceled", "cancelled", "interrupted", "needs_reconciliation") else 0)
    except (ValueError, RuntimeError, TimeoutError, KeyboardInterrupt, OSError) as error:
        message = str(error) or "Local wait interrupted; no cancellation sent"
        if getattr(error, "run_id", None):
            message += f" (run-id: {error.run_id})"
        if getattr(error, "event_id", None):
            message += f" (event-id: {error.event_id})"
        print(message, file=sys.stderr)
        sys.exit(1)
