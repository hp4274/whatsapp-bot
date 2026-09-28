# Status

Last updated: 2026-09-28

## Where this started

A request to build a Windows desktop app for sending WhatsApp messages: GUI,
bulk campaigns, CSV/XLSX contacts, personalisation, queue management, real
delivery verification. Built in Python with CustomTkinter.

## What exists now

Two parallel builds:

- **`backup/`** — the original Python/Tkinter desktop app. Complete, tested,
  archived. Still runs (`cd backup && run.bat`).
- **`server/` + `web/`** — the current build: Express backend + Angular
  frontend, running in a browser. This is what `README.md` documents and what
  active work targets.

## Build history, in order

1. **Python desktop app (complete)** — GUI, WhatsApp Business Cloud API
   transport, SQLite history, CSV/XLSX import, queue + rate limiter + retry
   policy, webhook receiver for DELIVERED/READ receipts, sandbox transport for
   testing without sending anything real. Full pytest suite.

2. **WhatsApp Web transport added (Python)** — token-free path via
   whatsapp-web.js, run as a Node sidecar (`bridge.js`) talking to the Python
   app over loopback HTTP with a shared secret. QR login, session cached on
   disk. Found and fixed a real bug here: whatsapp-web.js sometimes dispatches
   a message but returns no id, and the naive code was retrying — which
   double-sent. Fixed by confirming the send against the library's own
   `message_create` event before ever treating a missing id as failure.

3. **UI redesign (Python)** — blue/white/black palette, then revised to
   navy/WhatsApp-green/white to match a reference screenshot. Real logo, inline
   animation helpers (spinner, pulsing "live" dot, eased progress bar), fixed a
   real QR-not-rendering bug (customtkinter 6 dropped Pillow; QR images are
   drawn with plain `tk.PhotoImage` now, no dependency needed).

4. **One-message-per-number feature (Python)** — campaigns can collapse
   duplicate numbers and skip numbers already messaged in an earlier run,
   tracked in the database.

5. **Full port to Angular + Express** — the current build. Same rules, ported
   deliberately rather than reinvented:
   - phone normalisation (E.164), `{name}` personalisation, status vocabulary
     and its ranking (a late "delivered" can never downgrade a "read")
   - queue, token-bucket rate limiter, exponential-backoff retry policy
   - all three transports: Cloud API, WhatsApp Web (now **in-process**, no
     sidecar — Express is already Node), sandbox
   - CSV/XLSX import, one-message-per-number
   - SQLite via `node:sqlite` (built into Node, no native build step)
   - live updates over Server-Sent Events instead of a Tk event loop
   - same visual design system, done in CSS custom properties

6. **Sending safety added (Express)** — not in the original scope, added on
   request:
   - **adaptive pacing**: gap between messages is randomised and widens with
     batch size (4–12s for ≤10 contacts, up to 40–95s for 1000+), plus a
     2–5 minute rest every 40 messages
   - **daily send cap**: hard ceiling on real messages per calendar day,
     counted from the database (survives restarts), campaign **pauses** at the
     cap rather than failing
   - both configurable and visible in the UI before a campaign starts (budget
     remaining, time estimate, live "why is this waiting" note)

7. **Python app archived** — moved into `backup/` so the repo root reflects
   the web build as primary.

8. **Bug fix: WhatsApp Web connect crashing the dev server** — `whatsapp-web.js`
   is CommonJS; `import { Client, LocalAuth } from 'whatsapp-web.js'` only
   resolved `Client` (Node's static ESM-interop lexer missed the rest),
   `LocalAuth` was `undefined`, connect threw, and under `node --watch` the
   crash tore down the whole process mid-request — which is what showed up in
   the browser as `ECONNRESET` / `502 Bad Gateway`. Fixed by importing the
   whole module and destructuring `.default`.

## Test coverage right now

- **Backend**: 48 tests (`node:test`, no framework) — phone rules,
  personalisation, receipt-ranking guard, queue semantics including
  one-per-number, rate limiter, retry backoff, CSV parsing/headers, both real
  transports' error classification, webhook parsing, WhatsApp Web ACK mapping,
  the daily quota and pacing tiers, and the API end-to-end over a real HTTP
  listener (config round-trip, token never leaked to the client, a full
  campaign run, the SSE stream, the `204` unchanged-history path).
- **Frontend**: `tsc --noEmit` clean, `ng build` clean. No component-level
  test suite written yet (scaffolded `app.spec.ts` only).
- Verified by hand in a real browser via Playwright multiple times across the
  build: connect flow, QR rendering, campaign run, history table, dark/light
  theme, the safety card and its live numbers.

## What is NOT done

- No authentication on the server. It binds to `127.0.0.1` and assumes one
  trusted operator on the same machine. Documented in `README.md`, not fixed.
- No pagination on the history table (hard-capped at 1000 rows).
- Cloud API `DELIVERED`/`READ` still needs a public webhook URL (Meta
  requirement, not something this app can remove).
- Frontend has no automated tests beyond the type checker and build.
- See `TODO.md` for anti-ban ideas discussed but not yet built.
