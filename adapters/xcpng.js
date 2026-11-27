.pragma library
.import "../core/Core.js" as Core

// XCP-ng, read through Xen Orchestra's REST API (/rest/v0). Plain GETs
// with ?fields=, so each poll is three small requests.
//
// Token: in Xen Orchestra, your user → Authentication tokens → New token,
// or `xo-cli create-token <xo-host> <user>`. Make it for a user whose role
// is a copy of the built-in "Read only" RBAC role. (On XOA, RBAC needs the
// Essential+ bundle or above; from-sources installs have it.) Tokens expire,
// six months at most by default; an expired one shows as "auth rejected".
//
// /vms holds only real VMs: templates, snapshots and control domains live in
// their own collections, so nothing needs filtering out here.

// Like Proxmox: running → ok, running mid-operation (snapshot, migrate…) or
// paused/suspended → warn, halted → error.
function vmStatus(v) {
    var ops = v.current_operations && typeof v.current_operations === "object" ? v.current_operations : {}
    var op = Object.keys(ops).map(function(k) { return ops[k] })[0]
    if (v.power_state === "Running") return op ? { status: Core.STATUS.WARN, detail: "running (" + Core.plainText(op) + ")" } : { status: Core.STATUS.OK, detail: "running" }
    if (v.power_state === "Paused" || v.power_state === "Suspended") return { status: Core.STATUS.WARN, detail: String(v.power_state).toLowerCase() }
    return { status: Core.STATUS.ERROR, detail: v.power_state ? Core.plainText(String(v.power_state)).toLowerCase() : "unknown state" }
}

// Grouped by first tag, which is how XO users group VMs (Proxmox has pools
// for this). Biggest groups first, untagged VMs last.
var UNTAGGED = "Untagged"
function vmGroups(vms) {
    var by = {}
    vms.forEach(function(v) {
        if (!v || typeof v !== "object") return
        var tag = Array.isArray(v.tags) && v.tags.length ? String(v.tags[0]) : UNTAGGED
        var s = vmStatus(v)
        ;(by[tag] = by[tag] || []).push({ name: String(v.name_label || "unnamed VM"), status: s.status, detail: s.detail })
    })
    var groups = Object.keys(by).filter(function(k) { return k !== UNTAGGED })
        .map(function(k) { return { name: k, members: by[k] } })
        .sort(function(a, b) { return b.members.length - a.members.length || a.name.localeCompare(b.name) })
    if (by[UNTAGGED]) groups.push({ name: UNTAGGED, members: by[UNTAGGED] })
    return groups
}

// A host that isn't running is an outage, not a row: it's an alert. A host
// in maintenance mode (enabled: false) but running was put there on purpose.
function hostAlerts(hosts) {
    return hosts.filter(function(h) { return h && h.power_state !== "Running" }).map(function(h) {
        var why = h.power_state === "Unknown" ? "unreachable" : String(h.power_state || "unknown state").toLowerCase()
        return { status: Core.STATUS.ERROR, text: "Host " + Core.plainText(String(h.name_label || "?")) + " is " + Core.plainText(why) }
    })
}

// When Xen Orchestra loses a pool's master, it takes a while to notice and
// then gets it wrong in stages (seen on a real XO with the host unplugged):
// for ~2 minutes the server still says "connected" with no error; then
// "connected" *with* an error; then "connecting" with the error, by which
// point the pool's hosts and VMs have dropped out of /hosts and /vms
// entirely, which on its own would read as all quiet. So: any server with an
// error is red, whatever its status; one that isn't connected is red; plain
// "connecting" with no error (XO starting up) is amber.
var ERRNO_WORDS = { EHOSTUNREACH: "host unreachable", ENETUNREACH: "network unreachable", ETIMEDOUT: "timed out",
                    ECONNREFUSED: "connection refused", ECONNRESET: "connection reset", ENOTFOUND: "name not found" }

// XO's `error` is an object (an AggregateError with a stack trace inside);
// only ever show its code or message, never the rest.
function errorText(e) {
    if (!e) return ""
    if (typeof e === "string") return Core.plainText(e)
    if (typeof e !== "object") return "error"
    var inner = e["0"] && typeof e["0"] === "object" ? e["0"] : e
    var code = typeof inner.code === "string" ? inner.code : (typeof e.code === "string" ? e.code : "")
    if (code) return ERRNO_WORDS[code] || Core.plainText(code)
    return typeof e.message === "string" && e.message ? Core.plainText(e.message) : "error"
}

function serverAlerts(servers) {
    var out = []
    servers.forEach(function(sv) {
        if (!sv || typeof sv !== "object") return
        var name = Core.plainText(String(sv.label || sv.host || "a server"))
        var err = errorText(sv.error)
        if (err) out.push({ status: Core.STATUS.ERROR, text: "Xen Orchestra can't reach " + name + ": " + err })
        else if (sv.status === "connecting") out.push({ status: Core.STATUS.WARN, text: "Xen Orchestra is connecting to " + name })
        else if (sv.status !== "connected") out.push({ status: Core.STATUS.ERROR, text: "Xen Orchestra lost " + name + " (" + Core.plainText(String(sv.status || "no status")) + ")" })
    })
    return out
}

var adapter = {
    id: "xcpng",
    label: "XCP-ng",
    defaultInterval: 30,
    secret: true,
    urlExample: "https://xo.lan",
    fields: {},
    secretLabel: "Xen Orchestra token",
    secretHint: "In Xen Orchestra: your user → Authentication tokens → New. Use a user with a copy of the \"Read only\" role.",
    headers: ["Cookie: authenticationToken={secret}"],
    groupsTitle: "VMs",

    poll: function(ctx, done) {
        Core.parallel(ctx, [
            "/rest/v0/hosts?fields=name_label,power_state,enabled",
            "/rest/v0/vms?fields=name_label,power_state,tags,current_operations",
            "/rest/v0/servers?fields=label,status,error",
        ], function(r) {
            if (r[0].error) return done(r[0].error)
            var hosts = r[0].data
            if (!Array.isArray(hosts)) return done("that doesn't look like the Xen Orchestra REST API")
            var servers = !r[2].error && Array.isArray(r[2].data) ? r[2].data : null
            if (servers && servers.length === 0) return done("Xen Orchestra has no XCP-ng servers added yet")
            var alerts = (servers ? serverAlerts(servers) : []).concat(hostAlerts(hosts))
            // Can't see the server list (a role without it) and no hosts either: say we can't tell.
            if (!servers && hosts.length === 0) alerts.push({ status: Core.STATUS.WARN, text: "No hosts visible, and this token can't read Xen Orchestra's server list to say why" })
            var vms = !r[1].error && Array.isArray(r[1].data) ? r[1].data : null
            var groups = vms ? vmGroups(vms) : (ctx.previous ? ctx.previous.groups : [])   // keep last known VMs on a partial failure
            var hostsUp = hosts.filter(function(h) { return h && h.power_state === "Running" }).length
            var summary = [{ label: "Hosts", value: hostsUp + " / " + hosts.length }]
            if (vms) summary.push({ label: "VMs running", value: vms.filter(function(v) { return v && v.power_state === "Running" }).length + " / " + vms.length })
            else if (ctx.previous && ctx.previous.summary[1]) summary.push(ctx.previous.summary[1])
            done(null, { summary: summary, alerts: alerts, groups: groups })
        })
    },
}
