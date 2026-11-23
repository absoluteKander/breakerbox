# Security methodology

How Breaker Box's security claims are checked, not just made. The method
comes from [Candor](https://github.com/absoluteKander/Candor)'s, cut down to
what a status widget actually touches: API keys, TLS trust, your config
file, and text that arrives from your servers.

## Check the code, not the comment

A comment, a README sentence or this file can be wrong, because code changes
and prose doesn't always change with it. Before relying on a claim about
what the code does, check it against the current source. Where it can be
checked by experiment, do that instead of reasoning about it: a throwaway
QML file in `qs -p`, a local `openssl s_server`, a listener on a spare port,
or the real tool (`curl`, `secret-tool`, `openssl`) run the way the plugin
runs it.

Example: nothing in the code said server-supplied names were rendered as
HTML. Qt's documentation says `Text` defaults to `AutoText`, but the cost of
that wasn't clear until a two-line test window rendered `<img src=…>` and a
local listener received the request.

## What's treated as hostile

- **Everything a server returns.** Names, statuses, alert text and error
  bodies from Proxmox, Portainer, TrueNAS and Uptime Kuma. A box on a
  homelab gets compromised, misconfigured, or answered by something else on
  the LAN. "It's my own server" is not evidence that its output is safe.
- **The certificate a server offers.** Trust comes only from a pin you
  checked. The fingerprint you check and the key you pin must come from the
  same connection.
- **`config.json`.** It's hand-editable, so every field is validated
  (`Core.parseConfig`), and header values with CR/LF are refused.
- **Partial failure.** Any multi-step change (keyring, then config) has to
  leave the old state working if it stops halfway: a full disk, a locked
  keyring, the shell exiting.

## Every real fix gets a permanent test

Regression tests live in `tests/run.js`. The ones guarding past bugs:

| Test | Guards |
|---|---|
| `a new key never overwrites an entry the config still uses` | Editing a service with a new key used to overwrite the keyring entry before the config was written, so a failed write sent the new key to the old URL (review of 0.1.0). |
| `every Text element renders plain text, never HTML` | Server-supplied names were rendered as HTML, and `<img src>` made the shell fetch a URL. A source tripwire: every `Text` block must say `textFormat: Text.PlainText`. It also fails if it stops finding `Text` elements. |
| `renderHeaders` CR/LF tests | Header injection from a config value. |

Some fixes live in QML or shell and can't be unit-tested from Node. Those
are checked live (below) and the result is recorded here:

- **Key rotation, failure path:** config folder made read-only mid-save on
  demo data. The dialog showed the error, the config still pointed at the
  old entry with the old key, and the new entry was deleted.
- **`breakerbox-secret pin`:** run against a local self-signed server; the
  printed fingerprint and pin both match the certificate file.
- **Hostile names:** `<img src=…><b>…</b>` as a compose project and a Kuma
  monitor name in a copy of the fake lab, with a listener on the image URL.
  The text shows literally, nothing is requested, and the long name is cut
  with "…" inside the card.

## A passing test has to prove it can fail

Before trusting a new test, revert the fix in a scratch copy and confirm the
test fails, then throw the copy away. Both tests in the table above were
checked this way. A failing test can also mean the *assertion* is wrong, not
the code; find out which before changing either.

## Test the class, not the example

When a bug is found, look for the same mistake elsewhere before calling it
fixed. The 0.1.0 review found three; the search that followed found the
HTML-rendering bug, which nobody had reported.

- Wrong order of writes → every place that writes more than one thing.
- Two sources for one trust decision → every place a pin or fingerprint is
  derived.
- A failure reported as success → every `_run(...)` callback must read its
  exit code.

## Never weaken security for testability

No test mode, no skip-verify flag, no environment variable that loosens TLS,
pinning or secret handling, even for the screenshot tooling. Hard-to-test
logic gets pulled out into a pure function in `core/Core.js` and tested
there (as `refForNewSecret` was). The real path gets tested live against
fakes that it talks to for real (`tests/demo/mocklab.py`), never against a
bypass.

## Live testing never uses your real setup

- Use the fake lab (`tests/demo/mocklab.py`) and `demo-*` keyring entries.
  Never use real keys, and never use real addresses in anything that might
  be published.
- Back up `~/.config/breakerbox/config.json` *before* arming any cleanup
  trap. Compare it byte-for-byte on exit.
- Afterwards, remove the demo keyring entries, scratch files and any ports
  or containers you started.

## Before each release

1. `node tests/run.js` passes, and `omarchy plugin validate .` passes.
2. Do a top-down pass over every claim in the README's Secrets and TLS
   sections against the current code, not only the parts that changed.
3. Add an entry to the log below.

## Audit log

- **2026-11-23 (0.1.1).** Marketplace review of 0.1.0 found: key
  overwritten before the config write; `pin` used two TLS connections;
  `screenshots.sh` armed cleanup before its backup (a failed backup deleted
  the real config); a failed keyring delete was reported as success. All
  fixed. A class search then found that server-supplied names rendered as
  HTML (remote image fetch confirmed live). Fixed by making every `Text`
  plain text, with a tripwire test. Long member names now elide inside the
  card.
