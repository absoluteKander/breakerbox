pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io
import "core/Core.js" as Core
import "adapters/index.js" as Adapters

// The plugin's single source of truth: reads the config, schedules polls,
// resolves secrets, runs curl, applies the debounce, and publishes one
// reactive `entries` map that every widget and panel binds to.
//
// Registered as a singleton in qmldir, so there is exactly one of these per
// shell no matter how many monitors (and so BarWidgets) there are — one
// poll loop, never one per screen.
Singleton {
    id: root

    readonly property string configHome: Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")
    // For display: the same path with the home directory as ~ (shorter, and
    // keeps usernames out of screenshots).
    readonly property string configPathShort: {
        var home = Quickshell.env("HOME") || ""
        return home && root.configPath.indexOf(home + "/") === 0 ? "~" + root.configPath.slice(home.length) : root.configPath
    }
    readonly property string configPath: Quickshell.env("BREAKERBOX_CONFIG") || (configHome + "/breakerbox/config.json")

    // ── Published state (reactive) ───────────────────────────────────────
    property var instances: []          // validated config, in config order
    property var configErrors: []       // human-readable, one per bad entry
    property bool configMissing: false
    property bool configLoaded: false
    property int failThreshold: 2
    property var rawConfig: ({ failThreshold: 2, instances: [] })   // the file as parsed JSON, for the setup UI
    property bool configBroken: false   // file exists but isn't valid JSON: the UI must not overwrite it
    property var entries: ({})          // name -> Core entry; replaced, never mutated
    property double now: Date.now()     // ticks once a second for "x ago" labels

    readonly property var adapters: Adapters.all
    readonly property var adapterOrder: Adapters.order
    readonly property string overall: root.instances.length === 0
        ? (root.configErrors.length ? Core.STATUS.ERROR : Core.STATUS.LOADING)
        : Core.overall(root.entries)
    // Bar tooltip and IPC status: the same line the panel header shows.
    readonly property string summary: "Breaker Box: " + (root.configErrors.length && root.instances.length === 0
        ? "config problem — open it for details"
        : Core.troubleLine(root.services, root.entries))

    // [{ type, label, status, instances: [inst] }] for every service type
    // that has at least one configured instance.
    readonly property var services: {
        var out = []
        var entries = root.entries
        for (var i = 0; i < Adapters.order.length; i++) {
            var type = Adapters.order[i]
            var list = root.instances.filter(function(inst) { return inst.type === type })
            if (!list.length) continue
            out.push({
                type: type,
                label: Adapters.all[type].shortLabel || Adapters.all[type].label,
                status: Core.worst(list.map(function(inst) { return entries[inst.name] ? entries[inst.name].status : Core.STATUS.LOADING })),
                instances: list,
            })
        }
        return out
    }

    // The service's own web UI, in the browser.
    function openInstance(inst) {
        if (!inst) return
        var a = Adapters.all[inst.type]
        var url = a && typeof a.openUrl === "function" ? a.openUrl(inst) : inst.url
        if (/^https?:\/\//.test(url)) Quickshell.execDetached(["xdg-open", url])
    }

    function refresh() {
        for (var k in root._rt) root._rt[k].due = 0
        root.tick()
    }

    // ── Private bookkeeping (deliberately not reactive) ──────────────────
    property var _rt: ({})              // name -> { due, busy, startedAt, token }
    property var _secrets: ({})         // secret ref -> value, in memory only
    property var _secretWaiters: ({})   // secret ref -> [callbacks]
    property int _gen: 0                // bumped on every config load

    readonly property int _pollWatchdogMs: 60000
    readonly property string _wsrpcPath: decodeURIComponent(String(Qt.resolvedUrl("bin/wsrpc.py")).replace(/^file:\/\//, ""))
    readonly property int _failRetryS: 15

    function _log(msg) { console.warn("[breakerbox] " + msg) }

    function applyConfig(text) {
        var parsed = Core.parseConfig(text, Adapters.all)
        var raw = null
        try { raw = JSON.parse(text) } catch (e) { raw = null }
        root.configBroken = !(raw && typeof raw === "object" && !Array.isArray(raw))
        root.rawConfig = root.configBroken ? ({ failThreshold: 2, instances: [] })
            : (Array.isArray(raw.instances) ? raw : Object.assign({}, raw, { instances: [] }))
        parsed.errors.forEach(function(e) { root._log("config: " + e) })

        root._gen++
        root._secrets = ({})
        root._secretWaiters = ({})
        var rt = {}
        var next = {}
        parsed.instances.forEach(function(inst) {
            // Same name + type keeps its last state, so editing the config
            // doesn't flash everything back to grey.
            var old = root.entries[inst.name]
            next[inst.name] = old && old.type === inst.type ? old : Core.newEntry(inst)
            rt[inst.name] = { due: 0, busy: false, startedAt: 0, token: null }
        })
        root._rt = rt
        root.failThreshold = parsed.failThreshold
        root.configErrors = parsed.errors
        root.instances = parsed.instances
        root.entries = next
        root.configMissing = false
        root.configLoaded = true
        root.tick()
    }

    function tick() {
        var now = Date.now()
        root.now = now
        for (var i = 0; i < root.instances.length; i++) {
            var inst = root.instances[i]
            var rt = root._rt[inst.name]
            if (!rt) continue
            if (rt.busy) {
                if (now - rt.startedAt > root._pollWatchdogMs)
                    root._finish(inst, root._gen, rt.token, "poll never finished", null)
                continue
            }
            if (now >= rt.due) root._poll(inst)
        }
    }

    function _poll(inst) {
        var gen = root._gen
        var rt = root._rt[inst.name]
        var token = {}
        rt.busy = true
        rt.startedAt = Date.now()
        rt.token = token

        var finished = false
        function finish(err, snap) {
            if (finished) return
            finished = true
            root._finish(inst, gen, token, err, snap)
        }

        root._withSecret(inst, function(err, secret) {
            if (gen !== root._gen) return
            if (err) return finish(err)
            var prev = root.entries[inst.name]
            root._runAdapter(inst, secret, prev ? prev.snapshot : null, function(err, snap) { finish(err, snap) })
        })
    }

    // One poll of one instance with a known secret. cb(err, snap, info) is
    // called exactly once; info.certProblem is set when curl rejected the cert.
    function _runAdapter(inst, secret, previous, cb) {
        var adapter = Adapters.all[inst.type]
        var done = false, certProblem = false
        function finish(err, snap) {
            if (done) return
            done = true
            cb(err, snap, { certProblem: certProblem })
        }
        var headers = Core.renderHeaders(adapter.headers || [], inst, secret)
        if (headers === null) return finish("a config value contains a line break")
        var ctx = {
            inst: inst,
            previous: previous,
            get: function(path, getCb) {
                root._curl(inst.url + path, headers, inst.pin, function(res) {
                    if (res.auth && inst.secret) delete root._secrets[inst.secret]
                    if (res.exit && Core.CERT_EXITS[res.exit]) certProblem = true
                    getCb(res.error, res.data)
                })
            },
            // One WebSocket session: log in with the adapter's rpcLogin, then
            // run `calls` ([[method, params], …]). cb(err, [{ error, data }])
            rpc: function(calls, rpcCb) {
                var req = { login: adapter.rpcLogin ? Core.renderTemplate(adapter.rpcLogin, inst, secret) : null, calls: calls }
                root._run(["python3", "-I", root._wsrpcPath, Core.wsUrl(inst.url, adapter.rpcPath || "/"), inst.pin || ""],
                    JSON.stringify(req), function(code, out) {
                        var res = Core.parseRpcResult(code, out)
                        if (res.auth && inst.secret) delete root._secrets[inst.secret]
                        if (res.certProblem) certProblem = true
                        rpcCb(res.error, res.results)
                    })
            },
        }
        try { adapter.poll(ctx, finish) }
        catch (e) { finish("adapter error: " + e) }
    }

    function _finish(inst, gen, token, err, snap) {
        if (gen !== root._gen) return
        var rt = root._rt[inst.name]
        if (!rt || rt.token !== token) return
        var now = Date.now()
        rt.busy = false
        rt.token = null
        // A failing instance is retried sooner, so the debounce settles in
        // seconds rather than a whole poll interval.
        rt.due = now + 1000 * (err ? Math.min(inst.interval, root._failRetryS) : inst.interval)

        var prev = root.entries[inst.name] || Core.newEntry(inst)
        var next = err ? Core.applyFailure(prev, err, root.failThreshold, now) : Core.applySuccess(prev, snap, now)
        if (err && (next.failCount === 1 || next.status !== prev.status)) root._log(inst.name + ": " + err)
        if (!err && prev.failCount > 0) root._log(inst.name + ": reachable again")

        var copy = {}
        for (var k in root.entries) copy[k] = root.entries[k]
        copy[inst.name] = next
        root.entries = copy
    }

    // ── Secrets ──────────────────────────────────────────────────────────
    // Looked up on first use and after any 401/403, then held in memory
    // only. Never written anywhere, never put in argv, never logged.
    function _withSecret(inst, cb) {
        if (!inst.secret) return cb(null, "")
        var ref = inst.secret
        if (root._secrets[ref] !== undefined) return cb(null, root._secrets[ref])
        var r = Core.parseSecretRef(ref)
        if (!r) return cb("invalid secret reference")
        if (root._secretWaiters[ref]) { root._secretWaiters[ref].push(cb); return }
        root._secretWaiters[ref] = [cb]
        var cmd = r.kind === "keyring"
            ? ["secret-tool", "lookup", "service", "breakerbox", "ref", r.path]
            : ["pass", "show", r.path]
        var gen = root._gen
        root._run(cmd, "", function(code, out) {
            if (gen !== root._gen) return
            var value = String(out || "")
            value = r.kind === "pass" ? value.split("\n")[0] : value.replace(/\r?\n$/, "")
            var err = null
            if (code !== 0 || value === "") {
                err = r.kind === "keyring"
                    ? "no secret in keyring for " + ref + " — run: breakerbox-secret set " + r.path
                    : "pass show " + r.path + " failed"
            } else {
                root._secrets[ref] = value
            }
            var waiters = root._secretWaiters[ref] || []
            delete root._secretWaiters[ref]
            waiters.forEach(function(w) { w(err, err ? "" : value) })
        })
    }

    // ── Setup UI operations ──────────────────────────────────────────────
    // Used by ManageDialog.qml. Each takes a callback; none of them ever logs or
    // returns a secret.

    // Poll a not-yet-saved instance once. `secretValue` is what was typed;
    // empty means "use the saved one". cb(err, message, certProblem)
    function testInstance(raw, secretValue, cb) {
        var probe = Object.assign({}, raw)
        var needsSecret = Adapters.all[raw.type] && Adapters.all[raw.type].secret
        if (needsSecret && !probe.secret) probe.secret = "keyring:test-probe"   // placeholder so validation passes
        var parsed = Core.parseConfig(JSON.stringify({ instances: [probe] }), Adapters.all)
        if (parsed.errors.length) return cb(parsed.errors[0].replace(/^("[^"]*"|instance 1): /, ""), "", false)
        var inst = parsed.instances[0]
        var go = function(secret) {
            root._runAdapter(inst, secret, null, function(err, snap, info) {
                cb(err, err ? "" : Core.describeSnapshot(snap), !!(info && info.certProblem))
            })
        }
        if (secretValue) return go(secretValue)
        if (!Adapters.all[inst.type].secret) return go("")
        if (!raw.secret) return cb("enter the " + (Adapters.all[inst.type].secretLabel || "secret").toLowerCase(), "", false)
        if (!Core.savedKeyAllowedFor(root.rawConfig, raw.secret, raw.url)) return cb(Core.RETYPE_KEY_TEXT, "", false)
        root._withSecret({ secret: raw.secret }, function(err, secret) {
            if (err) return cb("no saved key found — enter it again", "", false)
            go(secret)
        })
    }

    // Store the secret (if one was typed) and write the config.
    // cb(err) — err is null on success.
    function saveInstance(raw, secretValue, originalName, cb) {
        if (root.configBroken) return cb("config.json has a syntax error — fix it by hand first")
        var adapter = Adapters.all[raw.type]
        var r = Object.assign({}, raw)
        if (adapter && adapter.secret && !r.secret) r.secret = Core.freshSecretRef(root.rawConfig, r.name)
        var errors = Core.validateCandidate(root.rawConfig, r, originalName, Adapters.all)
        if (errors.length) return cb(errors[0])
        if (adapter && adapter.secret && !secretValue) {
            // Editing without retyping the key: it must already exist.
            var original = (root.rawConfig.instances || []).filter(function(x) { return x && x.name === originalName })[0]
            if (!original || original.secret !== r.secret) return cb("enter the " + (adapter.secretLabel || "secret").toLowerCase())
            if (!Core.savedKeyAllowedFor(root.rawConfig, r.secret, r.url)) return cb(Core.RETYPE_KEY_TEXT)
        }
        if (!secretValue) return root._writeConfig(Core.upsertInstance(root.rawConfig, r, originalName), cb)
        if (!Core.parseSecretRef(r.secret) || Core.parseSecretRef(r.secret).kind !== "keyring")
            return cb("this service uses " + r.secret + " — update it with pass, then leave the key blank here")
        // A new key goes into a fresh entry; the config is switched over to it
        // and only then is the old entry removed. If anything fails midway, the
        // old URL keeps the old key, never the new one.
        var oldRef = r.secret
        r.secret = Core.refForNewSecret(root.rawConfig, r)
        var cfg = Core.upsertInstance(root.rawConfig, r, originalName)
        var newPath = Core.parseSecretRef(r.secret).path
        root._storeSecret(newPath, secretValue, function(err) {
            if (err) return cb(err)
            root._writeConfig(cfg, function(werr) {
                if (werr) return root._clearSecret(newPath, function() { cb(werr) })
                delete root._secrets[oldRef]
                if (oldRef === r.secret || Core.secretRefInUse(cfg, oldRef)) return cb(null)
                root._clearSecret(Core.parseSecretRef(oldRef).path, function(cerr) { cb(null, cerr) })
            })
        })
    }

    // cb(warning) — warning is null when the entry is gone.
    function _clearSecret(path, cb) {
        root._run(["secret-tool", "clear", "service", "breakerbox", "ref", path], "", function(code) {
            cb(code === 0 ? null : "couldn't delete the old keyring entry " + path + " — run: breakerbox-secret delete " + path)
        })
    }

    // Remove from config; delete its keyring entry if nothing else uses it.
    function removeInstance(name, cb) {
        if (root.configBroken) return cb("config.json has a syntax error — fix it by hand first")
        var victim = (root.rawConfig.instances || []).filter(function(x) { return x && x.name === name })[0]
        if (!victim) return cb("not found")
        var cfg = Core.removeInstance(root.rawConfig, name)
        root._writeConfig(cfg, function(err) {
            if (err) return cb(err)
            var ref = Core.parseSecretRef(victim.secret)
            delete root._secrets[victim.secret]
            if (ref && ref.kind === "keyring" && !Core.secretRefInUse(cfg, victim.secret))
                root._clearSecret(ref.path, function(warning) { cb(null, warning) })
            else cb(null)
        })
    }

    // Read the cert a server presents. cb(err, { subject, expires, fingerprint, pin })
    function fetchCert(url, cb) {
        var hp = Core.hostPort(url)
        if (!hp) return cb("needs an https:// URL")
        var script = 'c=$(timeout 8 openssl s_client -connect "$1:$2" -servername "$1" </dev/null 2>/dev/null | openssl x509 2>/dev/null) || exit 3\n'
            + 'printf "%s\\n" "$c" | openssl x509 -noout -subject -enddate -fingerprint -sha256 || exit 4\n'
            + 'printf "pin=sha256//"; printf "%s\\n" "$c" | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64\n'
        root._run(["sh", "-c", script, "sh", hp.host, String(hp.port)], "", function(code, out) {
            if (code !== 0) return cb("couldn't read a certificate from " + hp.host + ":" + hp.port)
            var info = {}
            String(out).split("\n").forEach(function(line) {
                var m
                if ((m = /^subject=\s*(.*)$/.exec(line))) info.subject = m[1]
                else if ((m = /^notAfter=(.*)$/.exec(line))) info.expires = m[1]
                else if ((m = /Fingerprint=([0-9A-F:]+)$/i.exec(line))) info.fingerprint = m[1]
                else if ((m = /^pin=(sha256\/\/[A-Za-z0-9+\/]{43}=)$/.exec(line))) info.pin = m[1]
            })
            if (!info.pin || !info.fingerprint) return cb("couldn't read a certificate from " + hp.host + ":" + hp.port)
            cb(null, info)
        })
    }

    // Atomic write, owner-only, creating the directory if needed. Paths go
    // in as positional args, never spliced into the script.
    function _writeConfig(cfg, cb) {
        var dir = root.configPath.replace(/\/[^\/]*$/, "")
        var text = JSON.stringify(cfg, null, 2) + "\n"
        root._run(["sh", "-c", 'umask 077 && mkdir -p "$1" && cat > "$2.tmp" && mv -f "$2.tmp" "$2"', "sh", dir, root.configPath], text, function(code) {
            if (code !== 0) return cb("couldn't write " + root.configPath)
            root.configFile.reload()
            cb(null)
        })
    }

    function _storeSecret(path, value, cb) {
        root._run(["secret-tool", "store", "--label=Breaker Box: " + path, "service", "breakerbox", "ref", path], value, function(code) {
            cb(code === 0 ? null : "couldn't save to the keyring (is it unlocked?)")
        })
    }

    // ── Processes ────────────────────────────────────────────────────────

    function _curl(url, headers, pin, cb) {
        var args = Core.curlArgs(url, { hasHeaders: headers.length > 0, pin: pin })
        root._run(args, headers.length ? headers.join("\n") + "\n" : "", function(code, out) {
            cb(Core.parseCurlResult(code, out))
        })
    }

    function _run(cmd, input, cb) {
        var p = root.procComponent.createObject(root, { command: cmd, input: input, onDone: cb })
        if (!p) { cb(-1, ""); return }
        p.running = true
    }

    property Component procComponent: Component {
        Process {
            id: proc
            property string input: ""
            property var onDone: null
            property int exitCode: -1
            property bool exitedSeen: false
            property bool stdoutSeen: false

            stdinEnabled: input !== ""
            stdout: StdioCollector {
                id: collector
                onStreamFinished: { proc.stdoutSeen = true; proc.settle() }
            }

            onStarted: {
                if (proc.input === "") return
                proc.write(proc.input)
                proc.stdinEnabled = false   // closes stdin so curl stops reading headers
            }
            onExited: function(code, status) {
                proc.exitCode = code
                proc.exitedSeen = true
                proc.settle()
            }

            function settle() {
                if (!proc.exitedSeen || !proc.stdoutSeen || !proc.onDone) return
                var cb = proc.onDone
                proc.onDone = null
                proc.input = ""
                cb(proc.exitCode, collector.text)
                proc.destroy()
            }

            // Backstop for a process that never starts or never ends. curl has
            // its own --max-time well under this.
            property Timer guard: Timer {
                interval: 20000
                running: true
                onTriggered: {
                    if (!proc.onDone) return
                    var cb = proc.onDone
                    proc.onDone = null
                    if (proc.running) proc.running = false
                    cb(-1, "")
                    proc.destroy()
                }
            }
        }
    }

    // ── Config file + scheduler ──────────────────────────────────────────

    property FileView configFile: FileView {
        path: root.configPath
        watchChanges: true
        printErrors: false
        onLoaded: root.applyConfig(text())
        onFileChanged: reload()
        onLoadFailed: function(error) {
            root._gen++
            root.instances = []
            root.entries = ({})
            root._rt = ({})
            root.configErrors = []
            root.rawConfig = ({ failThreshold: 2, instances: [] })
            root.configBroken = false
            root.configMissing = true
            root.configLoaded = true
        }
    }

    property Timer ticker: Timer {
        interval: 1000
        repeat: true
        running: true
        onTriggered: {
            root.tick()
            // FileView can't watch a file that doesn't exist yet.
            if (root.configMissing && Math.floor(root.now / 1000) % 10 === 0) root.configFile.reload()
        }
    }
}
