// node tests/run.js — pure tests of core logic and adapters, no network.
const assert = require("assert"), path = require("path")
const load = require("./load")
const root = path.join(__dirname, "..")
const Core = load(path.join(root, "core/Core.js"))
const A = load(path.join(root, "adapters/index.js")).all

let passed = 0, failed = 0
function test(name, fn) {
    try { fn(); passed++ } catch (e) { failed++; console.log("FAIL " + name + "\n  " + e.message) }
}
const S = Core.STATUS
// values from the vm context have foreign prototypes; compare by value
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b))

// fake ctx: map of path -> data | Error-string
// rpc routes are keyed "rpc:<method>"; "rpc" itself = session-level error
function ctxFor(inst, routes, previous) {
    const look = k => {
        const r = routes[k]
        if (r === undefined) return { error: "HTTP 404", data: null }
        if (typeof r === "string") return { error: r, data: null }
        return { error: null, data: r }
    }
    return {
        inst, previous: previous || null,
        get(p, cb) { const r = look(p); cb(r.error, r.data) },
        rpc(calls, cb) {
            if (typeof routes.rpc === "string") return cb(routes.rpc, null)
            cb(null, calls.map(([m]) => look("rpc:" + m)))
        },
    }
}
function poll(type, inst, routes, previous) {
    let out
    A[type].poll(ctxFor(inst, routes, previous), (err, snap) => { out = { err, snap } })
    assert(out, "adapter never called done synchronously with sync fake ctx")
    return out
}

// ── status + debounce ────────────────────────────────────────────────────────
test("worst wins, loading lowest", () => {
    assert.strictEqual(Core.worst(["ok", "loading", "warn"]), "warn")
    assert.strictEqual(Core.worst([]), "loading")
    assert.strictEqual(Core.worst(["ok", "error", "warn"]), "error")
})

test("stats never move status; alerts and members do", () => {
    const snap = { summary: [{ label: "CPU", tone: "error" }], alerts: [], groups: [{ name: "g", members: [{ status: "ok" }] }] }
    assert.strictEqual(Core.snapshotStatus(snap), "ok")
    snap.alerts.push({ status: "warn", text: "x" })
    assert.strictEqual(Core.snapshotStatus(snap), "warn")
    assert.strictEqual(Core.snapshotStatus({ summary: [], alerts: [], groups: [] }), "ok")
})

test("debounce: one failure keeps status + snapshot, second flips to error", () => {
    let e = Core.newEntry({ name: "a", type: "proxmox" })
    const snap = { groups: [{ name: "g", members: [{ status: "ok" }] }] }
    e = Core.applySuccess(e, snap, 1000)
    assert.strictEqual(e.status, "ok")
    e = Core.applyFailure(e, "timed out", 2, 2000)
    assert.strictEqual(e.status, "ok"); assert.strictEqual(e.failCount, 1)
    assert.strictEqual(e.snapshot, snap); assert(e.stale); assert(Core.isRetrying(e))
    e = Core.applyFailure(e, "timed out", 2, 3000)
    assert.strictEqual(e.status, "error"); assert.strictEqual(e.snapshot, snap); assert(!Core.isRetrying(e))
    assert.strictEqual(e.lastOk, 1000)
    e = Core.applySuccess(e, snap, 4000)
    assert.strictEqual(e.status, "ok"); assert.strictEqual(e.failCount, 0); assert(!e.stale)
})

test("debounce: never-reached instance stays loading until threshold", () => {
    let e = Core.newEntry({ name: "a", type: "x" })
    e = Core.applyFailure(e, "refused", 3, 1)
    assert.strictEqual(e.status, "loading")
    e = Core.applyFailure(e, "refused", 3, 2)
    e = Core.applyFailure(e, "refused", 3, 3)
    assert.strictEqual(e.status, "error")
})

test("threshold 1 means immediate", () => {
    const e = Core.applyFailure(Core.newEntry({ name: "a" }), "x", 1, 1)
    assert.strictEqual(e.status, "error")
})

