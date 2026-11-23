#!/usr/bin/env python3
"""Fake homelab for screenshots. Serves made-up Proxmox, Portainer, Uptime
Kuma (HTTP) and TrueNAS (WebSocket JSON-RPC) responses on 127.0.0.1.
Nothing here is real data. Auth is accepted without checking."""
import base64, hashlib, json, socketserver, struct, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

GB = 1024 ** 3

PVE_STATUS = {"data": {"cpu": 0.23, "memory": {"used": 21.4 * GB, "total": 31.2 * GB},
                       "rootfs": {"used": 38.2 * GB, "total": 93.9 * GB}, "uptime": 1_123_200}}
PVE_GUESTS = {"data": [
    {"vmid": 100, "name": "docker", "type": "lxc", "status": "running"},
    {"vmid": 101, "name": "pihole", "type": "lxc", "status": "running"},
    {"vmid": 102, "name": "nginx-proxy", "type": "lxc", "status": "running"},
    {"vmid": 200, "name": "home-assistant", "type": "qemu", "status": "running"},
    {"vmid": 201, "name": "truenas", "type": "qemu", "status": "running"},
    {"vmid": 900, "name": "debian-template", "type": "qemu", "status": "stopped", "template": 1},
]}

def c(name, project, state="running", status="Up 3 days"):
    labels = {"com.docker.compose.project": project} if project else {}
    return {"Names": ["/" + name], "State": state, "Status": status, "Labels": labels}

CONTAINERS = [
    c("jellyfin", "media", "exited", "Exited (137) 4 minutes ago"),
    c("sonarr", "media"), c("radarr", "media"), c("prowlarr", "media"), c("qbittorrent", "media"),
    c("immich-server", "immich"), c("immich-ml", "immich"), c("immich-redis", "immich"), c("immich-db", "immich"),
    c("paperless", "paperless"), c("paperless-redis", "paperless"), c("paperless-db", "paperless"),
    c("nextcloud", "nextcloud"), c("nextcloud-db", "nextcloud"),
    c("vaultwarden", "vaultwarden"), c("homepage", "homepage"), c("uptime-kuma", "uptime-kuma"),
    c("portainer", None),
]

KUMA_PAGE = {"config": {}, "incident": None, "maintenanceList": [], "publicGroupList": [
    {"name": "Network", "monitorList": [{"id": 1, "name": "Router"}, {"id": 2, "name": "Pi-hole DNS"}, {"id": 3, "name": "Reverse proxy"}]},
    {"name": "Media", "monitorList": [{"id": 4, "name": "Jellyfin"}, {"id": 5, "name": "Immich"}]},
    {"name": "Cloud", "monitorList": [{"id": 6, "name": "Nextcloud"}, {"id": 7, "name": "Vaultwarden"}]},
    {"name": "Internet", "monitorList": [{"id": 8, "name": "WAN"}]},
]}
KUMA_BEATS = {"heartbeatList": {str(i): [{"status": 1, "time": "2026-11-22 20:00:00", "msg": ""}] for i in range(1, 9)},
              "uptimeList": {"%d_24" % i: 1.0 for i in range(1, 9)}}
KUMA_BEATS["heartbeatList"]["4"] = [{"status": 0, "time": "2026-11-22 20:00:00", "msg": "502 Bad Gateway"}]
KUMA_BEATS["uptimeList"]["4_24"] = 0.93

TRUENAS = {
    "app.query": [{"name": n, "title": None, "state": "RUNNING"} for n in ("plex-backup", "syncthing", "minio")],
    "pool.query": [{"name": "tank", "healthy": True, "status": "ONLINE", "size": 7.2 * 1024 * GB, "allocated": 4.1 * 1024 * GB},
                   {"name": "fast", "healthy": True, "status": "ONLINE", "size": 0.9 * 1024 * GB, "allocated": 0.31 * 1024 * GB}],
    "alert.list": [],
}

ROUTES = {
    "/api2/json/nodes/pve/status": PVE_STATUS,
    "/api2/json/cluster/resources?type=vm": PVE_GUESTS,
    "/api/endpoints/1/docker/containers/json?all=true": CONTAINERS,
    "/api/status-page/homelab": KUMA_PAGE,
    "/api/status-page/heartbeat/homelab": KUMA_BEATS,
}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/current" and self.headers.get("Upgrade", "").lower() == "websocket":
            return self.websocket()
        body = ROUTES.get(self.path)
        data = json.dumps(body if body is not None else {"error": "not found"}).encode()
        self.send_response(200 if body is not None else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # minimal WebSocket server: text frames in, text frames out
    def websocket(self):
        key = self.headers["Sec-WebSocket-Key"]
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        r = self.rfile
        while True:
            hdr = r.read(2)
            if len(hdr) < 2:
                return
            op, n = hdr[0] & 0x0F, hdr[1] & 0x7F
            if n == 126:
                n = struct.unpack("!H", r.read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", r.read(8))[0]
            mask = r.read(4)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(r.read(n)))
            if op == 0x8:
                return
            msg = json.loads(payload)
            m = msg.get("method")
            result = {"response_type": "SUCCESS"} if m == "auth.login_ex" else TRUENAS.get(m, [])
            out = json.dumps({"jsonrpc": "2.0", "id": msg.get("id"), "result": result}).encode()
            ln = len(out)
            frame = struct.pack("!BB", 0x81, ln) if ln < 126 else (
                struct.pack("!BBH", 0x81, 126, ln) if ln < 65536 else struct.pack("!BBQ", 0x81, 127, ln))
            self.wfile.write(frame + out)
            self.wfile.flush()


class S(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    S(("127.0.0.1", port), H).serve_forever()
