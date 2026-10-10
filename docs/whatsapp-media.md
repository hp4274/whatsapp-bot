# WhatsApp attachments (images, PDFs, videos) on QR-login transports

## What was wrong

Attachments on the **WhatsApp Web (whatsapp-web.js)** transport stopped arriving
while the text still did. Our transport falls back to text-only and writes
"The text was sent, but WhatsApp Web could not attach the image" into the
history row. Three upstream breakages stacked up in 2026:

| When | Breakage | Upstream | State |
|------|----------|----------|-------|
| 2026-07 | WhatsApp Web renamed `MsgKey._serialized` to `$1`; whatsapp-web.js 1.34.7 (npm) reads `undefined` and media sends die with minified `t: t` errors | [#201862](https://github.com/wwebjs/whatsapp-web.js/issues/201862), [#201830](https://github.com/wwebjs/whatsapp-web.js/issues/201830) | partial fix in main [`58ddf15`](https://github.com/wwebjs/whatsapp-web.js/commit/58ddf15), full prototype shim in PR [#201871](https://github.com/wwebjs/whatsapp-web.js/pull/201871) still unmerged |
| 2026-09-17 | WhatsApp Web 2.3000.10477xx: the `MediaData` model's private `__x_id` is spread into the outgoing message and overwrites its id: "Data passed to getter must include an id property" | [#201922](https://github.com/wwebjs/whatsapp-web.js/issues/201922), [#201921](https://github.com/wwebjs/whatsapp-web.js/issues/201921) | fixed in main [`064a3d5`](https://github.com/wwebjs/whatsapp-web.js/commit/064a3d5a5a3dce1281a6a12740b5a7051339d154) (PR [#201923](https://github.com/wwebjs/whatsapp-web.js/pull/201923)); **no npm release after 1.34.7** |
| 2026-05 | Image sends hang in 1.34.7 (`OpaqueData.createFromData`); documents go through | [#201772](https://github.com/wwebjs/whatsapp-web.js/issues/201772) | closed without a linked fix; our transport retries the file as a document |

Our `server/package.json` pins whatsapp-web.js to the GitHub tarball of
`064a3d5` (it still reports version 1.34.7, so `npm ls` cannot tell you whether
the fix is installed; `grep -c __x_id node_modules/whatsapp-web.js/src/util/Injected/Utils.js`
must print `3`). Even with that commit, every WhatsApp Web deploy can break
media again because the library drives a browser against a page Meta changes
weekly. That is the structural problem, not a bug we can patch for good.

### What changed in this repo

- `server/src/transports/whatsappWeb.js`
  - Linux-server-safe Chrome flags: `--disable-dev-shm-usage` (small `/dev/shm`
    on EC2/Docker kills the renderer on large uploads), `--disable-gpu`,
    `--no-first-run`, `--no-default-browser-check`; `headless: true` (full
    Chrome headless, which has the media pipeline - never `'shell'`).
  - After `ready`, a `_serialized` getter is installed on WhatsApp Web's
    `WAWebMsgKey.prototype` (the PR #201871 shim) so every lookup still sees
    the old name.
  - The existing fallback stays: normal send, then as document, then text only
    with an explicit note in the history row.
- **New transport: Baileys** (`server/src/transports/baileys.js`,
  `@whiskeysockets/baileys` 7.0.0-rc14). It speaks the multi-device protocol
  directly over a WebSocket: no Chrome, no puppeteer, media is encrypted and
  uploaded by Node itself. Same QR login, same events, same receipts.

## Which transport to pick

| | Cloud API | Baileys (no browser, QR) | whatsapp-web.js (QR) |
|---|---|---|---|
| Official / ToS-safe | yes | no | no |
| Attachments | reliable | reliable | fragile (breaks whenever WhatsApp Web changes) |
| Server needs | none | none (Node 20+) | Chrome + ~500 MB RAM per number |
| Buttons / lists | native | numbered text menu | numbered text menu |
| Delivery / read receipts | webhook | yes | yes |

For a customer on QR login who sends images, PDFs or videos: **use Baileys**.
Keep whatsapp-web.js only for numbers that are already linked and never send media.

## Linux server requirements

**Baileys**: nothing beyond Node >= 20. `npm install` pulls `sharp` (prebuilt
binary, used for image thumbnails) automatically. `ffmpeg` on `PATH` is
optional: with it, videos get a preview thumbnail; without it they still send.

**whatsapp-web.js**:
- `npm install` downloads Chrome for Testing into `~/.cache/puppeteer` unless
  `PUPPETEER_SKIP_DOWNLOAD` is set. That build includes the H.264/AAC codecs, so
  mp4 videos work.
- If you point `CHROME_PATH` (or the channel's `chromePath`) at a distro
  `chromium` package instead, images and PDFs work but **mp4 video does not**
  (no proprietary codecs). Use Google Chrome stable (`google-chrome-stable`) if
  you need a system browser.
- Shared libraries Chrome needs on Ubuntu: `libnss3 libatk-bridge2.0-0 libxkbcommon0 libgbm1 libasound2 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 fonts-liberation`.
- Watch `[webjs media]` lines in the server log: they carry the raw library
  error for each failed attempt.

## Switching a number to Baileys

Baileys and whatsapp-web.js are separate WhatsApp "linked devices", so the
number has to be scanned again once.

1. On the server:
   ```bash
   cd server && npm install && pm2 restart whatsapp-bot   # or systemctl restart ...
   ```
2. In the app, **Connection** page: Disconnect (or Log out) the WhatsApp Web
   session, pick transport **WhatsApp (no browser, QR)**, Save, Connect.
3. Scan the QR with the phone (WhatsApp > Linked devices > Link a device).
   Baileys reconnects by itself once right after the scan (protocol restart,
   code 515); the page shows "Connected" within a few seconds.
4. Send a test message with an attachment from Campaigns or the Inbox.

Session files live under the channel's session directory in `baileys/`
(`~/.whatsapp_sender_web/wwebjs_auth/baileys` for the default channel). "Log
out" unlinks the device and deletes them. Optionally remove the now-unused
linked device "Chrome (Mac OS)" from the phone's Linked devices list.

The super-admin plan flag **Allow WhatsApp Web (QR)** covers both QR transports.