test("entries are copied, never mutated", () => {
    const a = Core.newEntry({ name: "a" })
    const b = Core.applyFailure(a, "x", 2, 1)
    assert.notStrictEqual(a, b); assert.strictEqual(a.failCount, 0)
})

// ── config ───────────────────────────────────────────────────────────────────
const good = {
    failThreshold: 2,
    instances: [
        { type: "proxmox", name: "pve", url: "https://pve.lan:8006/", tokenId: "u@pam!t", node: "pve", secret: "keyring:pve" },
        { type: "portainer", name: "docker", url: "https://p.lan", endpointId: 3, secret: "pass:homelab/portainer" },
        { type: "truenas", name: "nas", url: "https://nas.lan", username: "admin", secret: "keyring:nas", pin: "sha256//" + "A".repeat(43) + "=", interval: 120 },
    ],
}
test("valid config loads in order with defaults", () => {
    const c = Core.parseConfig(JSON.stringify(good), A)
    same(c.errors, [])
    same(c.instances.map(i => i.name), ["pve", "docker", "nas"])
    assert.strictEqual(c.instances[0].url, "https://pve.lan:8006")   // trailing slash stripped
    assert.strictEqual(c.instances[0].interval, 30)
    assert.strictEqual(c.instances[2].interval, 120)
})

