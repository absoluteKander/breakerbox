// Loads the plugin's `.pragma library` JS files under node, resolving their
// `.import "x.js" as Name` lines the same way QML does (relative to the file).
const fs = require("fs"), path = require("path"), vm = require("vm")
const cache = {}
function load(file) {
    file = path.resolve(file)
    if (cache[file]) return cache[file]
    const src = fs.readFileSync(file, "utf8")
    const ctx = { console, JSON, Math, Date, encodeURIComponent, parseInt, Number, String, Array, Object, RegExp }
    const body = src.split("\n").map(line => {
        if (/^\.pragma\s+library/.test(line)) return ""
        const m = /^\.import\s+"([^"]+)"\s+as\s+(\w+)/.exec(line)
        if (m) { ctx[m[2]] = load(path.join(path.dirname(file), m[1])); return "" }
        return line
    }).join("\n")
    vm.createContext(ctx)
    vm.runInContext(body, ctx, { filename: file })
    return (cache[file] = ctx)
}
module.exports = load
