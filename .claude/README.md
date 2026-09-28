# WhatsApp Sender - web edition (Angular + Express)

The desktop application, ported to a browser UI. Same transports, same queue,
same rate limiting, retries and history rules - a different shell around them.

```
server/   Express 5 API: transports, campaign engine, sending safety, history
web/      Angular 22 frontend: Connection, Messaging & Campaign, History
backup/   the original Python/Tkinter desktop build, archived and still runnable
```

See [backup/README-BACKUP.md](backup/README-BACKUP.md) for the archived app.

---

## 1. What changed in the port

| Concern | Desktop (Python) | Web |
|---|---|---|
| UI | CustomTkinter window | Angular 22, standalone components + signals |
| Live updates | Tk event queue | Server-Sent Events (`/api/events`) |
| WhatsApp Web transport | Node sidecar (`bridge.js`) over loopback HTTP | whatsapp-web.js **in the Express process** - the sidecar is gone |
| Storage | `sqlite3` | `node:sqlite` (built into Node, no native build) |
| XLSX import | openpyxl | SheetJS (`xlsx`) |
| Icons | Segoe Fluent Icons | inline SVG |
| Theme | CustomTkinter JSON theme | CSS custom properties, `data-theme` on `<html>` |

Ported unchanged in behaviour: E.164 normalisation, `{name}` personalisation
(unknown placeholders survive), the status vocabulary and its ranking (a late
`delivered` never overwrites `read`), SANDBOX as a separate state from SENT,
the retryable/permanent error split, one-message-per-number, and the
"confirm before you retry" rule that stopped WhatsApp Web double-sends.

## 2. Run it

Requires **Node 22.5+** (for `node:sqlite`); developed on Node 26.

```bash
cd server && npm install     # add PUPPETEER_SKIP_DOWNLOAD=true to reuse a Chromium you already have
cd ../web  && npm install
```

Development - two terminals, the Angular dev server proxies `/api` to Express:

```bash
cd server && npm run dev     # http://127.0.0.1:3000
cd web    && npm start       # http://localhost:4200
```

Production - one process serving both:

```bash
cd web    && npm run build   # emits web/dist/web/browser
cd server && npm start       # http://127.0.0.1:3000 serves the API and the app
```

Data lives in `%USERPROFILE%\.whatsapp_sender_web\` (`config.json`,
`messages.db`, `wwebjs_auth/`, `sandbox_outbox.log`). Override with
`WHATSAPP_SENDER_HOME`.

## 3. Security, stated plainly

The server binds to `127.0.0.1` and has **no authentication**: it is the same
single-operator tool the desktop app was, driven from a browser on the same
machine. Anyone who can reach the port can send messages from your WhatsApp
account. Do not bind it to `0.0.0.0` or expose it without putting a real
authenticating proxy in front of it first.

The access token is never sent to the browser: `GET /api/config` returns the
sentinel `__set__`, and sending that value back leaves the stored token alone.

## 4. API

| Method | Path | Purpose |
|---|---|---|
| GET/PUT | `/api/config` | read / update settings (token write-only) |
| GET | `/api/connection` | current transport state |
| POST | `/api/connection/connect` \| `/disconnect` \| `/logout` | session control |
| POST | `/api/messages` | queue one message |
| POST | `/api/contacts/import` | CSV / XLSX upload -> parsed contacts |
| POST | `/api/campaign/start` | queue a batch |
| POST | `/api/campaign/pause` \| `/resume` \| `/stop` | run control |
| GET | `/api/campaign/stats` | counters |
| GET | `/api/history` | rows + counts; send `?signature=` to get `204` when nothing changed |
| GET/POST | `/api/webhook` | Meta verification + delivery receipts |
| GET | `/api/events` | SSE: `stats`, `status`, `message`, `receipt`, `connection`, `qr` |

### The QR flow

Select the WhatsApp Web transport and press Connect. The server starts
whatsapp-web.js, pushes the QR over SSE as a data URL, and the Connection page
renders it. Scan it in WhatsApp > Linked devices; the session is cached in
`wwebjs_auth/`, so later starts skip the scan.

## 5. Sending safety

Bulk sending is what gets a WhatsApp number banned, and a fixed interval is the
easiest pattern to spot: 300 messages exactly 5.0s apart is not a person. Two
controls, both on by default, live in
[`server/src/campaign/safety.js`](server/src/campaign/safety.js) and are
configured on the Connection page.

### Adaptive pacing - the gap widens with the batch

The delay before each message is drawn at random from a range, and the range is
chosen from the size of the batch:

| Contacts | Gap between messages | 100 messages takes |
|---|---|---|
| up to 10 | 4-12 s | - |
| up to 50 | 8-22 s | ~25 min |
| up to 200 | 15-40 s | ~45 min |
| up to 1000 | 25-65 s | ~75 min |
| more | 40-95 s | ~1 h 50 m |

Every `restEvery` messages (40 by default) the run takes a longer rest of 2-5
minutes. The campaign page shows the estimate before you press Start, and says
what it is waiting for while it waits. Set `pacingMode: "fixed"` to switch this
off and use the plain rate limit instead - faster, and far more conspicuous.

### A daily cap

`dailyLimit` (250 by default) is a hard ceiling on **real** messages per
calendar day, counted from the database, so restarting the server does not
reset it and two campaigns in one day share one budget. SANDBOX sends never
count - nothing left the machine.

When the cap is reached the campaign **pauses**; it does not fail. The unsent
rows stay `QUEUED` and the run continues after midnight. Resume refuses while
the budget is still spent, and single sends are refused with `429`. Set it to
`0` to remove the ceiling.

Neither control hides anything from WhatsApp. They keep volume and timing
inside what a human account plausibly does - which is also the difference
between messaging your contacts and spamming them. Sending to people who did
not ask to hear from you will get the number reported and banned no matter how
the messages are paced.

## 6. Tests

```bash
cd server && npm test        # 48 tests: node:test, no framework
cd web    && npm test        # Angular/vitest
```

The backend suite covers phone rules, personalisation, the receipt-ranking
guard, queue semantics (including one-per-number), token-bucket rate limiting,
retry backoff, CSV/header handling, the error classification of both real
transports, webhook parsing, ACK mapping, and the API end to end over a real
listener: config round-trip, refusing to send while disconnected, a campaign
run, the `204` history path and the SSE stream. A separate safety suite covers
the pacing tiers and their jitter, the rest pauses, the daily counter (day
rollover, SANDBOX exclusion) and the engine pausing - not failing - at the cap.

## 7. Known limits

* No auth (see above), single operator, one transport connected at a time.
* whatsapp-web.js remains against WhatsApp's Terms of Service and can get a
  number banned. The UI repeats this wherever that transport is selected.
* `DELIVERED`/`READ` on the Cloud API still need a public webhook URL; on
  WhatsApp Web they arrive automatically as ACKs.
* History renders up to 1000 rows; there is no pagination yet.