function oneBad(patch) {
    const cfg = JSON.parse(JSON.stringify(good))
    Object.assign(cfg.instances[0], patch)
    const c = Core.parseConfig(JSON.stringify(cfg), A)
    return c
}
test("plaintext secret is refused, rest still load", () => {
    const c = oneBad({ secret: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" })
    assert.strictEqual(c.instances.length, 2)
    assert(/never the secret itself/.test(c.errors[0]))
    assert(!c.errors[0].includes("a1b2c3d4"), "error message must not echo the secret")
})
test("missing secret refused", () => assert.strictEqual(oneBad({ secret: undefined }).instances.length, 2))
test("unknown type refused", () => assert(/unknown type/.test(oneBad({ type: "nope" }).errors[0])))
test("bad pin refused", () => assert(/pin/.test(oneBad({ pin: "deadbeef" }).errors[0])))
test("pin on http refused", () => assert(/pin/.test(oneBad({ url: "http://pve.lan", pin: "sha256//" + "A".repeat(43) + "=" }).errors[0])))
test("two pins allowed", () => assert.strictEqual(oneBad({ pin: "sha256//" + "A".repeat(43) + "=;sha256//" + "B".repeat(43) + "=" }).errors.length, 0))
test("interval floor", () => assert(/interval/.test(oneBad({ interval: 2 }).errors[0])))
test("missing required field", () => assert(/node/.test(oneBad({ node: "" }).errors[0])))
test("wrong field type", () => {
    const cfg = JSON.parse(JSON.stringify(good)); cfg.instances[1].endpointId = "3"
    assert(/endpointId/.test(Core.parseConfig(JSON.stringify(cfg), A).errors[0]))
})
test("duplicate name", () => {
    const cfg = JSON.parse(JSON.stringify(good)); cfg.instances[1].name = "pve"
    assert(/duplicate/.test(Core.parseConfig(JSON.stringify(cfg), A).errors[0]))
})
test("bad url", () => assert(/url/.test(oneBad({ url: "pve.lan" }).errors[0])))
test("bad json", () => assert(/JSON/.test(Core.parseConfig("{", A).errors[0])))
test("bad threshold", () => assert(/failThreshold/.test(Core.parseConfig('{"failThreshold":0,"instances":[]}', A).errors[0])))

// ── request building ─────────────────────────────────────────────────────────
test("headers render; secret never in argv", () => {
    const inst = { tokenId: "u@pam!t" }
    const h = Core.renderHeaders(A.proxmox.headers, inst, "SEKRIT")
    same(h, ["Authorization: PVEAPIToken=u@pam!t=SEKRIT"])
    const args = Core.curlArgs("https://x/y", { hasHeaders: true })
    assert(!args.join(" ").includes("SEKRIT"))
    assert(args.includes("@-")); assert(!args.includes("-L")); assert(!args.includes("--insecure"))
    assert.strictEqual(args[args.length - 2], "--")   // url can't be read as an option
})
test("newline in a header value is refused (header injection)", () => {
    assert.strictEqual(Core.renderHeaders(A.proxmox.headers, { tokenId: "a\nX-Evil: 1" }, "s"), null)
    assert.strictEqual(Core.renderHeaders(A.portainer.headers, {}, "s\r\nX: y"), null)
})
test("--insecure only ever appears together with a pin", () => {
    const pin = "sha256//" + "A".repeat(43) + "="
    const args = Core.curlArgs("https://x", { pin })
    const i = args.indexOf("--insecure")
    assert(i >= 0 && args[i + 1] === "--pinnedpubkey" && args[i + 2] === pin)
    assert(!Core.curlArgs("https://x", {}).includes("--insecure"))
})
test("curl result parsing", () => {
    same(Core.parseCurlResult(0, '{"a":1}\n200').data, { a: 1 })
    assert.strictEqual(Core.parseCurlResult(0, "nope\n500").error, "HTTP 500")
    const auth = Core.parseCurlResult(0, "\n401"); assert(auth.auth); assert(/auth rejected/.test(auth.error))
    assert(/pin mismatch/.test(Core.parseCurlResult(90, "").error))
    assert(/timed out/.test(Core.parseCurlResult(28, "").error))
    assert(/wasn't JSON/.test(Core.parseCurlResult(0, "<html>\n200").error))
})
test("secret refs", () => {
    same(Core.parseSecretRef("pass:homelab/pve-1"), { kind: "pass", path: "homelab/pve-1" })
    assert.strictEqual(Core.parseSecretRef("keyring:a b"), null)
    assert.strictEqual(Core.parseSecretRef("keyring:$(rm -rf ~)"), null)
    assert.strictEqual(Core.parseSecretRef("env:X"), null)
})

// ── adapters ─────────────────────────────────────────────────────────────────
const pveInst = { node: "pve", tokenId: "t" }
const pveStatus = { data: { cpu: 0.05, memory: { used: 4e9, total: 16e9 }, rootfs: { used: 1e10, total: 1e11 }, uptime: 90061 } }
const pveRes = { data: [
    { vmid: 100, name: "docker", type: "lxc", status: "running" },
    { vmid: 101, name: "web", type: "qemu", status: "running", pool: "prod" },
    { vmid: 102, name: "db", type: "qemu", status: "stopped", pool: "prod" },
    { vmid: 103, name: "tpl", type: "qemu", status: "stopped", template: 1 },
    { vmid: 104, name: "bk", type: "lxc", status: "running", lock: "backup" },
] }
const pvePaths = { status: "/api2/json/nodes/pve/status", res: "/api2/json/cluster/resources?type=vm" }

test("proxmox: pools first, templates skipped, lock = warn", () => {
    const { err, snap } = poll("proxmox", pveInst, { [pvePaths.status]: pveStatus, [pvePaths.res]: pveRes })
    assert.strictEqual(err, null)
    same(snap.groups.map(g => g.name), ["prod", "LXC"])
    assert.strictEqual(snap.groups[0].members.find(m => m.name === "db").status, S.ERROR)
    assert.strictEqual(snap.groups[1].members.find(m => m.name === "bk").status, S.WARN)
    assert(!JSON.stringify(snap).includes("tpl"))
    assert.strictEqual(Core.snapshotStatus(snap), S.ERROR)
    assert.strictEqual(snap.summary[0].value, "5%")
    assert.strictEqual(snap.summary[3].value, "1d 1h")
})
test("proxmox: node status failing fails the poll", () => {
    assert.strictEqual(poll("proxmox", pveInst, { [pvePaths.res]: pveRes }).err, "HTTP 404")
})
test("proxmox: guest list failing keeps previous groups", () => {
    const prev = { groups: [{ name: "old", members: [] }] }
    const { snap } = poll("proxmox", pveInst, { [pvePaths.status]: pveStatus, [pvePaths.res]: "timed out" }, prev)
    assert.strictEqual(snap.groups, prev.groups)
})

const ptPath = "/api/endpoints/3/docker/containers/json?all=true"
test("portainer: compose grouping, standalone last, unhealthy = warn", () => {
    const { snap } = poll("portainer", { endpointId: 3 }, { [ptPath]: [
        { Names: ["/b"], State: "running", Status: "Up 2 days (unhealthy)", Labels: { "com.docker.compose.project": "zeta" } },
        { Names: ["/a"], State: "running", Status: "Up", Labels: { "com.docker.compose.project": "alpha" } },
        { Names: ["/solo"], State: "exited", Status: "Exited (1)", Labels: {} },
    ] })
    same(snap.groups.map(g => g.name), ["alpha", "zeta", "Standalone"])
    assert.strictEqual(snap.groups[1].members[0].status, S.WARN)
    assert.strictEqual(snap.groups[2].members[0].status, S.ERROR)
    assert.strictEqual(snap.summary[0].value, "2 / 3")
    assert.strictEqual(snap.summary[1].value, "2")
})
test("portainer: non-array response is an error", () => {
    assert(poll("portainer", { endpointId: 3 }, { [ptPath]: { message: "x" } }).err)
})

const tn = { app: "rpc:app.query", pool: "rpc:pool.query", alert: "rpc:alert.list" }
const tnApps = [{ name: "b", state: "RUNNING" }, { name: "a", title: "Alpha", state: "CRASHED" }]
test("truenas: app state trusted, INFO alerts ignored, bad pool = error alert", () => {
    const { snap } = poll("truenas", {}, {
        [tn.app]: tnApps,
        [tn.pool]: [{ name: "tank", healthy: false, status: "DEGRADED", size: 100, allocated: 50 }],
        [tn.alert]: [
            { level: "INFO", formatted: "update available", dismissed: false },
            { level: "WARNING", formatted: "smart", dismissed: false },
            { level: "CRITICAL", formatted: "gone", dismissed: true },
        ],
    })
    same(snap.groups.map(g => g.name), ["Alpha", "b"])
    assert.strictEqual(snap.groups[0].members[0].status, S.ERROR)
    assert.strictEqual(snap.groups[0].members[0].name, "Alpha")   // same name -> GroupList shows just the reason
    same(snap.alerts.map(a => a.text), ["Pool tank is DEGRADED", "smart"])
    assert.strictEqual(snap.summary[0].tone, S.ERROR)
})
test("truenas: pool/alert endpoints failing keep previous", () => {
    const prev = { summary: [{ label: "tank" }], alerts: [{ status: "error", text: "Pool tank is DEGRADED" }, { status: "warn", text: "smart" }] }
    const { snap } = poll("truenas", {}, { [tn.app]: tnApps, [tn.pool]: "timed out", [tn.alert]: "timed out" }, prev)
    assert.strictEqual(snap.summary, prev.summary)
    same(snap.alerts.map(a => a.text), ["Pool tank is DEGRADED", "smart"])
})
test("truenas: all INFO = ok overall", () => {
    const { snap } = poll("truenas", {}, { [tn.app]: [{ name: "a", state: "RUNNING" }], [tn.pool]: [], [tn.alert]: [{ level: "INFO", formatted: "x" }] })
    assert.strictEqual(Core.snapshotStatus(snap), S.OK)
})

// ── every adapter honours the contract ───────────────────────────────────────
test("adapter contract", () => {
    for (const id in A) {
        const a = A[id]
        assert.strictEqual(a.id, id)
        assert(a.label && typeof a.poll === "function" && a.defaultInterval >= 10, id)
        assert(Array.isArray(a.headers), id)
        if (a.secret) assert(a.headers.some(h => h.includes("{secret}")) || JSON.stringify(a.rpcLogin || "").includes("{secret}"), id + " declares a secret but never sends it")
    }
})


// ── setup-UI helpers ─────────────────────────────────────────────────────────
test("formToRaw converts numbers, drops empty optionals", () => {
    const raw = Core.formToRaw(A.portainer, "portainer", { name: " docker ", url: "https://p.lan", endpointId: "3", interval: "" })
    same(raw, { type: "portainer", name: "docker", url: "https://p.lan", endpointId: 3 })
    assert.strictEqual(Core.formToRaw(A.portainer, "portainer", { name: "d", url: "u", endpointId: "x3" }).endpointId, "x3")  // left for validation to reject
})
test("form round-trip", () => {
    const raw = good.instances[0]
    const back = Core.formToRaw(A.proxmox, "proxmox", Core.rawToForm(A.proxmox, raw))
    same(back, { type: "proxmox", name: "pve", url: "https://pve.lan:8006/", tokenId: "u@pam!t", node: "pve", secret: "keyring:pve" })
})
test("fresh secret refs never collide", () => {
    assert.strictEqual(Core.freshSecretRef(good, "PVE"), "keyring:pve-2")
    assert.strictEqual(Core.freshSecretRef(good, "My NAS!"), "keyring:my-nas")
    assert.strictEqual(Core.freshSecretRef({ instances: [] }, "!!!"), "keyring:instance")
})
test("upsert replaces by name, appends new, keeps unknown top-level keys", () => {
    const cfg = Object.assign({ custom: 1 }, good)
    const a = Core.upsertInstance(cfg, { type: "truenas", name: "nas2" }, "")
    assert.strictEqual(a.instances.length, 4); assert.strictEqual(a.custom, 1); assert.strictEqual(cfg.instances.length, 3)
    const b = Core.upsertInstance(cfg, { type: "truenas", name: "renamed" }, "nas")
    same(b.instances.map(i => i.name), ["pve", "docker", "renamed"])
    same(Core.removeInstance(cfg, "docker").instances.map(i => i.name), ["pve", "nas"])
})
test("validateCandidate: field errors without the name prefix, and duplicates", () => {
    const errs = Core.validateCandidate(good, { type: "proxmox", name: "docker", url: "https://x", secret: "keyring:x", tokenId: "t", node: "" }, "", A)
    assert(errs.some(e => /^missing "node"/.test(e)), errs.join("|"))
    assert(Core.validateCandidate(good, { type: "truenas", name: "pve", url: "https://x", username: "u", secret: "keyring:x" }, "", A).some(e => /already called/.test(e)))
    same(Core.validateCandidate(good, { type: "truenas", name: "nas", url: "https://x", username: "u", secret: "keyring:nas" }, "nas", A), [])
})
test("hostPort", () => {
    same(Core.hostPort("https://pve.lan:8006/x"), { host: "pve.lan", port: 8006 })
    same(Core.hostPort("https://nas.lan"), { host: "nas.lan", port: 443 })
    assert.strictEqual(Core.hostPort("http://nas.lan"), null)
    assert.strictEqual(Core.hostPort("https://a;rm -rf/"), null)
})
test("cert exits flagged", () => {
    assert.strictEqual(Core.parseCurlResult(60, "").exit, 60); assert(Core.CERT_EXITS[90]); assert(!Core.CERT_EXITS[28])
})
test("adapters describe their form", () => {
    for (const id in A) {
        assert(A[id].urlExample, id)
        if (A[id].secret) assert(A[id].secretLabel && A[id].secretHint, id)
        for (const f in A[id].fields) assert(A[id].fields[f].label, id + "." + f)
    }
})

// ── size limits ──────────────────────────────────────────────────────────────
test("4th instance of a type is skipped with a pointer elsewhere", () => {
    const inst = n => ({ type: "truenas", name: "nas" + n, url: "https://n" + n, username: "u", secret: "keyring:n" + n })
    const c = Core.parseConfig(JSON.stringify({ instances: [1, 2, 3, 4].map(inst) }), A)
    assert.strictEqual(c.instances.length, 3)
    assert(/nas4.*skipped.*limit is 3.*Homarr/.test(c.errors[0]), c.errors[0])
    assert(!Core.canAdd({ instances: [1, 2, 3].map(inst) }, "truenas", A))
    assert(Core.canAdd({ instances: [1, 2].map(inst) }, "truenas", A))
})
test("only one Uptime Kuma", () => {
    const k = n => ({ type: "uptimekuma", name: "k" + n, url: "https://k" + n, slug: "home" })
    assert.strictEqual(Core.parseConfig(JSON.stringify({ instances: [k(1), k(2)] }), A).instances.length, 1)
    assert(Core.validateCandidate({ instances: [k(1)] }, k(2), "", A).some(e => /limit is 1 Uptime Kuma/.test(e)))
    same(Core.validateCandidate({ instances: [k(1)] }, k(1), "k1", A), [])   // editing it is fine
})
test("row limit keeps problems visible", () => {
    const g = (n, st) => ({ name: "g" + n, members: [{ name: "m", status: st }] })
    const groups = Array.from({ length: 20 }, (_, i) => g(i, i === 17 ? "error" : i === 19 ? "warn" : "ok"))
    const v = Core.visibleGroups(groups)
    assert.strictEqual(v.rows.length, Core.MAX_ROWS); assert.strictEqual(v.hidden, 20 - Core.MAX_ROWS)
    same(v.rows.slice(0, 2).map(x => x.name), ["g17", "g19"])
    const few = groups.slice(0, 5)
    assert.strictEqual(Core.visibleGroups(few).rows, few)
})
test("paused never colours anything", () => {
    assert.strictEqual(Core.snapshotStatus({ groups: [{ name: "g", members: [{ status: "paused" }] }] }), "ok")
    assert.strictEqual(Core.worst(["paused", "ok"]), "ok")
})

// ── uptime kuma ──────────────────────────────────────────────────────────────
const kInst = { slug: "home", url: "https://k" }
const kPage = { publicGroupList: [
    { name: "Core", monitorList: [{ id: 1, name: "Kuma" }, { id: 2, name: "Site" }] },
    { name: "Media", monitorList: [{ id: 3, name: "Jellyfin" }, { id: 4, name: "Wiki" }, { id: 5, name: "New" }] },
    { name: "Empty", monitorList: [] },
] }
const kBeats = {
    heartbeatList: {
        1: [{ status: 0, time: "2026-01-01 00:00:00", msg: "old" }, { status: 1, time: "2026-01-01 00:01:00", msg: "" }],
        2: [{ status: 3, time: "2026-01-01 00:01:00", msg: "" }],
        3: [{ status: 0, time: "2026-01-01 00:01:00", msg: "connect ECONNREFUSED 10.0.0.5:8096" }],
        4: [{ status: 2, time: "2026-01-01 00:01:00", msg: "" }],
    },
    uptimeList: { "1_24": 1, "2_24": 1, "3_24": 0.9, "4_24": 0.99 },
}
const kPaths = { page: "/api/status-page/home", hb: "/api/status-page/heartbeat/home" }
test("kuma: groups, latest beat wins, statuses mapped, empty groups dropped", () => {
    const { err, snap } = poll("uptimekuma", kInst, { [kPaths.page]: kPage, [kPaths.hb]: kBeats })
    assert.strictEqual(err, null)
    same(snap.groups.map(g => g.name), ["Core", "Media"])
    same(snap.groups[0].members.map(m => m.status), ["ok", "paused"])
    same(snap.groups[1].members.map(m => [m.status, m.detail]), [["error", "connect ECONNREFUSED 10.0.0.5:8096"], ["warn", "retrying"], ["loading", "no checks yet"]])
    assert.strictEqual(Core.groupStatus(snap.groups[0]), "ok")   // maintenance doesn't colour Core
    assert.strictEqual(snap.summary[0].value, "97.2%")
})
test("kuma: unknown page reads as a naming problem", () => {
    const { err } = poll("uptimekuma", kInst, { [kPaths.page]: "timed out", [kPaths.hb]: { heartbeatList: {}, uptimeList: {} } })
    assert(/no status page "home"/.test(err), err)
})
test("kuma: heartbeat failure keeps previous groups", () => {
    const prev = { groups: [{ name: "x", members: [] }], summary: [{ label: "24h uptime", value: "1%" }] }
    const { snap } = poll("uptimekuma", kInst, { [kPaths.page]: kPage, [kPaths.hb]: "timed out" }, prev)
    assert.strictEqual(snap.groups, prev.groups); assert.strictEqual(snap.summary, prev.summary)
})
test("kuma: incident becomes an alert; no secret allowed", () => {
    const { snap } = poll("uptimekuma", kInst, { [kPaths.page]: Object.assign({ incident: { title: "Power cut" } }, kPage), [kPaths.hb]: kBeats })
    same(snap.alerts, [{ status: "warn", text: "Incident: Power cut" }])
    const c = Core.parseConfig(JSON.stringify({ instances: [{ type: "uptimekuma", name: "k", url: "https://k", slug: "s", secret: "keyring:k" }] }), A)
    assert(/does not use a secret/.test(c.errors[0]))
    assert.strictEqual(A.uptimekuma.openUrl({ url: "https://k", slug: "my page" }), "https://k/status/my%20page")
})

test("panel opens on the worst problem: red beats amber, tab order breaks ties", () => {
    const services = [
        { type: "proxmox", instances: [{ name: "pve" }] },
        { type: "portainer", instances: [{ name: "d1" }, { name: "d2" }] },
        { type: "truenas", instances: [{ name: "nas" }] },
    ]
    const st = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { status: v }]))
    same(Core.worstInstance(services, st({ pve: "warn", d1: "ok", d2: "error", nas: "error" })), { type: "portainer", name: "d2" })
    same(Core.worstInstance(services, st({ pve: "ok", d1: "ok", d2: "ok", nas: "warn" })), { type: "truenas", name: "nas" })
    assert.strictEqual(Core.worstInstance(services, st({ pve: "ok", d1: "ok", d2: "ok", nas: "loading" })), null)
})

