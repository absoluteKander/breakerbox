.pragma library
.import "../core/Core.js" as Core

// TrueNAS SCALE 25.04 and later, over the JSON-RPC WebSocket API. The REST
// API is deprecated in 25.04 and removed in 26/27, so this never uses it.
// API key: top-right user menu → API Keys. auth.login_ex needs the name of
// the user the key belongs to.

// app.state is TrueNAS's own rollup, which already ignores one-shot init /
// permissions sidecar containers that sit "exited" by design. Trust it; do
// not recompute it from the containers.
function appStatus(state) {
    switch (state) {
        case "RUNNING": return Core.STATUS.OK
        case "STOPPED":
        case "CRASHED": return Core.STATUS.ERROR
        default: return Core.STATUS.WARN   // DEPLOYING, STOPPING, unknown
    }
}

// Only active WARNING-and-up alerts. INFO (update available, etc.) is left
// to TrueNAS's own UI so this never turns into a second alert centre.
var ALERT_LEVELS = { WARNING: Core.STATUS.WARN, ERROR: Core.STATUS.ERROR, CRITICAL: Core.STATUS.ERROR, ALERT: Core.STATUS.ERROR, EMERGENCY: Core.STATUS.ERROR }

function alertsFrom(list) {
    return (list || []).filter(function(a) { return !a.dismissed && ALERT_LEVELS[a.level] })
        .map(function(a) { return { status: ALERT_LEVELS[a.level], text: Core.plainText(a.formatted || a.text || a.klass) || "Active alert" } })
}

var adapter = {
    id: "truenas",
    label: "TrueNAS",
    defaultInterval: 60,
    secret: true,
    urlExample: "https://truenas.lan",
    fields: {
        username: { required: true, type: "string", label: "Username", placeholder: "truenas_admin",
                    hint: "The TrueNAS user the API key belongs to (shown next to the key under API Keys)" },
    },
    secretLabel: "API key",
    secretHint: "Top-right user menu → API Keys → Add",
    headers: [],
    rpcPath: "/api/current",
    rpcLogin: { method: "auth.login_ex", params: [{ mechanism: "API_KEY_PLAIN", username: "{username}", api_key: "{secret}" }] },
    groupsTitle: "Apps",

    poll: function(ctx, done) {
        ctx.rpc([
            ["app.query", [[], { select: ["name", "title", "state"] }]],
            ["pool.query", [[], { select: ["name", "healthy", "status", "size", "allocated"] }]],
            ["alert.list", []],
        ], function(err, r) {
            if (err) return done(err)
            if (r[0].error) return done(r[0].error)
            if (!Array.isArray(r[0].data)) return done("unexpected response from app list")
            var prev = ctx.previous || {}

            var apps = r[0].data.map(function(a) {
                return { name: a.title || a.name, status: appStatus(a.state), detail: String(a.state || "").toLowerCase() }
            }).sort(function(a, b) { return a.name.localeCompare(b.name) })

            var summary = prev.summary || [], alerts = []
            if (!r[1].error && Array.isArray(r[1].data)) {
                summary = r[1].data.map(function(p) {
                    var ratio = p.size ? p.allocated / p.size : 0
                    return {
                        label: p.name,
                        value: Core.fmtBytes(p.allocated) + " / " + Core.fmtBytes(p.size),
                        ratio: ratio,
                        tone: p.healthy ? Core.ratioTone(ratio, 0.8, 0.9) : Core.STATUS.ERROR,
                    }
                })
                r[1].data.forEach(function(p) {
                    if (!p.healthy) alerts.push({ status: Core.STATUS.ERROR, text: "Pool " + p.name + " is " + (p.status || "unhealthy") })
                })
            } else {
                alerts = (prev.alerts || []).filter(function(a) { return /^Pool /.test(a.text) })
            }
            alerts = alerts.concat(!r[2].error
                ? alertsFrom(r[2].data)
                : (prev.alerts || []).filter(function(a) { return !/^Pool /.test(a.text) }))

            // One row per app, like a single-container stack.
            done(null, { summary: summary, alerts: alerts, groups: apps.map(function(a) { return { name: a.name, members: [a] } }) })
        })
    },
}
