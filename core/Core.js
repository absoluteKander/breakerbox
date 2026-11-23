.pragma library

// Pure logic shared by the singleton and the adapters. Nothing in here
// touches QML, the network, or secrets, so all of it runs under node in
// tests/run.js exactly as it runs in the shell.

// ─── Status vocabulary ───────────────────────────────────────────────────────
// One vocabulary everywhere. Worst wins at every level of rollup.

// PAUSED is something deliberately switched off (e.g. a monitor in
// maintenance): shown grey, and never makes anything amber or red.
var STATUS = { OK: "ok", WARN: "warn", ERROR: "error", LOADING: "loading", PAUSED: "paused" }
var RANK = { loading: 0, paused: 0, ok: 1, warn: 2, error: 3 }

function worst(statuses) {
    var best = STATUS.LOADING
    for (var i = 0; i < statuses.length; i++) {
        var s = statuses[i]
        if (RANK[s] !== undefined && RANK[s] > RANK[best]) best = s
    }
    return best
}

function groupStatus(group) {
    return worst((group.members || []).map(function(m) { return m.status }))
}

// What counts toward an instance's status: group members and alerts. Summary
// stats are context only (a busy CPU is not an outage), so they carry a
// display `tone` but never move the dot.
function snapshotStatus(snap) {
    if (!snap) return STATUS.LOADING
    var list = (snap.groups || []).map(groupStatus)
        .concat((snap.alerts || []).map(function(a) { return a.status }))
    var w = worst(list)
    return RANK[w] === 0 ? STATUS.OK : w
}

// ─── Reachability with debounce ──────────────────────────────────────────────
// An instance only turns red after `threshold` consecutive failed polls. Until
// then it keeps its last status and last-known-good snapshot, marked stale.
// After it turns red the old snapshot is still kept, so the panel can show
// what things looked like when it was last reachable.

function newEntry(inst) {
    return {
        name: inst.name, type: inst.type,
        status: STATUS.LOADING, snapshot: null,
        error: "", failCount: 0, stale: false,
        lastOk: 0, lastAttempt: 0,
    }
}

function _copy(o) {
    var out = {}
    for (var k in o) out[k] = o[k]
    return out
}

function applySuccess(entry, snap, now) {
    var e = _copy(entry)
    e.snapshot = snap
    e.status = snapshotStatus(snap)
    e.error = ""
    e.failCount = 0
    e.stale = false
    e.lastOk = now
    e.lastAttempt = now
    return e
}

function applyFailure(entry, err, threshold, now) {
    var e = _copy(entry)
    e.failCount = (entry.failCount || 0) + 1
    e.lastAttempt = now
    e.error = String(err || "unknown error")
    e.stale = !!entry.snapshot
    if (e.failCount >= Math.max(1, threshold)) e.status = STATUS.ERROR
    // below threshold: status deliberately unchanged
    return e
}

// True when the instance is failing but hasn't crossed the threshold yet.
function isRetrying(entry) {
    return !!entry && entry.failCount > 0 && entry.status !== STATUS.ERROR
}

function overall(entries) {
    var list = []
    for (var k in entries) list.push(entries[k].status)
    return worst(list)
}

// ─── Config ──────────────────────────────────────────────────────────────────

var SECRET_REF = /^(keyring|pass):([A-Za-z0-9._\/@+-]+)$/
var PIN = /^sha256\/\/[A-Za-z0-9+\/]{43}=$/
var NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/
var MIN_INTERVAL = 10

// ─── Size limits ─────────────────────────────────────────────────────────────
// This is for small, first-time homelabs: one or two of each thing, often on
// finicky hardware. Past these limits a real dashboard (Homarr, Uptime Kuma,
// Grafana) serves people better, and the plugin says so instead of
// stretching to fit.
var MAX_TYPES = 4           // different services (top-level tabs); more instances of one live inside its tab
var MAX_PER_TYPE = 3        // instances of one service type; an adapter may set a lower maxInstances
var MAX_ROWS = 12           // group rows shown for one instance
var MAX_PROBLEMS = 5        // members listed when a group opens itself
var BIGGER_LAB_HINT = "for a bigger lab, a dashboard like Homarr or Uptime Kuma will serve you better"

