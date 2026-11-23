#!/usr/bin/env python3
"""JSON-RPC 2.0 over WebSocket, for services whose API is WebSocket-only
(TrueNAS 25.04+, where the REST API is removed in 26/27).

Standard library only. Usage:

    python3 -I wsrpc.py wss://host[:port]/path [sha256//PIN]

Reads one JSON object on stdin, so secrets never appear in argv:

    {"login": {"method": "...", "params": [...]} | null,
     "calls": [["method", [params]], ...]}

Writes one JSON object on stdout:

    {"results": [{"result": ...} | {"error": "..."}, ...]}
    {"error": "...", "kind": "cert" | "pin" | "auth" | "net" | "proto"}

Exit code is always 0 when it got as far as printing JSON. Never prints the
request, so a secret can't leak into a log through this script.
"""
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import time
from urllib.parse import urlsplit

DEADLINE_S = 12


class Fail(Exception):
    def __init__(self, kind, msg):
        super().__init__(msg)
        self.kind = kind


# ── TLS pinning ──────────────────────────────────────────────────────────────

def _der_tlv(buf, i):
    """(tag, value_start, value_end) of the DER element starting at i."""
    tag = buf[i]
    n = buf[i + 1]
    j = i + 2
    if n & 0x80:
        k = n & 0x7F
        n = int.from_bytes(buf[j:j + k], "big")
        j += k
    return tag, j, j + n


def spki_pin(cert_der):
    """sha256//base64 of the certificate's SubjectPublicKeyInfo — the same
    value curl's --pinnedpubkey and `breakerbox-secret pin` use."""
    _, c0, _ = _der_tlv(cert_der, 0)          # Certificate
    _, t0, t1 = _der_tlv(cert_der, c0)        # tbsCertificate
    i = t0
    tag, _, end = _der_tlv(cert_der, i)
    if tag == 0xA0:                           # [0] version, optional
        i = end
    for _ in range(5):                        # serial, sigAlg, issuer, validity, subject
        _, _, end = _der_tlv(cert_der, i)
        i = end
    _, _, end = _der_tlv(cert_der, i)         # subjectPublicKeyInfo (whole TLV)
    return "sha256//" + base64.b64encode(hashlib.sha256(cert_der[i:end]).digest()).decode()


# ── WebSocket (RFC 6455, client side, text frames only) ─────────────────────

