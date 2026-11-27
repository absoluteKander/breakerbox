.pragma library
.import "../core/Core.js" as Core

// Healthchecks (healthchecks.io, or your own instance): cron jobs and
// backups that ping in, and go "down" when they stop. Management API v3.
//
// Key: Project Settings → API Access → Create a READ-ONLY key. That's all
// this needs: read-only keys can only list checks, and their responses leave
// out the ping URLs and UUIDs, so this plugin never holds anything that
// could ping, pause or change a check. Keys are per project, so one
// instance here is one Healthchecks project.
//
// Like Kuma's status page, an optional tag picks the checks worth a glance.
// Checks are grouped by their first tag (other than the filter tag), since
// tags are how Healthchecks users group things.

// up → ok. grace (late, not yet down) → warn. down → error.
// paused, and new (never pinged yet) → grey: nothing is wrong yet.
var STATE = { up: Core.STATUS.OK, grace: Core.STATUS.WARN, down: Core.STATUS.ERROR, paused: Core.STATUS.PAUSED, "new": Core.STATUS.PAUSED }
var UNTAGGED = "Untagged"

function memberDetail(c, now) {
    var last = c.last_ping ? Date.parse(c.last_ping) : NaN
    var ago = isNaN(last) ? "" : "last ping " + Core.fmtAgo(last, now)
    if (c.status === "new") return "waiting for its first ping"
    if (c.status === "paused") return "paused"
    if (c.status === "grace") return "late" + (ago ? " · " + ago : "")
    if (c.status === "down") return "down" + (ago ? " · " + ago : "")
    if (c.started) return "running now"
    return ago
}

function groupKey(c, filterTag) {
    var tags = String(c.tags || "").split(/\s+/).filter(function(t) { return t && t !== filterTag })
    return tags.length ? tags[0] : UNTAGGED
}

function groupsFrom(checks, filterTag, now) {
    var by = {}
    checks.forEach(function(c) {
        var k = groupKey(c, filterTag)
        ;(by[k] = by[k] || []).push({
            name: String(c.name || c.slug || "unnamed check"),
            status: STATE[c.status] || Core.STATUS.WARN,
            detail: memberDetail(c, now),
        })
    })
    var names = Object.keys(by).filter(function(k) { return k !== UNTAGGED }).sort()
    if (by[UNTAGGED]) names.push(UNTAGGED)
    return names.map(function(k) { return { name: k, members: by[k] } })
}

var adapter = {
    id: "healthchecks",
    label: "Healthchecks",
    shortLabel: "Checks",     // tab strip is narrow
    defaultInterval: 60,      // the API asks for under 100 requests a minute; this makes 1
    secret: true,
    urlExample: "https://healthchecks.io",
    fields: {
        tag: { required: false, type: "string", label: "Tag (optional)", placeholder: "homelab",
               hint: "Only show checks with this tag. Leave empty to show every check in the project" },
    },
    secretLabel: "Read-only API key",
    secretHint: "Project Settings → API Access → Create read-only API key",
    headers: ["X-Api-Key: {secret}"],
    groupsTitle: "Checks",

    poll: function(ctx, done) {
        var tag = ctx.inst.tag || ""
        ctx.get("/api/v3/checks/" + (tag ? "?tag=" + encodeURIComponent(tag) : ""), function(err, data) {
            if (err) return done(err)
            if (!data || !Array.isArray(data.checks)) return done("that doesn't look like the Healthchecks API")
            var checks = data.checks
            if (tag && checks.length === 0) return done("no checks tagged \"" + tag + "\" — check the tag in Healthchecks")
            var up = checks.filter(function(c) { return c.status === "up" }).length
            var active = checks.filter(function(c) { return c.status !== "paused" && c.status !== "new" }).length
            done(null, {
                summary: [{ label: "Up", value: up + " / " + active }],
                alerts: [],
                groups: groupsFrom(checks, tag, Date.now()),
            })
        })
    },
}
