# WhatsApp transports and media

The server has two real transports:

| | Cloud API | WhatsApp QR (Baileys) |
|---|---|---|
| Login | Meta access token | QR scan from the phone |
| Media (image, video, PDF) | native | native, uploaded by the server process |
| Buttons and list menus | native | numbered text menu; replies "1" or the title still count |
| Server needs | nothing extra | nothing extra (no Chrome, no puppeteer) |

## Why whatsapp-web.js was removed

whatsapp-web.js drove a headless Chrome running WhatsApp Web. Upstream
WhatsApp Web changes broke media sends repeatedly in 2026 (`MsgKey._serialized`
renamed to `$1`, the `MediaData` `__x_id` collision behind "Data passed to getter
must include an id property", image sends hanging), and fixes were not released
to npm. Baileys talks to WhatsApp directly over a WebSocket, so none of those
browser-side breakages apply.

The offline sandbox transport is also gone from the product. It only exists for
the test suite and the demo script (`WHATSAPP_SENDER_SANDBOX=1`, set by
`server/test/isolate-home.js`).

## Upgrading a server

1. `cd server && npm install` (whatsapp-web.js and its Chrome download are no
   longer installed; the old `~/.cache/puppeteer` can be deleted).
2. Restart the server.
3. Numbers saved as `whatsapp_web` or `sandbox` are read as Baileys
   automatically. Baileys is a different linked device, so the old session does
   not carry over: open the Connection page (or WhatsApp Numbers), click
   Connect and scan the new QR code.
4. On the phone, remove the old "Chrome" entry from Linked devices.
5. Send one image, one PDF and one mp4 to your own number to confirm.

Baileys stores its session under `<sessionDir>/baileys/` (default
`~/.whatsapp_sender_web/wwebjs_auth/baileys/`).
