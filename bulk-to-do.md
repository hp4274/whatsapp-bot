# Bulk: what to add next for safety and speed

What already exists is in `docs/bulk.md`. Items are ranked by value. **S** = safety, **P** = speed. Size: XS < 20 lines, S < 100, M < 300.

## Do first

1. **Switch shadow mode to enforce, with a review screen** (S, S-size)
   - Today the delivery, stuck and unstable brakes, demotion and the promotion health check only log (`sending.brakesMode = shadow`). The only way to review them is one number at a time.
   - Add one admin table: the last 7 days of shadow triggers per number and kind, with a "would have paused N hours" figure.
   - Once a week of data looks sane, flip to `enforce`. Until then the strongest protections aren't really on.

2. **Stop sending to people who never respond** (S, S-size)
   - Today the only things that remove a contact from bulk are an opt-out, a mute, or the one-a-day cap.
   - New rule: skip a contact who got **3 bulk messages in 30 days** with no reply and no read (blue ticks) on any of them. They're shown as "unengaged" in the campaign summary. Any reply clears it.
   - These people are the ones who block and report. Dropping them raises the reply rate, which is what moves a number up a level, so this helps speed too.
   - Goes in: a `db` query beside `bulkCountsSince` (`db.js`), and a skip in the contact loop (`manager.js:400`) like `skippedMuted`. Policy field `sending.unengagedAfter` (default 3, 0 = off).

3. **Opt-out words in Hindi and Hinglish** (S, XS)
   - `OPTOUT_KEYWORDS` (`autoreply/optout.js:5`) is English only. Add common ones: "band karo", "mat bhejo", "nahi chahiye", "बंद करो", "मत भेजो", "message mat karo".
   - Admins can already add words (`autoReplies.optOutWords`), but the defaults should cover the main market.
   - A missed STOP becomes a report, and reports trip the reports brake.

4. **Upload each carousel image once per campaign** (P, XS)
   - `#deliverCarouselNative` (`baileys.js:758`) uploads every card image again for every recipient: 5 cards × 1,000 people = 5,000 uploads.
   - Pass Baileys' `mediaCache` option (a small TTL map keyed by the image's hash) to `prepareWAMessageMedia`, and to the normal image path too.
   - Each send is faster, less data is used, and there are fewer upload errors to retry.

## Next

5. **Send to people who already chat with you first** (S+P, S)
   - Today the contact list is shuffled (`manager.js:400`).
   - Put warm contacts (who wrote in before) first, then strangers. A stranger at the end of the day can wait for tomorrow's new-chat budget.
   - Early replies keep the reply-rate brake away, and warm contacts don't use the new-chat budget, so more of the day's limit is actually used.

6. **Start established numbers higher, from their chat history** (P, S)
   - From the earlier "Later" list. When a number links, Baileys' `messaging-history.set` reports its existing chats (not used anywhere today).
   - Use the count of one-to-one chats to pre-select a higher answer in the two-question popup. The user still confirms; nothing is skipped.
   - A 3-year business number then starts near L6 instead of L2.

7. **Campaign finish estimate and an "add a number" hint** (P, S)
   - Show "finishes Thursday" from today's limit, the new-chat budget and the hourly cap.
   - If another number would make it finish earlier, say so. A second number is the only safe way to double speed.
   - Goes in the review step, using the numbers `quotaLeft` (`channelOps.js`) already works out.

8. **Tenant ban record** (S, S)
   - Nothing counts bans across a tenant's numbers today.
   - 2 bans in 30 days across one tenant's numbers: cap that tenant's `sending.maxLevel` at its current level for 14 days, and send an ops alert.
   - A business that keeps getting numbers banned is sending to people who don't want its messages. New numbers won't fix that.

9. **Save a snapshot on every ban** (S, XS)
   - On a 403, store the number's last 48h ledger (sent, delivered, replies, brakes, level) in `safety_events` with `kind: 'ban'`.
   - After a few bans this shows which thresholds to tighten. Right now that data is gone once the history restarts.

## Later

10. **Reward high engagement in level needs** (P, S, shadow first)
    - If 7-day delivery ≥ 97% and replies ≥ 30%, the delivered-volume needs for the next level drop by 25%. The active-days need stays.
    - It's still gated by engagement, so it's safe in principle, but run it in shadow for 2 weeks to see what it would have changed.

11. **Pause a campaign on a high stop rate** (S, XS)
    - If over 3% of a campaign's recipients reply STOP, from 50 delivered, pause it and tell the business the message is unwelcome.
    - The block-rate pause catches this a week late. This catches it within hours.

12. **Check list quality at upload** (S, S)
    - Using the existing phone parsing, flag invalid, duplicate, landline-shaped and wrong-country numbers in the contact import preview.
    - Don't pre-check a whole list against WhatsApp: mass lookups are a signal of their own.

## Not doing (and why)
- **Faster gaps, rotating devices or proxies, randomized fingerprints:** this is detection evasion. A number survives by sending less when the signals are bad.
- **Randomizing the campaign start time:** same reason. It's still on the earlier "Later" list as skip.
- **Bringing back the content rule:** the user removed it.

## Checks for each item when it's built
- `cd server && npm test` stays green, apart from the 3 known storage 429s. Every new rule gets a test (unengaged skip, Hindi STOP, media cache hit, warm-first order, tenant ban cap).
- `cd web && npx ng build` stays clean for UI items (1, 7, 12).
- `docs/bulk.md` is updated in the same change.