function maxFor(adapter) {
    return Math.min(MAX_PER_TYPE, adapter && adapter.maxInstances ? adapter.maxInstances : MAX_PER_TYPE)
}

function _limitText(adapter) {
    var n = maxFor(adapter)
    return "the limit is " + n + " " + adapter.label + (n === 1 ? "" : " instances") + " — " + BIGGER_LAB_HINT
}

function _typesIn(rawCfg, adapters, exceptName) {
    var seen = {}, list = []
    ;((rawCfg && rawCfg.instances) || []).forEach(function(x) {
        if (!x || !adapters[x.type] || x.name === exceptName || seen[x.type]) return
        seen[x.type] = true
        list.push(x.type)
    })
    return list
}

var TYPES_LIMIT_TEXT = "the limit is " + MAX_TYPES + " different services, one tab each — " + BIGGER_LAB_HINT

// Can another instance of `type` be added to this raw config? It must have
// room in its own tab, and be either a service already shown or a new one
// that still fits in the tab strip.
function canAdd(rawCfg, type, adapters) {
    var n = ((rawCfg && rawCfg.instances) || []).filter(function(x) { return x && x.type === type }).length
    if (n >= maxFor(adapters[type])) return false
    var types = _typesIn(rawCfg, adapters, null)
    return types.indexOf(type) !== -1 || types.length < MAX_TYPES
}

// Rows for one instance: all of them when they fit; otherwise anything not
// green first (so a problem is never hidden), then the rest, cut to
// MAX_ROWS. -> { rows, hidden }
function visibleGroups(groups) {
    var list = groups || []
    if (list.length <= MAX_ROWS) return { rows: list, hidden: 0 }
    var bad = list.filter(function(g) { return RANK[groupStatus(g)] >= RANK.warn })
    var good = list.filter(function(g) { return RANK[groupStatus(g)] < RANK.warn })
    return { rows: bad.concat(good).slice(0, MAX_ROWS), hidden: list.length - MAX_ROWS }
}

function parseSecretRef(ref) {
    var m = SECRET_REF.exec(String(ref || ""))
    return m ? { kind: m[1], path: m[2] } : null
}

function _isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v) }

