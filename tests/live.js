// node tests/live.js [config.json] — runs every configured instance once
// through the same Core.curlArgs / renderHeaders / stdin path the plugin
// uses, and prints statuses. Read-only GETs. Never prints secrets.
const { spawnSync } = require("child_process"), fs = require("fs"), path = require("path")
const load = require("./load")
const root = path.join(__dirname, "..")
const Core = load(path.join(root, "core/Core.js"))
const A = load(path.join(root, "adapters/index.js")).all
const cfgPath = process.argv[2] || path.join(process.env.XDG_CONFIG_HOME || process.env.HOME + "/.config", "breakerbox/config.json")
const cfg = Core.parseConfig(fs.readFileSync(cfgPath, "utf8"), A)
cfg.errors.forEach(e => console.log("config: " + e))

function secret(ref) {
    const r = Core.parseSecretRef(ref)
    const cmd = r.kind === "keyring" ? ["secret-tool", "lookup", "service", "breakerbox", "ref", r.path] : ["pass", "show", r.path]
    const p = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" })
    return p.status === 0 ? p.stdout.replace(/\r?\n$/, "").split("\n")[0] : null
}
for (const inst of cfg.instances) {
    const a = A[inst.type]
    const s = inst.secret ? secret(inst.secret) : ""
    if (s === null) { console.log(inst.name + ": NO SECRET"); continue }
    const headers = Core.renderHeaders(a.headers, inst, s)
    const t0 = Date.now()
    a.poll({ inst, previous: null, get(p, cb) {
        const args = Core.curlArgs(inst.url + p, { hasHeaders: headers.length > 0, pin: inst.pin })
        const r = spawnSync(args[0], args.slice(1), { input: headers.join("\n") + "\n", encoding: "utf8" })
        const res = Core.parseCurlResult(r.status, r.stdout)
        cb(res.error, res.data)
    }, rpc(calls, cb) {
        const req = { login: a.rpcLogin ? Core.renderTemplate(a.rpcLogin, inst, s) : null, calls }
        const r = spawnSync("python3", ["-I", path.join(root, "bin/wsrpc.py"), Core.wsUrl(inst.url, a.rpcPath || "/"), inst.pin || ""], { input: JSON.stringify(req), encoding: "utf8" })
        const res = Core.parseRpcResult(r.status, r.stdout)
        cb(res.error, res.results)
    } }, (err, snap) => {
        if (err) return console.log(inst.name + ": ERROR " + err)
        const st = Core.snapshotStatus(snap)
        console.log(`${inst.name} [${a.label}] ${st} (${Date.now() - t0}ms)`)
        snap.summary.forEach(x => console.log(`   ${x.label}: ${x.value}${x.tone ? " (" + x.tone + ")" : ""}`))
        snap.alerts.forEach(x => console.log(`   ! ${x.status}: ${x.text}`))
        snap.groups.forEach(g => console.log(`   ${g.name}: ${Core.groupStatus(g)} ${g.members.filter(m => m.status === "ok").length}/${g.members.length}` +
            g.members.filter(m => m.status !== "ok").map(m => `  [${m.name}: ${m.detail}]`).join("")))
    })
}
