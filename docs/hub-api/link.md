# `/link`: signing a computer in from its local settings

`https://<hub>/link?v=1` is a page of the web app the hub serves (the same
open `web/` build as everywhere; `web/src/features/link/`). A computer's
local settings open it in a popup to add that computer to the account
(`docs/local-aggregator.md` §3.3–3.4). The contract has two sides: the
**opener** — the local page, on the computer's own origin (`http://127.0.0.1:8700`,
`http://192.168.1.5:8700`, …) — and the **popup** on the hub's web origin.
The hub itself takes no part beyond serving the page and the existing routes
the popup calls (`POST /v1/enrollments`, `GET /v1/enrollments/{token}`,
`POST /v1/chain`, the keyring and the mailbox — see `http.md`).

## What crosses, and what never does

- Passwords, Turnstile, recovery words, pairing codes: typed into the popup
  only, on the hub's origin. The opener and the local server never see them,
  nor any login or device session.
- The opener gets back one **RH1 enrollment code** (one machine, 10 minutes,
  useless without the machine's proof) by `postMessage`, and hands it to its
  own server (`POST /api/cloud/link/finish`). It never goes in a URL, and the
  hub only ever sees its token (the HMAC), as with `agent enroll`.
- The popup URL carries no data (`?v=1` only).

## Messages

All are plain objects with `v: 1` and a type `t`. Hex is lower-case.

| `t` | from → to | fields | `targetOrigin` |
|---|---|---|---|
| `rh-link/ready` | popup → opener | — | `"*"` (it carries nothing); repeated each second until a `request` arrives |
| `rh-link/request` | opener → popup | `nonce` (16 bytes), `machine {hostname, signKey, dhKey, enrolled: {accountFp, id} \| null}`, `aggregator {signKey, dhKey} \| null`, `aggregate` | the hub's web origin, fixed |
| `rh-link/code` | popup → opener | `nonce`, `code` (`RH1-…`; the opener reads `DR1-…` too), `email?` | `cb` |
| `rh-link/done` | popup → opener | `nonce`, `account`, `email`, `machine`, `aggregator: null` (until aggregators are admitted) | `cb` |
| `rh-link/cancel` | either way | `nonce` | the other side's origin |
| `rh-link/error` | either way | `nonce`, `code`, `message` | the other side's origin |

## Rules

- The opener answers only messages whose `event.source` is the window it
  opened **and** whose `event.origin` is the hub's web origin, and posts only
  to that origin.
- The popup takes the `request` only from `window.opener`, and remembers the
  origin the browser reports for it as **`cb`**; every later message goes to
  `cb` only, and only messages from the opener at `cb` with the request's
  `nonce` are taken. Unknown types and malformed messages are ignored.
- `cb` comes from `event.origin` only — never from the URL. The popup shows it
  on the consent page, with the machine's host name (for reference) and its
  **fingerprint**: the first 16 bytes of
  `SHA-256("rh/v1 machine fingerprint\0" ‖ signKey ‖ dhKey)` as 8 groups of 4
  hex digits, which the local settings show too.
- `cb` tiers: only this computer itself passes without a warning —
  `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`. Every other origin, the
  local network and Tailscale included (a private address, `fd00::/8`,
  `*.local` and 100.64/10 are whoever answers on the browser's network;
  `*.ts.net` is public through Funnel), gets a red warning and an extra
  "this is my own computer" checkbox, next to the fingerprint to compare. The
  hub's own host on any scheme or port, or anything that is not an http(s)
  origin, is refused. Known and deferred: another program on this computer's
  loopback is "local" too, and the opener can send a second `request` while
  the consent page is open.
- `machine.hostname` is for reference only: the popup drops control and
  bidirectional-override characters and `<>"'`, and shows at most 64
  characters.
- Before adding the machine the popup checks the enrollment proof **and** that
  its keys are the request's `signKey`/`dhKey`: a code that leaked to another
  machine adds nothing.
- `machine.enrolled` set: the computer is already a machine; the popup checks
  that its account key fingerprint (`accountFp`, 16 bytes) is this account's
  and that the chain lists `id` with exactly these keys, and refuses otherwise
  ("already in another account").
- `aggregator`: a second, limited device key pair from before chain v3
  (`docs/local-aggregator.md` §4). Gone: since chain v3 the computer controls
  the account's other devices with its one identity (S1-4), so the opener
  sends `aggregator: null` and the popup sends `aggregator: null` in `done`;
  an older opener's keys are read and ignored.
- The consent page shows 「可管理账号」 as a switch, off by default; for a
  computer that runs AI — every local install — it stays off, with the reason
  beside it (review D1), and the popup adds it as `[AddDevice3{host, admin:
  false}, KeyEpochs]` (v2: `[AddMachine, KeyEpochs]`). After handing the
  computer its own content key, the popup waits up to 20 seconds for its
  device role to sign in at the hub (`POST /v1/session`) and seals it the
  content keys of the hosts whose accept policy admits it (mailbox purpose 5);
  whatever is still missing the computer asks for itself (purpose 4), and an
  online admin answers with host keys only. No other chain entry is written.
- Neither page sets `Cross-Origin-Opener-Policy: same-origin` (it would cut
  `window.opener`); the hub's tests hold it to that.