test("at most 4 different services (tabs); more instances of one still fit", () => {
    const A5 = Object.assign({}, A, { extra: { id: "extra", label: "Extra", defaultInterval: 60, secret: false, fields: {}, headers: [], poll() {} } })
    const four = [
        { type: "proxmox", name: "pve", url: "https://p", tokenId: "t", node: "n", secret: "keyring:p" },
        { type: "portainer", name: "d", url: "https://d", endpointId: 1, secret: "keyring:d" },
        { type: "truenas", name: "nas", url: "https://n", username: "u", secret: "keyring:n" },
        { type: "uptimekuma", name: "k", url: "https://k", slug: "s" },
    ]
    const cfg = { instances: four.concat([{ type: "extra", name: "x", url: "https://x" }]) }
    const c = Core.parseConfig(JSON.stringify(cfg), A5)
    assert.strictEqual(c.instances.length, 4)
    assert(/"x": skipped.*4 different services/.test(c.errors[0]), c.errors[0])
    const base = { instances: four }
    assert(!Core.canAdd(base, "extra", A5))                  // a 5th tab: no
    assert(Core.canAdd(base, "proxmox", A5))                 // a 2nd Proxmox inside its tab: yes
    assert(Core.validateCandidate(base, { type: "extra", name: "x", url: "https://x" }, "", A5).some(e => /4 different services/.test(e)))
    // switching your only Kuma to another type frees its tab
    same(Core.validateCandidate(base, { type: "extra", name: "k", url: "https://x" }, "k", A5), [])
})