class WS:
    def __init__(self, url, pins):
        u = urlsplit(url)
        if u.scheme not in ("ws", "wss") or not u.hostname:
            raise Fail("proto", "bad url")
        port = u.port or (443 if u.scheme == "wss" else 80)
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        try:
            raw = socket.create_connection((u.hostname, port), timeout=5)
        except socket.gaierror:
            raise Fail("net", "can't resolve host")
        except ConnectionRefusedError:
            raise Fail("net", "connection refused")
        except (socket.timeout, TimeoutError):
            raise Fail("net", "timed out")
        except OSError as e:
            raise Fail("net", "can't connect: " + (e.strerror or str(e)))
        raw.settimeout(DEADLINE_S)
        if u.scheme == "wss":
            ctx = ssl.create_default_context()
            if pins:
                # The pin replaces CA trust for this one instance, exactly
                # like curl --insecure --pinnedpubkey: chain and name aren't
                # checked, but any key other than the pinned one is refused.
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            try:
                self.sock = ctx.wrap_socket(raw, server_hostname=u.hostname)
            except ssl.SSLCertVerificationError:
                raise Fail("cert", "certificate not trusted — pin it if it's self-signed")
            except (ssl.SSLError, OSError):
                raise Fail("net", "TLS handshake failed")
            if pins:
                got = spki_pin(self.sock.getpeercert(binary_form=True))
                if got not in pins:
                    raise Fail("pin", "certificate pin mismatch — cert changed or wrong pin")
        else:
            self.sock = raw
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        host = u.hostname if not u.port else "%s:%d" % (u.hostname, u.port)
        self.sock.sendall((
            "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, host, key)
        ).encode())
        head = self._read_until(b"\r\n\r\n")
        status = head.split(b"\r\n", 1)[0]
        if b" 101 " not in status + b" ":
            code = status.split(b" ")[1].decode(errors="replace") if len(status.split(b" ")) > 1 else "?"
            raise Fail("auth" if code in ("401", "403") else "proto", "HTTP " + code + " (not a WebSocket API?)")
        want = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        if want.lower() not in head.lower():
            raise Fail("proto", "bad WebSocket handshake")

    def _read(self, n):
        while len(self.buf) < n:
            try:
                chunk = self.sock.recv(65536)
            except (socket.timeout, TimeoutError):
                raise Fail("net", "timed out")
            if not chunk:
                raise Fail("net", "connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _read_until(self, marker):
        while marker not in self.buf:
            if len(self.buf) > 65536:
                raise Fail("proto", "bad WebSocket handshake")
            try:
                chunk = self.sock.recv(4096)
            except (socket.timeout, TimeoutError):
                raise Fail("net", "timed out")
            if not chunk:
                raise Fail("net", "connection closed")
            self.buf += chunk
        head, self.buf = self.buf.split(marker, 1)
        return head

    def send_text(self, text):
        data = text.encode()
        mask = os.urandom(4)
        n = len(data)
        if n < 126:
            hdr = struct.pack("!BB", 0x81, 0x80 | n)
        elif n < 65536:
            hdr = struct.pack("!BBH", 0x81, 0x80 | 126, n)
        else:
            hdr = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
        self.sock.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv_text(self):
        parts = []
        while True:
            b0, b1 = self._read(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            if n > 64 * 1024 * 1024:
                raise Fail("proto", "response too large")
            mask = self._read(4) if b1 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if op == 0x8:
                raise Fail("net", "server closed the connection")
            if op == 0x9:                                   # ping -> pong
                self.sock.sendall(struct.pack("!BB", 0x8A, 0x80) + os.urandom(4))
                continue
            if op in (0x1, 0x0, 0x2):
                parts.append(payload)
                if b0 & 0x80:
                    return b"".join(parts).decode("utf-8", errors="replace")

    def close(self):
        try:
            self.sock.sendall(struct.pack("!BB", 0x88, 0x80) + os.urandom(4))
            self.sock.close()
        except OSError:
            pass


def rpc(ws, ids, method, params):
    ids[0] += 1
    want = ids[0]
    ws.send_text(json.dumps({"jsonrpc": "2.0", "id": want, "method": method, "params": params}))
    while True:
        try:
            msg = json.loads(ws.recv_text())
        except ValueError:
            raise Fail("proto", "response wasn't JSON")
        if isinstance(msg, dict) and msg.get("id") == want:   # skip notifications
            return msg


def err_text(e):
    if isinstance(e, dict):
        data = e.get("data") if isinstance(e.get("data"), dict) else {}
        return str(data.get("reason") or e.get("message") or "error")
    return str(e)


def main():
    if len(sys.argv) < 2:
        raise Fail("proto", "usage: wsrpc.py URL [PIN]")
    pins = sys.argv[2].split(";") if len(sys.argv) > 2 and sys.argv[2] else []
    try:
        req = json.loads(sys.stdin.read())
    except ValueError:
        raise Fail("proto", "bad request")
    started = time.monotonic()
    ws = WS(sys.argv[1], pins)
    ids = [0]
    try:
        login = req.get("login")
        if login:
            r = rpc(ws, ids, login["method"], login.get("params", []))
            if "error" in r or r.get("result") is not True and not (
                    isinstance(r.get("result"), dict) and r["result"].get("response_type") == "SUCCESS"):
                raise Fail("auth", "auth rejected — check the username and key")
        results = []
        for method, params in req.get("calls", []):
            if time.monotonic() - started > DEADLINE_S:
                raise Fail("net", "timed out")
            r = rpc(ws, ids, method, params)
            results.append({"error": err_text(r["error"])} if "error" in r else {"result": r.get("result")})
        print(json.dumps({"results": results}))
    finally:
        ws.close()


if __name__ == "__main__":
    try:
        main()
    except Fail as f:
        print(json.dumps({"error": str(f), "kind": f.kind}))
    except Exception as e:  # never a traceback (could include request data)
        print(json.dumps({"error": "rpc helper failed: " + type(e).__name__, "kind": "proto"}))
