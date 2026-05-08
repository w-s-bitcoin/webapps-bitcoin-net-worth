#!/usr/bin/env python3
"""Serve Bitcoin Net Worth Tracker files locally."""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


class Handler(SimpleHTTPRequestHandler):
    heartbeat_touch = None

    def __init__(self, *args, directory: str, **kwargs):
        self._root = Path(directory)
        self._history_dir = self._root / "history_files"
        self._ensure_history_dir()
        super().__init__(*args, directory=directory, **kwargs)

    def _ensure_history_dir(self) -> None:
        self._history_dir.mkdir(parents=True, exist_ok=True)
        # One-way migration: move legacy non-demo history files from root into history_files.
        for path in self._root.iterdir():
            if not path.is_file():
                continue
            if path.suffix not in (".csv", ".enc"):
                continue
            if path.name == "demo_history.csv":
                continue
            destination = self._history_dir / path.name
            if destination.exists():
                path.unlink()
                continue
            path.rename(destination)

    def _history_csv_path(self) -> Path:
        return self._history_dir / "my_history.csv"

    def _history_enc_path(self) -> Path:
        return self._history_dir / "my_history.enc"

    def _safe_history_path(self, filename: str) -> Path | None:
        """Return a validated path for a history file, or None if invalid/disallowed."""
        name = Path(filename).name  # strip any directory components
        if not name.endswith((".csv", ".enc")):
            return None
        if name == "demo_history.csv":
            return None
        return self._history_dir / name

    def _send_text(self, status: int, text: str, content_type: str = "text/plain; charset=utf-8") -> None:
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/heartbeat":
            if callable(self.heartbeat_touch):
                self.heartbeat_touch()
            self._send_text(200, "ok", "text/plain; charset=utf-8")
            return
        if parsed.path == "/api/live-history/files":
            files = sorted(
                p.name for p in self._history_dir.iterdir()
                if p.is_file() and p.suffix in (".csv", ".enc") and p.name != "demo_history.csv"
            )
            self._send_text(200, json.dumps(files), "application/json; charset=utf-8")
            return
        if parsed.path == "/api/live-history":
            qs = parse_qs(parsed.query)
            file_param = qs.get("file", [None])[0]
            if file_param:
                file_path = self._safe_history_path(file_param)
                if file_path is None:
                    self.send_error(400, "Invalid file")
                    return
                encrypted = file_param.endswith(".enc")
            else:
                encrypted = qs.get("encrypted", ["0"])[0] == "1"
                file_path = self._history_enc_path() if encrypted else self._history_csv_path()
            if not file_path.exists():
                self.send_error(404, "Not found")
                return
            content_type = "application/octet-stream" if encrypted else "text/csv; charset=utf-8"
            self._send_text(200, file_path.read_text(encoding="utf-8"), content_type)
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/heartbeat":
            if callable(self.heartbeat_touch):
                self.heartbeat_touch()
            self._send_text(200, "ok", "text/plain; charset=utf-8")
            return
        if parsed.path != "/api/live-history":
            self.send_error(404, "Not found")
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        encrypted = bool(payload.get("encrypted"))
        content = str(payload.get("content", ""))
        file_param = payload.get("file")
        if file_param:
            target_path = self._safe_history_path(str(file_param))
            if target_path is None:
                self.send_error(400, "Invalid file")
                return
            target_path.write_text(content, encoding="utf-8")
            # Delete the other variant of the same base name (csv ↔ enc)
            base = target_path.stem
            other_ext = ".csv" if target_path.suffix == ".enc" else ".enc"
            other = self._history_dir / (base + other_ext)
            if other.exists():
                other.unlink()
        elif encrypted:
            self._history_enc_path().write_text(content, encoding="utf-8")
            # Prevent stale plaintext from being served when encryption is enabled.
            if self._history_csv_path().exists():
                self._history_csv_path().unlink()
        else:
            self._history_csv_path().write_text(content, encoding="utf-8")
            # Prevent stale encrypted file from lingering when encryption is off.
            if self._history_enc_path().exists():
                self._history_enc_path().unlink()

        self._send_text(200, "ok", "text/plain; charset=utf-8")

    def log_message(self, format, *args):  # noqa: A002
        pass  # Suppress request logging for a cleaner terminal


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Bitcoin Net Worth Tracker web server")
    parser.add_argument("--host", default="127.0.0.1", help="Interface to bind")
    parser.add_argument("--port", type=int, default=8081, help="Port to bind")
    parser.add_argument("--root", default=".", help="Directory to serve")
    parser.add_argument(
        "--idle-timeout",
        type=int,
        default=180,
        help="Auto-stop server after this many seconds without dashboard heartbeat (0 disables)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    heartbeat_lock = threading.Lock()
    last_heartbeat = time.monotonic()

    def touch_heartbeat() -> None:
        nonlocal last_heartbeat
        with heartbeat_lock:
            last_heartbeat = time.monotonic()

    def handler_factory(*handler_args, **handler_kwargs):
        return Handler(*handler_args, directory=str(root), **handler_kwargs)

    Handler.heartbeat_touch = touch_heartbeat
    server = ThreadingHTTPServer((args.host, args.port), handler_factory)
    url = f"http://{args.host}:{args.port}/"
    print(f"Bitcoin Net Worth Tracker running at {url}")
    if args.idle_timeout > 0:
        print(f"Auto-stop enabled: shuts down after {args.idle_timeout}s without dashboard heartbeat.")
    print("Press Ctrl+C to stop.")

    def monitor_idle_timeout() -> None:
        while True:
            time.sleep(1)
            if args.idle_timeout <= 0:
                continue
            with heartbeat_lock:
                idle_seconds = time.monotonic() - last_heartbeat
            if idle_seconds >= args.idle_timeout:
                print("No dashboard heartbeat detected; shutting down server.")
                server.shutdown()
                break

    monitor = threading.Thread(target=monitor_idle_timeout, daemon=True)
    monitor.start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