// Returns { failThreshold, instances, errors }. A bad instance is dropped with
// an error naming it; the rest still load. Instances keep config order.
function parseConfig(text, adapters) {
    var out = { failThreshold: 2, instances: [], errors: [] }
    var cfg
    try { cfg = JSON.parse(text) }
    catch (e) { out.errors.push("config is not valid JSON: " + e.message); return out }
    if (!_isObject(cfg)) { out.errors.push("config must be a JSON object"); return out }

    if (cfg.failThreshold !== undefined) {
        var t = cfg.failThreshold
        if (typeof t === "number" && t >= 1 && t <= 10 && Math.floor(t) === t) out.failThreshold = t
        else out.errors.push("failThreshold must be a whole number from 1 to 10")
    }

    var list = cfg.instances
    if (!Array.isArray(list)) { out.errors.push("config needs an \"instances\" array"); return out }

    var seen = {}
    var perType = {}
    var typeCount = 0
    for (var i = 0; i < list.length; i++) {
        var raw = list[i]
        var where = "instance " + (i + 1)
        if (!_isObject(raw)) { out.errors.push(where + ": must be an object"); continue }
        if (raw.name) where = "\"" + raw.name + "\""

        var adapter = adapters[raw.type]
        if (!adapter) { out.errors.push(where + ": unknown type \"" + raw.type + "\""); continue }
        if (!NAME.test(String(raw.name || ""))) { out.errors.push(where + ": name is required (letters, digits, space . _ -, max 40)"); continue }
        if (seen[raw.name]) { out.errors.push(where + ": duplicate name"); continue }
        if ((perType[raw.type] || 0) >= maxFor(adapter)) { out.errors.push(where + ": skipped — " + _limitText(adapter)); continue }
        if (!perType[raw.type] && typeCount >= MAX_TYPES) { out.errors.push(where + ": skipped — " + TYPES_LIMIT_TEXT); continue }

        var url = String(raw.url || "").replace(/\/+$/, "")
        if (!/^https?:\/\/[^\s\/?#]+(\/[^\s?#]*)?$/.test(url)) { out.errors.push(where + ": url must be http(s)://host[/path]"); continue }

        var inst = { type: raw.type, name: raw.name, url: url }

        if (adapter.secret) {
            if (!parseSecretRef(raw.secret)) {
                out.errors.push(where + ": \"secret\" must be a reference like keyring:" + raw.name
                    + " or pass:homelab/" + raw.name + " — never the secret itself")
                continue
            }
            inst.secret = raw.secret
        } else if (raw.secret !== undefined) {
            out.errors.push(where + ": " + raw.type + " does not use a secret; remove it")
            continue
        }

        if (raw.pin !== undefined) {
            var pins = String(raw.pin).split(";")
            if (url.indexOf("https://") !== 0 || !pins.every(function(p) { return PIN.test(p) })) {
                out.errors.push(where + ": pin must be sha256//<base64> (https only; separate several with ;)")
                continue
            }
            inst.pin = raw.pin
        }

        var interval = raw.interval === undefined ? adapter.defaultInterval : raw.interval
        if (typeof interval !== "number" || interval < MIN_INTERVAL) {
            out.errors.push(where + ": interval must be at least " + MIN_INTERVAL + " seconds")
            continue
        }
        inst.interval = interval

        var bad = false
        var fields = adapter.fields || {}
        for (var f in fields) {
            var v = raw[f]
            if (v === undefined || v === null || v === "") {
                if (fields[f].required) { out.errors.push(where + ": missing \"" + f + "\""); bad = true; break }
                if (fields[f].default !== undefined) inst[f] = fields[f].default
                continue
            }
            if (fields[f].type && typeof v !== fields[f].type) {
                out.errors.push(where + ": \"" + f + "\" must be a " + fields[f].type); bad = true; break
            }
            inst[f] = v
        }
        if (bad) continue

        seen[raw.name] = true
        if (!perType[raw.type]) typeCount++
        perType[raw.type] = (perType[raw.type] || 0) + 1
        out.instances.push(inst)
    }
    return out
}

// ─── Request building ────────────────────────────────────────────────────────

// Fills an adapter's header templates. {secret} is the resolved secret,
// {field} any config field. A value containing a line break is refused: curl
// reads these headers one per line from stdin, so a newline would let a
// config value smuggle in an extra header.
function renderHeaders(templates, inst, secret) {
    var lines = []
    for (var i = 0; i < (templates || []).length; i++) {
        var bad = false
        var line = templates[i].replace(/\{(\w+)\}/g, function(_, key) {
            var v = key === "secret" ? secret : inst[key]
            v = v === undefined || v === null ? "" : String(v)
            if (/[\r\n]/.test(v)) bad = true
            return v
        })
        if (bad) return null
        lines.push(line)
    }
    return lines
}

var TIMEOUT_S = 10
var CONNECT_TIMEOUT_S = 5

// argv for one GET. Headers (which may carry the secret) go over stdin via
// `-H @-` so they never appear in argv / ps. No -L: a redirect is never
// followed, so a secret is never replayed to another host.
function curlArgs(url, opts) {
    var args = ["curl", "-sS", "--proto", "=https,http",
        "--max-time", String(TIMEOUT_S), "--connect-timeout", String(CONNECT_TIMEOUT_S),
        "-H", "Accept: application/json",
        "-w", "\n%{http_code}"]
    if (opts && opts.hasHeaders) args.push("-H", "@-")
    if (opts && opts.pin) {
        // The pin replaces CA trust for this one instance: -k skips chain
        // verification, --pinnedpubkey still refuses any other key (curl
        // exit 90). Never applied without a pin.
        args.push("--insecure", "--pinnedpubkey", opts.pin)
    }
    args.push("--", url)
    return args
}

var CURL_ERRORS = {
    6: "can't resolve host",
    7: "connection refused",
    28: "timed out",
    35: "TLS handshake failed",
    51: "certificate doesn't match host",
    52: "empty reply",
    56: "connection reset",
    58: "client certificate problem",
    60: "certificate not trusted — pin it if it's self-signed",
    90: "certificate pin mismatch — cert changed or wrong pin",
}

// Curl exits that mean "the cert isn't one we trust" — the setup UI offers to
// inspect and pin it. 51 = name mismatch, 60 = untrusted CA, 90 = pin mismatch.
var CERT_EXITS = { 51: true, 60: true, 90: true }

// -> { error, auth, status, data, exit? }. `auth` marks 401/403 so the caller can
// drop its cached secret and look it up again next time.
function parseCurlResult(exitCode, stdout, stderr) {
    if (exitCode !== 0) {
        var msg = CURL_ERRORS[exitCode]
        if (!msg) msg = exitCode === 127 ? "curl not installed" : "curl error " + exitCode
        return { error: msg, auth: false, status: 0, data: null, exit: exitCode }
    }
    var text = String(stdout || "")
    var cut = text.lastIndexOf("\n")
    var status = parseInt(text.slice(cut + 1), 10) || 0
    var body = cut >= 0 ? text.slice(0, cut) : ""
    if (status === 401 || status === 403) return { error: "auth rejected (HTTP " + status + ") — check the secret", auth: true, status: status, data: null }
    if (status < 200 || status >= 300) return { error: "HTTP " + status, auth: false, status: status, data: null }
    if (body === "") return { error: null, auth: false, status: status, data: null }
    try { return { error: null, auth: false, status: status, data: JSON.parse(body) } }
    catch (e) { return { error: "response wasn't JSON", auth: false, status: status, data: null } }
}

// ─── WebSocket JSON-RPC (bin/wsrpc.py) ────────────────────────────────────
// For APIs with no REST left (TrueNAS 25.04+). Same rules as curl: secret on
// stdin only, per-instance pin, hard timeout.

// Deep copy of an adapter's login template with {secret} / {field} filled
// in. It's JSON-encoded afterwards, so no value can break out of its string.
function renderTemplate(tpl, inst, secret) {
    if (typeof tpl === "string")
        return tpl.replace(/\{(\w+)\}/g, function(_, k) {
            var v = k === "secret" ? secret : inst[k]
            return v === undefined || v === null ? "" : String(v)
        })
    if (Array.isArray(tpl)) return tpl.map(function(x) { return renderTemplate(x, inst, secret) })
    if (tpl && typeof tpl === "object") {
        var out = {}
        for (var k in tpl) out[k] = renderTemplate(tpl[k], inst, secret)
        return out
    }
    return tpl
}

// https://host[:port]/x + /api/current -> wss://host[:port]/api/current
function wsUrl(baseUrl, path) {
    return String(baseUrl).replace(/^http(s?):\/\//, "ws$1://").replace(/\/+$/, "") + path
}

// -> { error, auth, certProblem, results: [{ error, data }] }
function parseRpcResult(exitCode, stdout) {
    if (exitCode === 127) return { error: "python3 not installed", auth: false, certProblem: false, results: null }
    var out
    try { out = JSON.parse(String(stdout || "")) } catch (e) { out = null }
    if (exitCode !== 0 || !out) return { error: "rpc helper failed", auth: false, certProblem: false, results: null }
    if (out.error) return { error: String(out.error), auth: out.kind === "auth", certProblem: out.kind === "cert" || out.kind === "pin", results: null }
    return {
        error: null, auth: false, certProblem: false,
        results: (out.results || []).map(function(r) { return { error: r.error ? String(r.error) : null, data: r.error ? null : r.result } }),
    }
}

// ─── Adapter helpers ─────────────────────────────────────────────────────────

// Runs several ctx.get()s at once; cb gets [{ error, data }] in input order.
function parallel(ctx, paths, cb) {
    var results = new Array(paths.length)
    var remaining = paths.length
    if (remaining === 0) { cb(results); return }
    paths.forEach(function(p, i) {
        ctx.get(p, function(err, data) {
            results[i] = { error: err, data: data }
            if (--remaining === 0) cb(results)
        })
    })
}

function ratioTone(ratio, warnAt, errorAt) {
    if (ratio >= errorAt) return STATUS.ERROR
    if (ratio >= warnAt) return STATUS.WARN
    return STATUS.OK
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtBytes(bytes) {
    var b = Number(bytes) || 0
    if (b >= 1099511627776) return (b / 1099511627776).toFixed(1) + " TB"
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB"
    if (b >= 1048576) return (b / 1048576).toFixed(0) + " MB"
    return b + " B"
}

function fmtUptime(seconds) {
    var s = Math.floor(Number(seconds) || 0)
    var d = Math.floor(s / 86400)
    var h = Math.floor((s % 86400) / 3600)
    if (d > 0) return d + "d " + h + "h"
    return h + "h " + Math.floor((s % 3600) / 60) + "m"
}

function fmtAgo(ms, now) {
    if (!ms) return "never"
    var s = Math.max(0, Math.round((now - ms) / 1000))
    if (s < 60) return s + "s ago"
    if (s < 3600) return Math.floor(s / 60) + "m ago"
    if (s < 86400) return Math.floor(s / 3600) + "h ago"
    return Math.floor(s / 86400) + "d ago"
}

// The service + instance the panel should open on: the first red one in
// tab order, else the first amber one, else null (nothing to show).
// `services` is Monitor.services ([{ type, instances }]).
function worstInstance(services, entries) {
    var levels = [STATUS.ERROR, STATUS.WARN]
    for (var l = 0; l < levels.length; l++) {
        for (var s = 0; s < (services || []).length; s++) {
            var list = services[s].instances || []
            for (var i = 0; i < list.length; i++) {
                var e = entries[list[i].name]
                if (e && e.status === levels[l]) return { type: services[s].type, name: list[i].name }
            }
        }
    }
    return null
}

// The panel header's one line, in breaker terms. `services` is
// Monitor.services; the first problem names the instance and the group
// that's down ("docker › media"), the way the panel will open on it.
function troubleLine(services, entries) {
    var red = [], amber = [], loading = 0, total = 0
    ;(services || []).forEach(function(s) {
        ;(s.instances || []).forEach(function(inst) {
            total++
            var e = entries[inst.name]
            if (!e || e.status === STATUS.LOADING) loading++
            else if (e.status === STATUS.ERROR) red.push(e)
            else if (e.status === STATUS.WARN) amber.push(e)
        })
    })
    function where(e) {
        if (e.failCount > 0 || !e.snapshot) return e.name + " (unreachable)"
        var g = (e.snapshot.groups || []).filter(function(g) { return groupStatus(g) === e.status })[0]
        if (g) return e.name + " \u203a " + g.name
        var a = (e.snapshot.alerts || []).filter(function(a) { return a.status === e.status })[0]
        return a ? e.name + " \u203a alert" : e.name
    }
    if (total === 0) return "Nothing wired up yet"
    if (red.length === 1) return "Tripped: " + where(red[0])
    if (red.length > 1) return red.length + " tripped: " + red.map(function(e) { return e.name }).join(", ")
    if (amber.length === 1) return "Flickering: " + where(amber[0])
    if (amber.length > 1) return amber.length + " flickering: " + amber.map(function(e) { return e.name }).join(", ")
    if (loading === total) return "Checking\u2026"
    return "All quiet"
}


// Status colours. Semantic, so deliberately not taken from the theme.
var COLORS = { ok: "#4ade80", warn: "#facc15", error: "#f87171", loading: "#94a3b8", paused: "#94a3b8" }

function color(status) { return COLORS[status] || COLORS.loading }

// ─── Editing config from the setup UI ────────────────────────────────────────
// Pure helpers over the *raw* config object (what's in the file), so a
// round-trip through the UI never drops fields this version doesn't know.

function slugRef(name) {
    var s = String(name || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    return s || "instance"
}

// A keyring ref for a new instance that no other instance already uses.
function freshSecretRef(rawCfg, name) {
    var used = {}
    ;((rawCfg && rawCfg.instances) || []).forEach(function(i) { if (i && i.secret) used[i.secret] = true })
    var base = slugRef(name), ref = "keyring:" + base, n = 2
    while (used[ref]) ref = "keyring:" + base + "-" + (n++)
    return ref
}

// Form values (all strings) -> a raw instance. Number fields are converted;
// empty optional fields are left out so defaults keep applying.
function formToRaw(adapter, type, values) {
    var raw = { type: type, name: String(values.name || "").trim(), url: String(values.url || "").trim() }
    var fields = adapter.fields || {}
    for (var f in fields) {
        var v = String(values[f] === undefined ? "" : values[f]).trim()
        if (v === "") continue
        raw[f] = fields[f].type === "number" ? (/^-?\d+$/.test(v) ? parseInt(v, 10) : v) : v
    }
    var interval = String(values.interval || "").trim()
    if (interval !== "") raw.interval = /^\d+$/.test(interval) ? parseInt(interval, 10) : interval
    if (values.pin) raw.pin = values.pin
    if (values.secret) raw.secret = values.secret
    return raw
}

// Raw instance -> form values (strings).
function rawToForm(adapter, raw) {
    var v = { name: raw.name || "", url: raw.url || "", interval: raw.interval === undefined ? "" : String(raw.interval), pin: raw.pin || "", secret: raw.secret || "" }
    for (var f in (adapter.fields || {})) v[f] = raw[f] === undefined ? "" : String(raw[f])
    return v
}

function _cfgCopy(rawCfg) {
    var out = {}
    for (var k in (rawCfg || {})) out[k] = rawCfg[k]
    out.instances = ((rawCfg && rawCfg.instances) || []).slice()
    return out
}

// Replace the instance called `originalName` (or append when it's empty).
function upsertInstance(rawCfg, raw, originalName) {
    var cfg = _cfgCopy(rawCfg)
    var i = originalName ? cfg.instances.findIndex(function(x) { return x && x.name === originalName }) : -1
    if (i >= 0) cfg.instances[i] = raw
    else cfg.instances.push(raw)
    return cfg
}

function removeInstance(rawCfg, name) {
    var cfg = _cfgCopy(rawCfg)
    cfg.instances = cfg.instances.filter(function(x) { return !x || x.name !== name })
    return cfg
}

// Errors for one candidate, as the real loader would report them, plus a
// duplicate-name check against the rest of the config.
function validateCandidate(rawCfg, raw, originalName, adapters) {
    var errors = parseConfig(JSON.stringify({ instances: [raw] }), adapters).errors
        .map(function(e) { return e.replace(/^("[^"]*"|instance 1): /, "") })
    var clash = ((rawCfg && rawCfg.instances) || []).some(function(x) {
        return x && x.name === raw.name && x.name !== originalName
    })
    if (clash) errors.push("another service is already called \"" + raw.name + "\"")
    var others = ((rawCfg && rawCfg.instances) || []).filter(function(x) {
        return x && x.type === raw.type && x.name !== originalName
    }).length
    if (adapters[raw.type] && others >= maxFor(adapters[raw.type])) errors.push(_limitText(adapters[raw.type]))
    var types = _typesIn(rawCfg, adapters, originalName)
    if (types.indexOf(raw.type) === -1 && types.length >= MAX_TYPES) errors.push(TYPES_LIMIT_TEXT)
    return errors
}

// Is a keyring ref still used by any instance in this config?
function secretRefInUse(rawCfg, ref) {
    return ((rawCfg && rawCfg.instances) || []).some(function(x) { return x && x.secret === ref })
}

// https://host[:port]/… -> { host, port } for fetching a certificate.
function hostPort(url) {
    var m = /^https:\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(?:\/|$)/.exec(String(url || ""))
    if (!m) return null
    return { host: m[1].replace(/^\[|\]$/g, ""), port: m[2] ? parseInt(m[2], 10) : 443 }
}

// One line describing a successful test poll.
function describeSnapshot(snap) {
    var members = 0
    ;(snap.groups || []).forEach(function(g) { members += (g.members || []).length })
    var bits = []
    if (members) bits.push(members + " item" + (members === 1 ? "" : "s"))
    if ((snap.alerts || []).length) bits.push(snap.alerts.length + " alert" + (snap.alerts.length === 1 ? "" : "s"))
    var st = snapshotStatus(snap)
    return "Connected" + (bits.length ? " — " + bits.join(", ") : "") + (st === STATUS.OK ? "" : " (currently " + st + ")")
}
