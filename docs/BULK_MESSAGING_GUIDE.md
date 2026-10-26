# Bulk messaging guide

How a QR (Baileys) number decides how much bulk it may send, how fast, and when it sends less. Bulk means the
held message types: `campaign`, `workflow`, `reminder` (`HELD_TYPES`). Replies to someone who wrote in are never
held. Nothing here hides automation from WhatsApp: the number stays alive by sending less when signals degrade.

Code: `server/src/campaign/humanize.js` (levels, brakes, health), `server/src/campaign/safety.js` (budgets, growth
cap, pacing), `server/src/db.js` `sendingLedger` (every input, read from the rows), `server/src/policy/levels.js`
(admin-editable tables). The sandbox has no level: it never waits and keeps the plain `dailyLimit`.

## Sending levels

| Level | Name | Per day | New chats | Per hour | Gap (s) | Links / media | Needs: days / delivered / bulk |
|---|---|---|---|---|---|---|---|
| 0 | Resting | 0 | 0 | 0 | 90-300 | no / no | the rest after linking |
| 1 | First steps | 10 | 3 | 5 | 90-300 | no / no | - |
| 2 | Settling in | 20 | 5 | 8 | 60-180 | no / no | 3 / 8 / 0 |
| 3 | Building | 40 | 10 | 10 | 45-150 | no / no | 6 / 40 / 0 |
| 4 | Growing | 60 | 15 | 12 | 40-120 | 1 / yes | 9 / 100 / 40 |
| 5 | Steady | 100 | 20 | 15 | 30-120 | 1 / yes | 12 / 220 / 90 |
| 6 | Trusted | 150 | 30 | 20 | 30-90 | 1 / yes | 17 / 500 / 200 |
| 7 | Established | 200 | 50 | 30 | 20-90 | 1 / yes | 24 / 1000 / 400 |
| 8 | Proven | 250 | 80 | 30 | 20-60 | 1 / yes | 40 / 2500 / 1000 |
| 9 | Reliable | 400 | 120 | 45 | 20-50 | 1 / yes | 40 / 3000 / 1500 |
| 10 | Strong | 650 | 200 | 70 | 20-40 | 1 / yes | 40 / 6000 / 3000 |
| 11 | Peak | 1000 | 300 | 100 | 15-35 | 1 / yes | 45 / 12000 / 6000 |

- Needs count only what reached the phone (two ticks), since the number's anchor: when it took over the channel,
  or its last ban.
- The two number questions (age and usage) pick a start level of 2-7; its needs count as met. Skipping them starts
  at the plan's day. Unanswered questions hold bulk.
- After linking (or a ban) the number rests 24h (48h / 72h for a 2nd / 3rd ban in 30 days). A start above level 2
  skips the rest after linking; 40 delivered lifts it early.
- The plan's per-number day, the number's own `dailyLimit` and the admin's `sending.maxLevel` only ever lower the
  level. An admin pin sets it (still capped), skipping the rest and idle decay; every brake still applies.

## Pacing

The gap between two bulk messages is drawn at random from the level's range, with a longer rest every
`restEvery` messages and 2-3 quiet windows a day. Batch size does not change the gap. Presets: `safe` stretches
the gaps by half; `fast` runs as `balanced` on a level. A policy gap (`minDelaySeconds` / `maxDelaySeconds`) only
ever slows a level down. Bulk waits for the recipient's daytime (09:00-21:00 by default).

## Today's bulk: the growth cap

The level's day is a destination, not a minimum (`growthFrom`):

```
todayBulk = min(levelDay, cap)
  no delivered bulk before today     cap = startDaily   (the start level's day, or level 1's 10)
  a clean day in the last 7          cap = max(10, floor(bestCleanDay7 x multiplier))
  no clean day in the last 7         cap = max(10, lastDayDelivered)       (holds flat)
```

- `bestCleanDay7`: the most bulk delivered (not attempted) in one day over the 7 days before today, leaving out
  brake days.