// ── websocket rpc ────────────────────────────────────────────────────────────
test("truenas login template fills username + secret; JSON-safe", () => {
    const login = Core.renderTemplate(A.truenas.rpcLogin, { username: 'ad"min' }, "k\n\"ey")
    same(login, { method: "auth.login_ex", params: [{ mechanism: "API_KEY_PLAIN", username: 'ad"min', api_key: "k\n\"ey" }] })
    assert.strictEqual(JSON.parse(JSON.stringify(login)).params[0].api_key, "k\n\"ey")   // survives encoding intact
})
test("ws url from base url", () => {
    assert.strictEqual(Core.wsUrl("https://nas.lan:8443/", "/api/current"), "wss://nas.lan:8443/api/current")
    assert.strictEqual(Core.wsUrl("http://nas.lan", "/api/current"), "ws://nas.lan/api/current")
})
test("rpc helper output parsing", () => {
    const ok = Core.parseRpcResult(0, '{"results":[{"result":[1]},{"error":"Method does not exist"}]}')
    same(ok.results, [{ error: null, data: [1] }, { error: "Method does not exist", data: null }])
    const auth = Core.parseRpcResult(0, '{"error":"auth rejected","kind":"auth"}'); assert(auth.auth && !auth.certProblem)
    assert(Core.parseRpcResult(0, '{"error":"pin mismatch","kind":"pin"}').certProblem)
    assert(/python3 not installed/.test(Core.parseRpcResult(127, "").error))
    assert(/helper failed/.test(Core.parseRpcResult(0, "Traceback...").error))
})
test("truenas: session failure fails the poll", () => {
    assert.strictEqual(poll("truenas", {}, { rpc: "auth rejected — check the username and key" }).err, "auth rejected — check the username and key")
})
test("truenas needs a username", () => {
    const c = Core.parseConfig(JSON.stringify({ instances: [{ type: "truenas", name: "n", url: "https://n", secret: "keyring:n" }] }), A)
    assert(/missing "username"/.test(c.errors[0]))
})

