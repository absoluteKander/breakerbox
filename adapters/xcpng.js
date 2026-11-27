.pragma library
.import "../core/Core.js" as Core

// XCP-ng, read through Xen Orchestra's REST API (/rest/v0). Plain GETs
// with ?fields=, so each poll is two small requests.
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
        ], function(r) {
            if (r[0].error) return done(r[0].error)
            var hosts = r[0].data
            if (!Array.isArray(hosts)) return done("that doesn't look like the Xen Orchestra REST API")
            var vms = !r[1].error && Array.isArray(r[1].data) ? r[1].data : null
            var groups = vms ? vmGroups(vms) : (ctx.previous ? ctx.previous.groups : [])   // keep last known VMs on a partial failure
            var hostsUp = hosts.filter(function(h) { return h && h.power_state === "Running" }).length
            var summary = [{ label: "Hosts", value: hostsUp + " / " + hosts.length }]
            if (vms) summary.push({ label: "VMs running", value: vms.filter(function(v) { return v && v.power_state === "Running" }).length + " / " + vms.length })
            else if (ctx.previous && ctx.previous.summary[1]) summary.push(ctx.previous.summary[1])
            done(null, { summary: summary, alerts: hostAlerts(hosts), groups: groups })
        })
    },
}
