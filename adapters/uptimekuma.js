.pragma library
.import "../core/Core.js" as Core

// Uptime Kuma, read through ONE public status page, never the full monitor
// list. You decide in Kuma which monitors matter and how they're grouped;
// the bar shows that curated view, one row per status-page group, and the
// row limit applies like everywhere else. No API key: status pages are
// public and read-only. One Kuma per bar.
//
// Heartbeat status: 0 down, 1 up, 2 pending (retrying), 3 maintenance.
var BEAT = { 0: Core.STATUS.ERROR, 1: Core.STATUS.OK, 2: Core.STATUS.WARN, 3: Core.STATUS.PAUSED }
var BEAT_WORD = { 0: "down", 1: "up", 2: "retrying", 3: "maintenance" }

function latest(beats) {
    var best = null
    ;(beats || []).forEach(function(b) { if (!best || String(b.time) > String(best.time)) best = b })
    return best
}

function groupsFrom(page, beats) {
    var list = (beats && beats.heartbeatList) || {}
    return (page.publicGroupList || []).map(function(g) {
        return {
            name: g.name,
            members: (g.monitorList || []).map(function(m) {
                var b = latest(list[m.id])
                if (!b) return { name: m.name, status: Core.STATUS.LOADING, detail: "no checks yet" }
                var why = b.status === 1 ? "" : (b.msg ? String(b.msg) : BEAT_WORD[b.status] || "")
                return { name: m.name, status: BEAT[b.status] || Core.STATUS.WARN, detail: why }
            }),
        }
    }).filter(function(g) { return g.members.length > 0 })
}

// Mean 24h uptime of the monitors on this page.
function uptime24(page, beats) {
    var u = (beats && beats.uptimeList) || {}, seen = {}, sum = 0, n = 0
    ;(page.publicGroupList || []).forEach(function(g) {
        ;(g.monitorList || []).forEach(function(m) {
            var v = u[m.id + "_24"]
            if (seen[m.id] || typeof v !== "number") return
            seen[m.id] = true; sum += v; n++
        })
    })
    return n ? sum / n : null
}

var adapter = {
    id: "uptimekuma",
    label: "Uptime Kuma",
    shortLabel: "Kuma",       // tab strip is narrow
    defaultInterval: 60,
    maxInstances: 1,
    secret: false,
    urlExample: "https://kuma.lan",
    fields: {
        slug: { required: true, type: "string", label: "Status page", placeholder: "homelab",
                hint: "In Kuma, make a status page with just the monitors you want here, then enter the part after /status/ in its address" },
    },
    headers: [],
    groupsTitle: "Monitors",
    openUrl: function(inst) { return inst.url + "/status/" + encodeURIComponent(inst.slug) },

    poll: function(ctx, done) {
        var slug = encodeURIComponent(ctx.inst.slug)
        Core.parallel(ctx, ["/api/status-page/" + slug, "/api/status-page/heartbeat/" + slug], function(r) {
            // Kuma never answers an unknown page, but its heartbeat URL does.
            if (r[0].error === "timed out" && !r[1].error) return done("no status page \"" + ctx.inst.slug + "\" — check the name in Kuma")
            if (r[0].error) return done(r[0].error)
            var page = r[0].data
            if (!page || !Array.isArray(page.publicGroupList)) return done("that doesn't look like an Uptime Kuma status page")
            var beats = !r[1].error ? r[1].data : null
            var groups = beats ? groupsFrom(page, beats) : (ctx.previous ? ctx.previous.groups : groupsFrom(page, null))
            var up = beats ? uptime24(page, beats) : null
            var summary = up === null ? (ctx.previous ? ctx.previous.summary : [])
                : [{ label: "24h uptime", value: (Math.floor(up * 1000) / 10).toFixed(1) + "%" }]
            var alerts = (page.incident && page.incident.title)
                ? [{ status: Core.STATUS.WARN, text: "Incident: " + Core.plainText(page.incident.title) }] : []
            done(null, { summary: summary, alerts: alerts, groups: groups })
        })
    },
}
