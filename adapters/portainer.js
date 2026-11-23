.pragma library
.import "../core/Core.js" as Core

// Portainer (Docker environments). API key: My account → Access tokens.
// endpointId: Environments → click yours → the number in the URL.

// running → ok, unless Docker's healthcheck says unhealthy (warn).
// exited/dead → error. created/restarting/paused/removing → warn.
function containerStatus(c) {
    if (c.State === "running") return /\(unhealthy\)/.test(c.Status || "") ? Core.STATUS.WARN : Core.STATUS.OK
    if (c.State === "exited" || c.State === "dead") return Core.STATUS.ERROR
    return Core.STATUS.WARN
}

// Grouped by compose project, which is what a Portainer stack is. Unlabelled
// containers go in "Standalone", always last.
function containerGroups(list) {
    var by = {}
    list.forEach(function(c) {
        var project = (c.Labels && c.Labels["com.docker.compose.project"]) || ""
        var name = (c.Names && c.Names[0] ? c.Names[0] : c.Id || "?").replace(/^\//, "")
        ;(by[project] = by[project] || []).push({ name: name, status: containerStatus(c), detail: c.Status || c.State })
    })
    var groups = Object.keys(by).filter(function(k) { return k !== "" }).sort()
        .map(function(k) { return { name: k, members: by[k] } })
    if (by[""]) groups.push({ name: "Standalone", members: by[""] })
    return groups
}

var adapter = {
    id: "portainer",
    label: "Portainer",
    defaultInterval: 60,
    secret: true,
    urlExample: "https://portainer.lan:9443",
    fields: {
        endpointId: { required: true, type: "number", label: "Environment ID", placeholder: "1", hint: "Environments → click yours → the number in the page URL" },
    },
    secretLabel: "Access token",
    secretHint: "My account → Access tokens → Add access token",
    headers: ["X-API-Key: {secret}"],
    groupsTitle: "Containers",

    poll: function(ctx, done) {
        ctx.get("/api/endpoints/" + ctx.inst.endpointId + "/docker/containers/json?all=true", function(err, data) {
            if (err) return done(err)
            if (!Array.isArray(data)) return done("unexpected response from containers list")
            var groups = containerGroups(data)
            var running = data.filter(function(c) { return c.State === "running" }).length
            var stacks = groups.filter(function(g) { return g.name !== "Standalone" }).length
            done(null, {
                summary: [
                    { label: "Running", value: running + " / " + data.length },
                    { label: "Stacks", value: String(stacks) },
                ],
                alerts: [],
                groups: groups,
            })
        })
    },
}
