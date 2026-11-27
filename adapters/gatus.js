.pragma library
.import "../core/Core.js" as Core

// Gatus: endpoint health checks, grouped the way your Gatus config groups
// them. Reads /api/v1/endpoints/statuses, Gatus's read-only API, with
// pageSize=1 so each endpoint brings only its latest result (a few KB
// instead of the last 50 checks of everything).
//
// No key: Gatus has no API tokens. This works with a Gatus that answers
// without a login, such as one on your LAN or behind your reverse
// proxy's own access rules. Basic-auth or OIDC-protected Gatus isn't
// supported yet. One Gatus per bar, like Uptime Kuma.
//
// Gatus's API says nothing about maintenance windows or disabled
// endpoints, so neither can show grey here; Gatus's own UI has them.

var UNGROUPED = "Ungrouped"

// Go's HTTP errors lead with the request ('Get "http://…": dial tcp …:
// connect: connection refused'), which buries the reason past the panel's
// edge. Keep the reason.
function shortError(t) {
    return t.replace(/^[A-Z][A-Za-z]* "[^"]*": /, "")
        .replace(/^dial (tcp|udp)[46]?( \S+)?: (connect: )?/, "")
        .replace(/^context deadline exceeded.*/, "timed out")
}

// Why a check failed, in Gatus's own words: its error, else the first
// condition that didn't hold (e.g. "[STATUS] == 200").
function failure(r) {
    if (r.errors && r.errors.length) return shortError(Core.plainText(r.errors[0]))
    var bad = (r.conditionResults || []).filter(function(c) { return c && !c.success })[0]
    return bad ? Core.plainText(bad.condition) : "failing"
}

function member(e) {
    var name = String(e.name || e.key || "unnamed endpoint")
    var r = (e.results || [])[0]
    if (!r) return { name: name, status: Core.STATUS.LOADING, detail: "no checks yet" }
    if (r.success === true) return { name: name, status: Core.STATUS.OK, detail: "" }
    return { name: name, status: Core.STATUS.ERROR, detail: failure(r) }
}

function groupsFrom(list) {
    var by = {}
    list.forEach(function(e) {
        if (!e || typeof e !== "object") return
        var g = e.group ? String(e.group) : UNGROUPED
        ;(by[g] = by[g] || []).push(member(e))
    })
    var names = Object.keys(by).filter(function(k) { return k !== UNGROUPED }).sort()
    if (by[UNGROUPED]) names.push(UNGROUPED)
    return names.map(function(k) { return { name: k, members: by[k] } })
}

var adapter = {
    id: "gatus",
    label: "Gatus",
    defaultInterval: 60,
    maxInstances: 1,
    secret: false,
    urlExample: "https://status.lan",
    fields: {},
    headers: [],
    groupsTitle: "Endpoints",

    poll: function(ctx, done) {
        ctx.get("/api/v1/endpoints/statuses?pageSize=1", function(err, data) {
            if (err) return done(err)
            if (!Array.isArray(data)) return done("that doesn't look like the Gatus API")
            var groups = groupsFrom(data)
            var checked = 0, up = 0
            groups.forEach(function(g) { g.members.forEach(function(m) {
                if (m.status !== Core.STATUS.LOADING) checked++
                if (m.status === Core.STATUS.OK) up++
            }) })
            done(null, {
                summary: [{ label: "Up", value: up + " / " + checked }],
                alerts: [],
                groups: groups,
            })
        })
    },
}
