# Bulk: what to add next for safety and speed

What already exists is in `docs/bulk.md`. Items are ranked by value. **S** = safety, **P** = speed. Size: XS < 20 lines, S < 100, M < 300.

## Built on 2026-10-27

- **1. Shadow review screen** (S): Admin › Channels › "Shadow review, last 7 days" (`GET /api/admin/shadow-review`).
- **3. Opt-out words in Hindi and Hinglish** (S): added to `OPTOUT_KEYWORDS`.
- **4. Upload each image once** (P): `mediaCache` in `baileys.js`, for both the album and the native carousel.
- **5. Warm contacts first** (S+P): `enqueueContacts` queues people who wrote in before ahead of strangers.
- **6. Start from chat history** (P): the two-question popup pre-selects answers from the one-to-one chat count.
- **7. Finish estimate and the "add a number" hint** (P): shown in the review step.
- **8. Tenant ban record** (S): 2 bans in 30 days across a tenant's numbers holds each number at its level for 14 days and sends an ops alert.
- **9. Ban snapshot** (S): stored as `safety_events` kind `ban_snapshot`.
- **10. Engagement reward** (P): logged in shadow only (`level:engaged`).
- **11. STOP-rate pause** (S): over 3% from 50 reached pauses the campaign.
- **12. List check at import** (S): invalid, repeated, not-mobile-shaped (India) and foreign numbers are flagged in the preview.

## Still to do

1. **Flip `sending.brakesMode` to `enforce`** once the shadow review shows a week of sensible triggers. Use the new table to judge it.
2. **Apply the engagement reward** after 2 weeks of `level:engaged` shadow rows look right. Make the note in `levelFor` count towards `earned` instead of only logging.

## Not doing (and why)
- **Faster gaps, rotating devices or proxies, randomized fingerprints:** this is detection evasion. A number survives by sending less when the signals are bad.
- **Randomizing the campaign start time:** same reason. It's still on the earlier "Later" list as skip.
- **Bringing back the content rule:** the user removed it.

## Checks for each item when it's built
- `cd server && npm test` stays green, apart from the 3 known storage 429s.
- `cd web && npx ng build` stays clean for UI items.
- `docs/bulk.md` is updated in the same change.
