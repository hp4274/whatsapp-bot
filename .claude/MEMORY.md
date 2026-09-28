# Memory

Facts and decisions worth remembering about this project. Not a changelog —
see `STATUS.md` for that. This is the "why", and the things that will bite you
again if forgotten.

## What this project is

A tool to send WhatsApp messages in bulk from a browser UI. Two builds exist:
the original Python/Tkinter desktop app (archived in `backup/`) and the
current Express + Angular web app (`server/` + `web/`), which is what's active
now. `README.md` at the root documents the web build only.

## Non-negotiable rules carried through every rewrite

These held true in the Python app and were deliberately preserved in the web
port — don't relax them without a reason:

- **SANDBOX is never SENT.** The sandbox transport writes to a local file and
  reports a distinct `SANDBOX` status. It must never be mistaken for a real
  delivery, in the UI, the logs, or the daily-limit counter (SANDBOX sends
  don't count against the daily cap — nothing left the machine).
- **Status can only go forward.** `QUEUED → SENDING → SENT → DELIVERED → READ`,
  with `FAILED` reachable from most states. A late "delivered" webhook must
  never downgrade a message that's already "read". This is enforced by a rank
  table, not by hoping events arrive in order.
- **A message dispatched is not retried, even if the transport can't prove
  it.** whatsapp-web.js sometimes sends successfully but returns no message
  id. The fix: before treating that as a failure, check the library's own
  `message_create` event to see if it actually went out. Retrying here means
  the recipient gets the message twice. This bug was found and fixed once in
  Python, then had to be re-verified after the port to Express — same rule,
  same risk.
- **Access token never reaches the browser.** `GET /api/config` returns the
  literal string `__set__` for a token that's set, never the value. Saving
  config back with `accessToken: "__set__"` leaves the stored token untouched.
- **One number, one message, when asked.** The "one message per number"
  option collapses duplicate contacts within a batch AND skips numbers
  already messaged in an earlier run (checked against the database, not
  just the current queue).

## Environment / tooling facts that cost time to learn

- **`whatsapp-web.js` is CommonJS.** `import { Client, LocalAuth } from
  'whatsapp-web.js'` silently drops `LocalAuth` — Node's static ESM-interop
  lexer only picks up `Client`. Fix: `import pkg from 'whatsapp-web.js'; const
  { Client, LocalAuth } = pkg.default ?? pkg;`. If a new named import from this
  package ever comes back `undefined`, this is why.
- **`node --watch` crashes hard on an uncaught exception**, tearing down the
  whole process mid-request. From the browser this looks exactly like
  `ECONNRESET` / `502 Bad Gateway` through the Vite dev proxy, not like a
  clean error. If that shows up, suspect an unhandled throw in the backend,
  not the proxy config.
- **`node:sqlite`** (built into Node 22.5+) is what the backend uses — no
  native module, no `better-sqlite3` install step. Needs a reasonably recent
  Node; this machine runs Node 26.
- **customtkinter 6 dropped its Pillow dependency.** Its `CTkImage` silently
  fails without Pillow installed. The Python app's QR code rendering was
  switched to plain `tk.PhotoImage`, which needs nothing extra — this doesn't
  matter for the web app but is why the old code looks the way it does if
  anyone reopens `backup/`.
- **Puppeteer's Chromium download is often blocked** by npm's install-script
  policy in this environment. `server/.npmrc` sets
  `puppeteer_skip_download=true` so `npm install` doesn't hang; either reuse an
  installed Chrome via `chromePath` in config, or run
  `npx puppeteer browsers install chrome` manually once.

## Design decisions worth knowing the reasoning for

- **WhatsApp Web runs in-process in the Express server**, not as a separate
  sidecar process (the Python app used a Node sidecar over loopback HTTP with
  a shared secret, because the Python app itself couldn't run Node code).
  Express already is Node, so that whole indirection was dropped in the port.
- **Sending safety (pacing + daily cap) was not in the original ask.** Added
  because bulk sending without it is close to guaranteed to get a number
  banned. Deliberately visible in the UI (budget remaining, time estimate)
  rather than silent, so the operator can plan around it instead of being
  surprised by a paused campaign.
- **The daily cap pauses, it doesn't fail.** Hitting the limit leaves the
  remaining contacts `QUEUED` and stops the worker; it resumes cleanly after
  midnight (or if the limit is raised). Treating it as a failure would have
  meant re-importing the whole contact list to retry.
- **No authentication on the server**, by design for now — single operator,
  same machine, matches how the desktop app worked. This is a real gap if the
  server is ever exposed beyond localhost. See `TODO.md`.

## Where things live

- Sending-safety logic: `server/src/campaign/safety.js` (+ tests in
  `server/test/safety.test.js`)
- Transport implementations: `server/src/transports/` — `cloudApi.js`,
  `whatsappWeb.js`, `sandbox.js`, common interface in `base.js`
- Status/ranking/phone rules shared logic: `server/src/protocol.js`
- Frontend state (SSE-driven signals): `web/src/app/core/`
- Archived Python app: `backup/` — has its own `README-BACKUP.md`
