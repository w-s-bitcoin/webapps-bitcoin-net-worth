"""Dependency-free Chrome DevTools helpers for isolated fixture checks."""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class CdpSocket:
    """Small, dependency-free Chrome DevTools Protocol websocket client."""

    def __init__(self, url: str):
        parsed = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((parsed.hostname, parsed.port), timeout=15)
        key = base64.b64encode(os.urandom(16)).decode()
        path = parsed.path + (("?" + parsed.query) if parsed.query else "")
        request = (
            f"GET {path} HTTP/1.1\r\nHost: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        response = b""
        while b"\r\n\r\n" not in response:
            response += self.sock.recv(4096)
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise RuntimeError(response.decode(errors="replace"))
        self.next_id = 1
        self.events = []

    def _send(self, payload: str):
        data = payload.encode()
        mask = os.urandom(4)
        size = len(data)
        header = bytearray([0x81])
        if size < 126:
            header.append(0x80 | size)
        elif size < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", size))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", size))
        header.extend(mask)
        header.extend(bytes(value ^ mask[index % 4] for index, value in enumerate(data)))
        self.sock.sendall(header)

    def _recv_exact(self, size: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < size:
            chunks.extend(self.sock.recv(size - len(chunks)))
        return bytes(chunks)

    def _recv(self):
        first, second = self._recv_exact(2)
        opcode = first & 0x0F
        size = second & 0x7F
        if size == 126:
            size = struct.unpack("!H", self._recv_exact(2))[0]
        elif size == 127:
            size = struct.unpack("!Q", self._recv_exact(8))[0]
        masked = bool(second & 0x80)
        mask = self._recv_exact(4) if masked else b""
        data = self._recv_exact(size)
        if masked:
            data = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
        if opcode == 0x9:  # Chrome rarely pings this short-lived connection.
            return self._recv()
        if opcode == 0x8:
            raise EOFError("Chrome closed the DevTools socket")
        return json.loads(data.decode())

    def command(self, method: str, params=None):
        command_id = self.next_id
        self.next_id += 1
        self._send(json.dumps({"id": command_id, "method": method, "params": params or {}}))
        while True:
            message = self._recv()
            if message.get("id") == command_id:
                if "error" in message:
                    raise RuntimeError(message["error"])
                return message.get("result", {})
            self.events.append(message)

    def evaluate(self, expression: str):
        result = self.command(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
        )
        remote = result.get("result", {})
        if remote.get("subtype") == "error":
            raise RuntimeError(remote.get("description") or remote)
        return remote.get("value")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(predicate, *, timeout=35, description="condition"):
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            value = predicate()
        except Exception as error:  # The page may be between execution contexts.
            value = None
            last_error = error
        if value:
            return value
        time.sleep(0.1)
    suffix = f"; last error: {last_error}" if last_error else ""
    raise TimeoutError(f"Timed out waiting for {description}{suffix}")