- `multiplier`: 1.35; 1.15 if a brake was on in the last 7 days (today included).
- Brake days come only from brakes that really applied: a `brake_day` row written while a brake is on (reply rate,
  reports, blocks, failures, restricted, and delivery / stuck / unstable once enforced) and enforced `brake` rows.
  Shadow rows never count.
- `startDaily` applies only with no delivered bulk history: a new number, or one whose history restarted after a
  ban or a number change.
- Examples: six days at 100, then a day at 30: the next day's cap is 135. A promotion from level 3 to 4 climbs
  40 -> 54 -> 60. Seven braked days: flat at the latest day, never back to `startDaily`, never below 10.

## Brakes

| Brake | Fires when | Effect |
|---|---|---|
| reply_rate | 40+ reached in 48h, under 15% replied | bulk, new chats and the hour halved |
| reports | 3 spam reports within 72h | new chats wait 72h after the last |
| blocks | blocks + reports over 2% of 7-day deliveries (40+) | new chats wait |
| failures | over 3% of 20+ sends failed in 24h | new chats wait |
| restricted | WhatsApp limits new chats | new chats and number checks wait |
| delivery | 20+ sent 2-24h ago, under 85% delivered | no bulk or new chats for 12h |
| stuck | over 20% of those still one tick | no bulk or new chats for 12h |
| unstable | more than 8 socket reconnects in an hour | no bulk or new chats for 8h (never a demotion) |
| idle | nothing delivered in the 3 days before today | see idle decay |

Thresholds are platform policy (`sending.*`). Campaigns also pause when blocks + reports pass
`sending.blockPausePercent` of the week's sends.

## Levels that go down

Promotion, demotion and probation use the number's stored level state in `channel_ops` (`last_level`,
`demoted_at`, `clean_checks`, `clean_check_at`) and its health over 7 days, or since its last demotion if that is
later (messages sent up to 2h ago, groups left out; replies only to bulk sent up to 24h ago; the failed rate also
counts sends that failed before leaving). Rates are judged from 20 sent; replies from 40 reached.

- **Promotion** (`meets()` in `levelFor`): a level above the stored one is met only when needs are met and
  delivered >= 92%, stuck <= 5%, failed <= 3%, and replied >= 10%.
- **Demotion**: delivered under 85% or stuck over 20% drops 2 levels; delivered under 90% or replies under 5%
  drops 1. Never below 1. Health then counts from the demotion, so one bad stretch demotes once.
- **Probation**: no promotion for 48h after a demotion; then two passing health checks at least 6h apart. A
  failing check starts the count again; a check with too few sends counts neither way. A promotion keeps
  `demoted_at`, so health still counts from the demotion until it is 7 days old; then it is cleared.
- **Idle decay**: nothing delivered in the 3 days before today runs the day one level lower, and one more for
  every further 3 quiet days, down to the start level. It is per day and never stored.

## Shadow mode

`sending.brakesMode` (`shadow` by default, or `enforce`) covers the delivery, stuck and unstable brakes, demotion,
probation and the promotion gate. In shadow mode they are computed and logged as `safety_events` rows of kind
`shadow` (level ones with phone `level:<reason>`), shown to the admin, and never stop or slow sending: the stored
level follows what history earns. Switch to `enforce` after reviewing 7 days of triggers. The other brakes always
apply.

## Audit and admin view

Every computed level change writes a `safety_events` row: kind `level` (or `shadow`), detail
`{ from, to, text }`, reason one of `promote`, `demote_delivery`, `demote_stuck`, `demote_replies`, `hold_health`,
`hold_probation`, `idle`, `history`. Holds and idle are written once a day. `GET /api/admin/health-detail` shows,
per QR number, `level.ready`, `level.growth`, `level.health`, `level.probation` and `level.events` (30 days), next
to `brakeHealth` (the brake rows of 7 days).