test("header line speaks breaker", () => {
    const svc = [{ type: "portainer", instances: [{ name: "docker" }] }, { type: "uptimekuma", instances: [{ name: "kuma" }] }]
    const snap = (st, g) => ({ groups: [{ name: "ok", members: [{ status: "ok" }] }, { name: g, members: [{ status: st }] }], alerts: [] })
    const e = (n, st, extra) => Object.assign({ name: n, status: st, failCount: 0, snapshot: snap(st, "media") }, extra || {})
    assert.strictEqual(Core.troubleLine(svc, { docker: e("docker", "ok"), kuma: e("kuma", "ok") }), "All quiet")
    assert.strictEqual(Core.troubleLine(svc, { docker: e("docker", "error"), kuma: e("kuma", "ok") }), "Tripped: docker \u203a media")
    assert.strictEqual(Core.troubleLine(svc, { docker: e("docker", "error"), kuma: e("kuma", "error") }), "2 tripped: docker, kuma")
    assert.strictEqual(Core.troubleLine(svc, { docker: e("docker", "warn"), kuma: e("kuma", "ok") }), "Flickering: docker \u203a media")
    assert.strictEqual(Core.troubleLine(svc, { docker: e("docker", "error", { failCount: 2 }), kuma: e("kuma", "ok") }), "Tripped: docker (unreachable)")
    assert.strictEqual(Core.troubleLine(svc, {}), "Checking\u2026")
    assert.strictEqual(Core.troubleLine([], {}), "Nothing wired up yet")
})

test("a new key never overwrites an entry the config still uses", () => {
    const cfg = { instances: [{ name: "pve", secret: "keyring:pve" }, { name: "nas", secret: "keyring:shared" }] }
    // editing pve with a new key: fresh entry, old one stays until the config moves
    assert.strictEqual(Core.refForNewSecret(cfg, { name: "pve", secret: "keyring:pve" }), "keyring:pve-2")
    // a brand-new instance with an unused ref keeps it
    assert.strictEqual(Core.refForNewSecret(cfg, { name: "docker", secret: "keyring:docker" }), "keyring:docker")
    // a ref shared with another instance is never overwritten
    assert.strictEqual(Core.refForNewSecret(cfg, { name: "kuma", secret: "keyring:shared" }), "keyring:kuma")
})

console.log(passed + " passed, " + failed + " failed")
process.exit(failed ? 1 : 0)
