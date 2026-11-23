.pragma library
.import "../core/Core.js" as Core

// Proxmox VE. Token: Datacenter → Permissions → API Tokens. A read-only role
// (PVEAuditor) on / is enough.

// running → ok, running with a lock (backup/migrate/snapshot) or paused →
// warn, anything else (stopped) → error. Templates are skipped entirely.
function guestStatus(g) {
    if (g.lock) return Core.STATUS.WARN
    if (g.status === "running") return Core.STATUS.OK
    if (g.status === "paused") return Core.STATUS.WARN
    return Core.STATUS.ERROR
}

// Named pools first (biggest first), then the LXC / VM fallbacks. The `pool`
// field comes on /cluster/resources itself, so no per-pool requests.
function guestGroups(resources) {
    var pools = {}, lxc = [], vm = []
    resources.forEach(function(g) {
        if (g.template) return
        var m = { name: g.name || ("vmid " + g.vmid), status: guestStatus(g), detail: g.lock ? g.status + " (" + g.lock + ")" : g.status }
        if (g.pool) (pools[g.pool] = pools[g.pool] || []).push(m)
        else if (g.type === "lxc") lxc.push(m)
        else vm.push(m)
    })
    var groups = Object.keys(pools)
        .map(function(id) { return { name: id, members: pools[id] } })
        .sort(function(a, b) { return b.members.length - a.members.length || a.name.localeCompare(b.name) })
    if (lxc.length) groups.push({ name: "LXC", members: lxc })
    if (vm.length) groups.push({ name: "VM", members: vm })
    return groups
}

function nodeSummary(d) {
    var cpu = d.cpu || 0
    var mem = d.memory || {}, disk = d.rootfs || {}
    var memR = mem.total ? mem.used / mem.total : 0
    var diskR = disk.total ? disk.used / disk.total : 0
    return [
        { label: "CPU", value: Math.round(cpu * 100) + "%", ratio: cpu, tone: Core.ratioTone(cpu, 0.6, 0.8) },
        { label: "RAM", value: Core.fmtBytes(mem.used) + " / " + Core.fmtBytes(mem.total), ratio: memR, tone: Core.ratioTone(memR, 0.7, 0.85) },
        { label: "Disk", value: Core.fmtBytes(disk.used) + " / " + Core.fmtBytes(disk.total), ratio: diskR, tone: Core.ratioTone(diskR, 0.8, 0.9) },
        { label: "Up", value: Core.fmtUptime(d.uptime) },
    ]
}

var adapter = {
    id: "proxmox",
    label: "Proxmox",
    defaultInterval: 30,
    secret: true,
    urlExample: "https://pve.lan:8006",
    fields: {
        tokenId: { required: true, type: "string", label: "Token ID", placeholder: "monitor@pve!bar", hint: "user@realm!tokenname" },
        node: { required: true, type: "string", label: "Node", placeholder: "pve", hint: "The node name shown in the Proxmox sidebar" },
    },
    secretLabel: "Token secret",
    secretHint: "Datacenter → Permissions → API Tokens. Give it the PVEAuditor role on / (read-only).",
    headers: ["Authorization: PVEAPIToken={tokenId}={secret}"],
    groupsTitle: "Guests",

    poll: function(ctx, done) {
        Core.parallel(ctx, [
            "/api2/json/nodes/" + encodeURIComponent(ctx.inst.node) + "/status",
            "/api2/json/cluster/resources?type=vm",
        ], function(r) {
            if (r[0].error) return done(r[0].error)
            if (!r[0].data || !r[0].data.data) return done("unexpected response from node status")
            var groups = (!r[1].error && r[1].data && Array.isArray(r[1].data.data))
                ? guestGroups(r[1].data.data)
                : (ctx.previous ? ctx.previous.groups : [])   // keep last known guests on a partial failure
            done(null, { summary: nodeSummary(r[0].data.data), alerts: [], groups: groups })
        })
    },
}
