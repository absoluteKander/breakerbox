# Writing an adapter

An adapter teaches Breaker Box one kind of service. It is one
`.pragma library` JS file in `adapters/`, plus one line in
`adapters/index.js`. No QML: every service is drawn by the same generic
`InstanceView`.

## The contract

```js
.pragma library
.import "../core/Core.js" as Core

var adapter = {
    id: "example",            // the config "type"; must equal its key in index.js
    label: "Example",         // tab label
    defaultInterval: 60,      // seconds, >= 10; config "interval" overrides
    secret: true,             // does this service need a secret?
    urlExample: "https://example.lan",          // placeholder in the setup form
    fields: {                 // extra config fields, validated before poll() ever runs
        siteId: { required: true, type: "string", label: "Site ID", placeholder: "default",
                  hint: "Settings → Sites → the ID column" },   // label/hint drive the setup form
    },
    secretLabel: "API token",                    // label over the password field
    secretHint: "Profile → API tokens → New",    // where to get it
    headers: ["Authorization: Bearer {secret}"],   // {secret} and {anyField} are filled in
    groupsTitle: "Services",  // heading over the groups box
    shortLabel: "Ex",         // optional: tab label when `label` is long
    maxInstances: 1,          // optional: lower than the global 3-per-type limit
    openUrl: function(inst) { return inst.url + "/dashboard" },   // optional: "Open ↗" target

    poll: function(ctx, done) { ... },
}
```

`poll(ctx, done)`:

- `ctx.inst`: this instance's validated config (url, name, your fields;
  the secret *reference*, never the secret).
- `ctx.get(path, cb)`: GET `inst.url + path` and parse the JSON;
  `cb(error, data)`. Headers, TLS pinning, timeouts and auth-retry are
  handled for you.
- `ctx.previous`: the last good snapshot, or null. Use it to keep secondary
  data when only a secondary request fails.
- `Core.parallel(ctx, [paths], cb)`: several GETs at once.
- `ctx.rpc([[method, params], …], cb)`: for WebSocket-only JSON-RPC APIs.
  One session: logs in with your `rpcLogin` template (`{secret}` and
  `{field}` filled in), runs the calls in order, and gives
  `cb(error, [{ error, data }])`. Set `rpcPath` (e.g. `"/api/current"`)
  and leave `headers` empty. See `adapters/truenas.js`.
- Call `done(error)` if the service is unreachable or the main request
  failed, or `done(null, snapshot)` otherwise. Call it exactly once; extra
  calls are ignored, and a poll that never calls it times out after 60s.

## Snapshot

```js
{
  summary: [{ label, value, ratio?, tone? }],   // context: CPU, disk, counts
  alerts:  [{ status, text }],                   // things that need attention
  groups:  [{ name, members: [{ name, status, detail }] }],
}
```

`status` is one of `Core.STATUS.OK / WARN / ERROR`, or `PAUSED` for
something deliberately switched off (maintenance). Paused shows grey and
never colours a row.

**Only `groups` members and `alerts` count toward the dot.** Summary stats
are context: `tone` colours their bar but never turns anything red. A busy
CPU is not an outage.

## Rules

0. **Roll items up into groups.** Never return one group per item when
   the service has a natural grouping (stacks, pools, status-page
   groups). The panel shows at most 12 rows per instance and moves broken
   ones to the top, but an adapter that needs the "+N more" line all the
   time is the wrong shape for this plugin.
1. **Status only.** Answer "is it OK?". If you need a table, link to the
   service's own UI instead.
2. **Don't decide reachability.** Report errors with `done(err)`. The core
   owns the debounce, retries and the last-known-good display.
3. **Trust the service's own rollup** when it has one (TrueNAS `app.state`,
   Docker health). Don't recompute it from lower-level data.
4. **Never touch secrets.** Put `{secret}` in `headers` and stop there.
5. **Read-only.** GET requests only; the token docs in your file header should
   say which read-only role is enough.
6. **Add tests** in `tests/run.js` with fixtures shaped like real responses.
