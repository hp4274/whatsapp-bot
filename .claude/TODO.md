# TODO — further ban-safety work

What's already built: adaptive pacing (random gap, widens with batch size,
periodic long rest) and a daily send cap that pauses instead of failing. Both
in `server/src/campaign/safety.js`.

Below is what's not built yet, ranked by how much it actually reduces ban
risk versus how much work it is. Pacing and a daily cap control *volume and
rhythm*. Everything below controls the other half of what gets a number
flagged: *who you message, what you send them, and whether you notice trouble
early.*

## High impact, worth doing next

1. **Consent / opt-in tracking.** The single biggest ban cause is messaging
   people who never asked to hear from you — recipient "report" taps are what
   actually trigger bans, not send speed. Add an `optedIn` / `consentSource`
   field to the contact import, refuse to queue a contact without it (or warn
   loudly), and support an unsubscribe keyword ("STOP") that adds the number
   to a permanent block list checked before every send.

2. **New-number warm-up ramp.** A WhatsApp number that suddenly sends 250
   messages on day one looks nothing like a real account. Track "days since
   this number was first connected" and scale the daily cap up over the first
   1–2 weeks (e.g. 20 → 50 → 100 → the configured limit), rather than letting
   a fresh QR-linked number hit the full daily cap immediately. Small addition
   to `DailyQuota` — needs a "first connected" timestamp per session, not per
   message.

3. **Failure-rate circuit breaker.** Right now a failed send just retries and
   moves on. Add: if the last N sends (e.g. 10) have a failure rate above some
   threshold, auto-pause the campaign and surface it loudly — a spike in
   failures is often the first sign of a number getting restricted, and
   catching it in real time beats finding out after 500 messages went to a
   half-dead number. Natural fit for `CampaignManager`, next to the existing
   quota check.

4. **Cloud API quality-rating watch.** `connect()` already fetches
   `quality_rating` (GREEN/YELLOW/RED) from Meta and throws it away after
   showing it once. Store it, poll it periodically while connected, and pause
   sending (or at least warn hard) if it drops to YELLOW/RED — that field is
   Meta directly telling you the number is at risk.

## Medium impact

5. **Message variation / anti-duplication.** Sending byte-identical text to
   hundreds of numbers in one run is itself a spam signal, `{name}`
   substitution only goes so far. Support a small set of template variants
   picked at random per recipient (2–3 rewordings of the same message), or at
   minimum warn the operator when a campaign's personalisation produces the
   same body for more than a handful of recipients.

6. **Time-of-day sending window.** Nothing stops a campaign from messaging
   someone at 3 AM their time right now. Add a configurable send window
   (e.g. 9 AM–8 PM) and hold queued messages until it opens, using the
   recipient's country code as a rough timezone guess where possible.

7. **Per-number cool-down.** The one-per-number option (already built) stops
   *this* campaign from double-messaging someone, but nothing stops two
   separate campaigns on the same day from both messaging the same number.
   Add a configurable minimum gap (e.g. 24h) between any two messages to the
   same number, checked against history like `sentRecipients()` already is.

8. **First-contact caution.** Messaging a number that has never messaged you
   back (cold outreach) is riskier than replying to an inbound conversation.
   For the Cloud API this already forces templates outside the 24h window;
   consider surfacing a "cold contact" count before a campaign starts so the
   operator knows how much of the batch is cold outreach versus warm replies.

## Lower impact / larger effort

9. **Multi-number rotation.** Splitting a very large campaign across several
   verified sending numbers reduces the load (and the risk) on any single
   number. Real infrastructure work — a pool of connected transports, a
   router that spreads contacts across them — not a small addition. Only
   worth it once daily volume regularly exceeds what one number can safely
   send.

10. **Engagement-based throttling.** Slow down automatically if delivered
    messages aren't being read (a proxy for "this looks like spam to
    recipients"), not just when sends outright fail. Needs delivery-receipt
    data to be reliable first (Cloud API needs the webhook set up; WhatsApp
    Web gets this for free via ACKs already).

11. **Session-health self-check for WhatsApp Web.** Detect a silent logout /
    ban mid-campaign (not just a thrown error) by watching for the `state`
    events already emitted (`disconnected`, `auth_failure`) and stopping the
    queue immediately rather than letting retries burn through the rest of
    the batch against a dead session.

## Explicitly not planned

- **Anything that hides automation from WhatsApp** (randomised user agents,
  proxy rotation, timing designed to evade specific detection heuristics).
  That's an arms race this project isn't in — the goal here is to behave like
  a real, well-behaved sender, not to out-fox WhatsApp's detection.
