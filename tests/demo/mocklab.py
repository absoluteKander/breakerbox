#!/usr/bin/env python3
"""Fake homelab for screenshots and live tests. Serves made-up Proxmox,
Portainer, Uptime Kuma, Healthchecks, Gatus, Xen Orchestra (HTTP) and TrueNAS (WebSocket
JSON-RPC) responses on 127.0.0.1. Nothing here is real data. Auth is
accepted without checking, except Healthchecks and Xen Orchestra, which
answer 401 unless they get the demo key.

Jellyfin starts crashed. For a demo recording, start with --healthy and send
SIGUSR1 to toggle it: `kill -USR1 <pid>` crashes it, again brings it back."""
import base64, hashlib, json, signal, socketserver, struct, sys
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

JELLYFIN_DOWN = c("jellyfin", "media", "exited", "Exited (137) 4 minutes ago")
JELLYFIN_UP = c("jellyfin", "media")
CONTAINERS = [
    JELLYFIN_DOWN,
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
BEAT_DOWN = [{"status": 0, "time": "2026-11-22 20:00:00", "msg": "502 Bad Gateway"}]
BEAT_UP = KUMA_BEATS["heartbeatList"]["4"]
KUMA_BEATS["uptimeList"]["4_24"] = 0.93


def gatus(name, group, ok=True, errors=None):
    r = {"status": 200 if ok else 502, "hostname": name.lower() + ".home.arpa", "duration": 16476732, "success": ok,
         "conditionResults": [{"condition": "[STATUS] == 200", "success": ok}], "timestamp": "2026-11-22T20:00:01Z"}
    if errors:
        r["errors"] = errors
    return {"name": name, "group": group, "key": group + "_" + name.lower(), "results": [r]}


# /api/v1/endpoints/statuses?pageSize=1: newest result per endpoint.
GATUS = [gatus("Router", "network"), gatus("Pi-hole", "network"), gatus("Jellyfin", "media"),
         gatus("Immich", "media"), gatus("Nextcloud", "cloud")]
GATUS_JELLYFIN_UP = GATUS[2]
GATUS_JELLYFIN_DOWN = gatus("Jellyfin", "media", ok=False)


def xo_vm(name, tags, state="Running"):
    return {"name_label": name, "power_state": state, "tags": tags, "current_operations": {}, "href": "/rest/v0/vms/" + name}


# Xen Orchestra REST (/rest/v0, ?fields= gives objects + href). Token as the
# authenticationToken cookie, like the real thing.
XO_HOSTS = [{"name_label": "xcp-01", "power_state": "Running", "enabled": True, "href": "/rest/v0/hosts/1"},
            {"name_label": "xcp-02", "power_state": "Running", "enabled": True, "href": "/rest/v0/hosts/2"}]
XO_VMS = [xo_vm("jellyfin", ["media"]), xo_vm("immich", ["media"]), xo_vm("pihole", ["network"]),
          xo_vm("wireguard", ["network"]), xo_vm("nextcloud", ["cloud"]), xo_vm("debian-test", [])]
XO_JELLYFIN_UP, XO_JELLYFIN_DOWN = XO_VMS[0], xo_vm("jellyfin", ["media"], "Halted")
XO_COOKIE = "authenticationToken=demo-not-a-real-key"


def set_jellyfin(down):
    CONTAINERS[0] = JELLYFIN_DOWN if down else JELLYFIN_UP
    KUMA_BEATS["heartbeatList"]["4"] = BEAT_DOWN if down else BEAT_UP
    GATUS[2] = GATUS_JELLYFIN_DOWN if down else GATUS_JELLYFIN_UP
    XO_VMS[0] = XO_JELLYFIN_DOWN if down else XO_JELLYFIN_UP


set_jellyfin(True)

TRUENAS = {
    "app.query": [{"name": n, "title": None, "state": "RUNNING"} for n in ("plex-backup", "syncthing", "minio")],
    "pool.query": [{"name": "tank", "healthy": True, "status": "ONLINE", "size": 7.2 * 1024 * GB, "allocated": 4.1 * 1024 * GB},
                   {"name": "fast", "healthy": True, "status": "ONLINE", "size": 0.9 * 1024 * GB, "allocated": 0.31 * 1024 * GB}],
    "alert.list": [],
}

def hc(name, status, tags, ago_h=1):
    return {"name": name, "slug": name.lower().replace(" ", "-"), "tags": tags, "desc": "", "grace": 3600, "n_pings": 40,
            "status": status, "started": False, "last_ping": "2026-11-22T%02d:00:00+00:00" % (20 - ago_h), "next_ping": None,
            "manual_resume": False, "methods": "", "timeout": 86400, "unique_key": hashlib.sha1(name.encode()).hexdigest()}


# What a READ-ONLY key sees: unique_key, no uuid or ping URLs.
HC_CHECKS = {"checks": [hc("Nightly backup", "up", "homelab backups"), hc("Offsite sync", "up", "homelab backups", 3),
                        hc("Cert renewal", "up", "homelab web", 9), hc("ZFS scrub", "paused", "homelab nas", 30)]}
HC_KEY = "demo-not-a-real-key"

ROUTES = {
    "/rest/v0/hosts?fields=name_label,power_state,enabled": XO_HOSTS,
    "/rest/v0/vms?fields=name_label,power_state,tags,current_operations": XO_VMS,
    "/api/v1/endpoints/statuses?pageSize=1": GATUS,
    "/api/v3/checks/?tag=homelab": HC_CHECKS,
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
        body, code = ROUTES.get(self.path), 200
        if self.path.startswith("/api/v3/") and self.headers.get("X-Api-Key") != HC_KEY:
            body, code = {"error": "missing or invalid API key"}, 401   # what Healthchecks answers
        if self.path.startswith("/rest/v0/") and self.headers.get("Cookie") != XO_COOKIE:
            body, code = {"error": "authentication required"}, 401
        if body is None:
            body, code = {"error": "not found"}, 404
        data = json.dumps(body).encode()
        self.send_response(code)
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
    args = [a for a in sys.argv[1:] if a != "--healthy"]
    port = int(args[0]) if args else 8787
    if "--healthy" in sys.argv:
        set_jellyfin(False)
    signal.signal(signal.SIGUSR1, lambda *_: set_jellyfin(CONTAINERS[0] is JELLYFIN_UP))
    S(("127.0.0.1", port), H).serve_forever()
