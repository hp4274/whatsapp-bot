# Bulk messaging: how it works and every safety rule

This is the complete reference for bulk sending on the platform: what a number may send, how fast, when it slows down or stops, and what the super admin can change. It describes the code as it is today. If you change a rule, change this file. The plain-words version for customers is [bulk-customer-guide.md](bulk-customer-guide.md); keep its numbers in step.

Contents:
1. [What counts as bulk](#1-what-counts-as-bulk)
2. [The one sending path: QR numbers](#2-the-one-sending-path-qr-numbers)
3. [Connecting a number: the two questions](#3-connecting-a-number-the-two-questions)
4. [Sending levels](#4-sending-levels)
5. [Today's limit: how it is worked out](#5-todays-limit-how-it-is-worked-out)
6. [Pacing: gaps, rests and quiet time](#6-pacing-gaps-rests-and-quiet-time)
7. [When messages may go out](#7-when-messages-may-go-out)
8. [Message rules](#8-message-rules)
9. [Recipient rules](#9-recipient-rules)
10. [Brakes: sending less when signals go bad](#10-brakes-sending-less-when-signals-go-bad)
11. [Levels that go down: demotion, probation, idle](#11-levels-that-go-down-demotion-probation-idle)
12. [Shadow mode](#12-shadow-mode)
13. [Campaign-level stops](#13-campaign-level-stops)
14. [Connection and WhatsApp errors](#14-connection-and-whatsapp-errors)
15. [Several numbers: routing](#15-several-numbers-routing)
16. [Tenant-wide limits, plans and billing](#16-tenant-wide-limits-plans-and-billing)
17. [What the super admin can change](#17-what-the-super-admin-can-change)
18. [What the business sees](#18-what-the-business-sees)
19. [Alerts and audit](#19-alerts-and-audit)
20. [Where it lives in the code](#20-where-it-lives-in-the-code)

---

## 1. What counts as bulk

Every outgoing message has a type. The rules in this file apply to three of them:

| Type | Held by bulk rules? | Examples |
|---|---|---|
| `campaign` | Yes | Bulk campaigns, spread campaigns, recurring campaigns |
| `workflow` | Yes | Messages sent by automations |
| `reminder` | Yes | Fee and payment reminders |
| `auto_reply` | No: never held by limits | Keyword replies, menus, welcome, away, FAQ, HELP |
| `transactional` | No: never held by limits | One-off sends such as order or OTP messages |

A reply to someone who wrote in is never held by a daily limit. Auto-replies and transactional sends still respect the tenant's on/off controls (section 16), opt-outs, and WhatsApp's own errors.

**Principle.** Nothing in the engine tries to hide automation from WhatsApp. Numbers survive by sending in proportion to the trust they have earned, and by **sending less as soon as the signals get worse**.

## 2. The one sending path: QR numbers

- The Meta Cloud API has been removed. Every real number is a **QR-login (Baileys) number**: the business scans a QR code with WhatsApp on its phone.
- The **sandbox** transport (development and tests) never really sends. It has no levels and never waits, and only a plain `dailyLimit` applies to it.
- There is no warm-up feature. The sending level (section 4), started from the two questions (section 3), does that job.

## 3. Connecting a number: the two questions

Right after the first successful QR scan, the Connection page opens a popup with two questions. The same questions also appear on the number's card until they are answered.

**Pre-selected from history.** WhatsApp's link-time history sync lists the number's chats. The popup pre-selects answers from the count of one-to-one chats: 25+ → 1-6 months / light use (L3), 80+ → 6-24 months / regular (L5), 200+ → 2+ years / regular (L6), 500+ → 2+ years / busy (L7). It says where they came from, and the business still confirms or changes them. The count is kept in memory only, so a restart before the questions are answered drops the hint.

| Question | Answers (posted as 0-3) |
|---|---|
| How old is this number on WhatsApp? | Under 1 month · 1-6 months · 6-24 months · 2+ years |
| How has it been used? | New or hardly used · Light personal use · Regular daily chats · Busy business number |

**Starting level** = `min(7, max(2, age + usage + 1))`:

| age + usage | Start level | Starting limit |
|---|---|---|
| 0-1 | 2 | 20 a day |
| 2 | 3 | 40 a day |
| 3 | 4 | 60 a day |
| 4 | 5 | 100 a day |
| 5 | 6 | 150 a day |
| 6 | 7 | 200 a day |

- The business only ever sees: "This number runs at **N** messages a day. It will increase gradually up to **{plan limit}** a day as people reply."
- **Until the questions are answered, bulk is held.** Replies and transactional sends still go. A campaign started on an unanswered number waits, then sends by itself once the questions are answered.
- **Answers are final.** They can be given once (a second attempt returns 409), so nobody can re-answer to jump higher.
- **When they are asked again:** after a WhatsApp ban, or when a different phone takes over the channel. Moving the number to another business also clears them.
- **Numbers that sent before the questions existed** keep the level their history earned (`legacy` start) and are not held.

### Skipping the questions

"Skip the questions" opens a warning. Its confirm button stays off until **"I understand and accept the risk"** is ticked. The warning reads:

> Skipping these questions starts this number at the full daily limit of our plan, instead of a limit that suits its age and use.
> A number that suddenly sends that much is likely to be restricted, or banned by WhatsApp temporarily or permanently. No QR-login number is safe from that.
> I accept full responsibility for any restriction or ban of this number, and for any lost messages, contacts or business that follow. The platform cannot restore a banned number.

- **Starting level:** the lowest level whose day reaches the plan's limit: Starter 250 → L8, Business 500 → L10, Enterprise 1000 → L11.
- **Consent record:** the acceptance is stored in `safety_consents` (kind `number_skip_questions`, with the text version and its hash) **before** the start level is saved. That table cannot be edited or deleted.
- **Audit:** the skip is recorded as `channel.start_skip`; an answered start as `channel.start`.

## 4. Sending levels

Each QR number sits on a level from 0 to 11. The level sets its day, its new-chat budget, its hourly cap and its pacing. These are the built-in values; the super admin can edit every cell (section 17).

| Lvl | Name | Per day | New chats / day | Per hour | Gap (s) | Rest every | Rest (min) | Quiet time / day (h) | Needs: active days / delivered / bulk delivered |
|---|---|---|---|---|---|---|---|---|---|
| 0 | Resting | 0 | 0 | 0 | 90-300 | 5 | 45-60 | 6-8 | the wait after linking or a ban |
| 1 | First steps | 10 | 3 | 5 | 90-300 | 5 | 45-60 | 6-8 | none |
| 2 | Settling in | 20 | 5 | 8 | 60-180 | 8 | 45-55 | 6-8 | 3 / 8 / 0 |
| 3 | Building | 40 | 10 | 10 | 45-150 | 10 | 40-50 | 6-8 | 6 / 40 / 0 |
| 4 | Growing | 60 | 15 | 12 | 40-120 | 12 | 40-50 | 5-7 | 9 / 100 / 40 |
| 5 | Steady | 100 | 20 | 15 | 30-120 | 15 | 35-45 | 5-7 | 12 / 220 / 90 |
| 6 | Trusted | 150 | 30 | 20 | 30-90 | 20 | 35-45 | 4-5.5 | 17 / 500 / 200 |
| 7 | Established | 200 | 50 | 30 | 20-90 | 30 | 30-40 | 3-4 | 24 / 1000 / 400 |
| 8 | Proven | 250 | 80 | 30 | 20-60 | 30 | 35-45 | 3-4 | 40 / 2500 / 1000 |
| 9 | Reliable | 400 | 120 | 45 | 20-50 | 40 | 20-30 | 2.5-3.5 | 40 / 3000 / 1500 |
| 10 | Strong | 650 | 200 | 70 | 20-40 | 60 | 15-25 | 2-2.5 | 40 / 6000 / 3000 |
| 11 | Peak | 1000 | 300 | 100 | 15-35 | 80 | 10-15 | 1.5-2 | 45 / 12000 / 6000 |

How a level is earned:
- **What counts toward the needs.** Only messages that **reached the phone** (two ticks) count, from the number's **anchor**: when this phone took over the channel, or its last ban, whichever is later. A ban or a new phone restarts the history.
- **All three needs at once.** Active days (days with at least one delivery), delivered messages and delivered bulk must all be met. Levels 9-11 are gated mainly by delivered volume.
- **Seeding from the start level.** The start level's needs count as already met, so a number that started at L5 climbs from L5.
- **Good health is also required.** Meeting the needs is not enough to move up (section 11).
- **1,000 a day fits a working day.** L11 was sized so 1,000 messages, with their gaps and rests, fit inside the recipient's 12-hour daytime.
- **The wait after linking (level 0).** After a fresh QR link the number waits **24 hours** before bulk. It ends early once **40 messages** have been delivered. A start above level 2 skips this wait.
- **The rest after a ban.** After a WhatsApp ban the number rests 24h; a 2nd ban within 30 days rests 48h, a 3rd 72h. Re-answering the questions does **not** shorten this rest; only real deliveries can.

## 5. Today's limit: how it is worked out

**Step 1: the ceiling.** It is the lowest of:
- the level's day (the table above),
- the **plan's per-number day** (`channels.dailyCap`): Starter 250, Business 500, Enterprise 1000, read live, so a plan change reaches every number at once,
- the number's own `dailyLimit`, if one is set,
- the admin's level cap `sending.maxLevel`, if set.

The ceiling also caps the **level itself**, not only the count. A Starter number runs the L8 pace (30 an hour, 80 new chats) even if its history has earned more.

**Step 2: the growth cap (35% a day).** A level's day is a destination, not a minimum. Today's bulk is `min(ceiling, cap)`:

```
no delivered bulk before today     cap = startDaily              (the start level's day, or 10)
a clean day in the last 7          cap = max(10, bestCleanDay7 × multiplier)
no clean day in the last 7         cap = max(10, lastDayDelivered)    (holds flat)
```

- **`bestCleanDay7`**: the most bulk **delivered** in one day during the 7 days before today, leaving out days when a brake was on.
- **`multiplier`**: 1.35, or **1.15** if any brake was on in the last 7 days, so a number climbs back slowly after a problem.
- **Example (a dip day):** six days at 100, then one at 30 → the next day's cap is 135, because the number already proved 100.
- **Example (a promotion):** moving from L3 to L4 climbs 40 → 54 → 60, never 40 → 60 in one jump.
- **Example (all braked):** seven braked days → the cap holds flat at the latest day. It never jumps back to `startDaily` and never drops below 10.
- **Shadow-mode rows** (section 12) never count as brake days.

**Step 3: reductions.** Brakes halve or zero parts of the day (section 10).

**Step 4: a second, tenant-wide cap.** `bulk.dailyCap` and `bulk.monthlyCap` cap the whole business across all its numbers, and the billing quota caps monthly messages (section 16).

Messages over today's limit are **not lost**. They wait and go out the next day by themselves. A campaign shows "go out tomorrow".

## 6. Pacing: gaps, rests and quiet time

- **Gap between messages.** Each gap is drawn at random within the level's range. A message with media, or a carousel, waits **1.6×** longer.
- **Typing.** Before each message the number shows "typing…" for a few seconds, longer for longer messages (`humanTiming`, on by default).
- **Rests.** After roughly every `restEvery` messages (varied ±30%) the number takes a longer rest within the level's range.
- **Daily pace.** Each day gets a random pace factor (0.8-1.3) and **2-3 quiet windows**: stretches with no bulk, of the length shown in the table. Their total shrinks as the level grows.
- **Speed preset.** The plan sets it (`bulk.maxSpeed`; Starter Slow, Business Normal, Enterprise Fast) and the business cannot change it. Slow stretches the gaps 1.5×. On a QR level, Fast runs as Normal: the level's gaps are already the fastest safe pace.
- **Admin gap.** An admin gap (`minDelaySeconds` / `maxDelaySeconds`) can only **slow** a level down, never speed it up.
- **Hourly cap.** The level's `perHour` limits bulk in any rolling 60 minutes.

## 7. When messages may go out

Bulk waits (it is not dropped) until **all** of these are open:

| Window | Default | Who sets it |
|---|---|---|
| Recipient's daytime | 09:00-21:00 in the recipient's time zone (the business's if unknown) | Super admin (`sending.daytimeFrom` / `daytimeTo`) |
| Plan sending window | off | Super admin (`bulk.windowEnabled`, `windowStart`, `windowEnd`) |
| Quiet hours | off | Super admin (`quietHoursStart` / `quietHoursEnd` in the tenant's anti-ban settings) |
| The number's daily quiet windows | 2-3 a day (section 6) | Built in; the super admin can skip them (section 17) |
| The number's own business hours | none | The business, per number |

Replies are never held by these windows.

## 8. Message rules

Checked when a campaign starts. A failing rule refuses the start with a plain explanation.

| Rule | What it does |
|---|---|
| **Varied text** | On a QR number, identical text may go to at most **15** people (`sending.qrVaryAbove`; a stricter tenant setting wins). Bigger sends need `{name}`-style placeholders or spintax like `{Hi\|Hello}`. Rows with their own text are fine unless the same text repeats too often. |
| **Spam-shaped text** | Refused: mostly CAPITAL letters (over 60% of 15+ letters), more than 5 emojis, more than 3 "!" or any "!!!". |
| **Opt-out line** | Only the campaign's "Add opt-out line" box adds "Reply STOP to stop messages"; nothing is added on the server. The box starts ticked for a business's first campaign and unticked after that. |
| **Blocked words** | Words the admin lists per tenant (`limits.blockedWords`, `templates.blockedWords`) refuse a template or send. |
| **Buttons** | QR numbers send buttons, lists and menus as a numbered text menu. A typed "1" or the option's title counts as a tap. Interactive messages can be turned off per plan (`campaigns.allowInteractive`). |

Links and media are **no longer limited by level**. Any number may send links, short links, images, files and carousels.

A **carousel** on a QR number goes as the main text, then one plain image per card with the card's text and options as its caption (`sending.carouselImages`, on by default). No album message: iPhones never showed photos tied to a Baileys album. WhatsApp itself groups 4+ photos in a row into a grid. Each message counts as a part.

A file from the media library is uploaded to WhatsApp **once per hour**, not once per recipient (`mediaCache` in `transports/baileys.js`, keyed by kind and file path, 200 files at most). A 5-card carousel to 1,000 people is 5 uploads, not 5,000.

## 9. Recipient rules

- **One a day.** On a QR number, a person gets at most **one** bulk message per 24 hours. The limit is lifted once the number reaches level 5, or when the business skipped the start questions (`recipientCap` in `campaign/manager.js`).
- **New chats.** People who never chatted with the number use its **new-chat budget** (the level's "new chats / day"). People who wrote in before are not limited by it. A list made only of strangers can take several days, and the campaign says so.
- **Opt-outs.** Anyone who replied STOP (or stopall, unsubscribe, unsub, cancel, quit, optout, end, remove me, do not message, the Hindi and Hinglish band karo, mat bhejo, nahi chahiye, message mat karo, बंद करो, मत भेजो, नहीं चाहिए, and any admin-added words) is never sent bulk again. START, subscribe or opt in reverses it.
- **Warm first.** A campaign queues people who wrote to the number before ahead of strangers (each group shuffled). Their replies come early, and strangers left at the end of the day wait for the next day's new-chat budget.
- **List check at import.** The contacts import preview flags, for the mapped phone column, numbers that are not valid, repeats, numbers that don't look like Indian mobiles (+91 then 10 digits from 6-9) and numbers outside the default country. Nothing is looked up on WhatsApp.
- **Opt-in only.** With `bulk.requireOptIn` on, only contacts who opted in receive bulk.
- **Not on WhatsApp.** Before a first message to a stranger the number checks the recipient is on WhatsApp. Results are cached 24h. A "not on WhatsApp" result is recorded separately and never counts as a failure.
- **Maximum list size.** `bulk.maxRecipients` and the tenant's `maxContactsPerCampaign`; the stricter one wins.

## 10. Brakes: sending less when signals go bad

Brakes are checked continuously. A health scan runs every 10 minutes for each connected number, whether or not it is sending.

| Brake | Fires when | Effect | Default thresholds (editable) |
|---|---|---|---|
| **Reply rate** | 40+ people reached in 48h and under 15% replied | Bulk, new chats and the hourly cap are **halved** | 40 reached, 15% |
| **Reports** | 3 spam complaints within 72h (an incoming message with complaint words, from someone we sent to) | New chats wait until 72h after the last one | 3 |
| **Blocks** | Blocks + reports over 2% of the week's deliveries (40+) | New chats wait | 40, 2% |
| **Failures** | Over 3% of 20+ sends failed in 24h | New chats wait | 20, 3% |
| **Restricted** | WhatsApp says the number is limited, or **3 rate limits (429) in an hour** | New chats and number checks wait (24h for the 429 case) | — |
| **Delivery** | 20+ messages sent 2-24h ago and under 85% delivered | **No bulk or new chats for 12h** | 20, 85% |
| **Stuck** | Over 20% of those messages are still on one tick | **No bulk or new chats for 12h** | 20% |
| **Unstable** | More than 8 connection drops in an hour | **No bulk or new chats for 8h** (never a demotion) | 8 |
| **Ban** | WhatsApp banned the number | The rest after a ban (section 4); its history restarts | — |

How a **block** is decided:
- Each campaign message is judged **once**, at 48 hours.
- It counts as a block only if all three hold:
  1. it is still on one tick;
  2. that person sent nothing and received no delivery from us between hour 24 and hour 48;
  3. the number's own delivery rate over that time is at least 95%.
- Below 95% delivery the problem is the number, not the person, so it is left to the stuck brake. One incident trips one brake, never two.
- A number that stops sending cannot build up blocks.

Delivery, stuck and unstable start in **shadow mode** (section 12). All the others always apply.

## 11. Levels that go down: demotion, probation, idle

Health is judged over the last 7 days, or since the last demotion if that is later. Rates are judged once 20 messages were sent; the reply rate once 40 people were reached.

- **Promotion** needs the level's needs **and** good health:
  - delivered ≥ 92%
  - stuck ≤ 5%
  - failed ≤ 3%
  - replied ≥ 10%
- **Demotion:**
  - delivered under 85% or stuck over 20% → **down 2 levels**;
  - delivered under 90% or replies under 5% → **down 1 level**.
  - Never below level 1.
- **Probation:** after a demotion there is no promotion for **48h**. After that, the number needs **two passing health checks at least 6h apart**; a failing check restarts the count.
- **Idle decay:** if nothing was delivered in the 3 days before today, the day runs one level lower, and one more for every further 3 quiet days, down to the start level. It recovers as soon as the number sends again.

## 12. Shadow mode

`sending.brakesMode` is **`shadow`** by default. It covers the delivery, stuck and unstable brakes, demotion, probation and the promotion health check.

- **In shadow mode:** they are calculated and logged, and shown to the super admin in each number's history, but they **never slow or stop sending**.
- **Shadow review:** Admin › Channels has a "Shadow review, last 7 days" table: every number and kind, how often it fired, and the hours a brake would have paused bulk (`GET /api/admin/shadow-review`).
- **Switching on:** review about 7 days of triggers, then set `sending.brakesMode = enforce`.
- **Engagement reward (shadow only):** with 97%+ delivered and 30%+ replied over 7 days, the delivered-volume needs of the next levels would drop by 25% (the active-days need stays). It is only logged (`level:engaged`), never applied.
- **Other brakes:** reply rate, reports, blocks, failures, restricted and ban always apply.

## 13. Campaign-level stops

| Stop | When |
|---|---|
| Failure auto-pause | A running campaign pauses when failures pass `failureStopPercent` or `campaigns.autoPauseFailurePct` (the stricter one; 0 = off) |
| Block-rate pause | Campaigns pause when blocks + reports pass `sending.blockPausePercent` (5%) of the week's sends, from 40 sent |
| STOP-rate pause | A running campaign pauses when over 3% of the people it reached replied STOP, from 50 reached. Not while safety is off or brakes are off |
| Daily or monthly cap reached | The campaign pauses and resumes by itself when the day or month allows |
| Kill switch | `bulk.killSwitch` on the platform stops all bulk everywhere; on a tenant, stops that tenant. Running sends stop at once |
| Tenant controls | Turning off a tenant's `sendingEnabled` or `campaignsEnabled` stops running campaigns; `automationsEnabled` holds workflows and auto-replies |
| Admin stop | The super admin can pause, resume or cancel any campaign, or stop all bulk for one tenant or for the platform |

## 14. Connection and WhatsApp errors

- **Rate limit (429 / "rate-overlimit").** The whole number pauses **90-120 seconds**, not just that message. Three in an hour trigger the Restricted brake.
- **Connection drops.** Drops reconnect with growing waits. More than 8 in an hour starts the 8h Unstable pause. The count resets when the server restarts; server restarts never count.
- **Error 500.** This Baileys version uses it for ordinary drops too. The saved login is cleared only after **3 in a row** with no successful connection, so one glitch never forces a new QR scan.
- **Error 411 (multidevice mismatch):** the login is cleared and a new scan is asked for.
- **Error 515 (restart required):** reconnects at once.
- **Logged out (401):** the login is cleared and an ops alert is sent. Our own logout never alerts.
- **Banned (403):** the number stops; the rest after a ban applies, and an alert is sent.
- **QR codes:** each code works for 180 seconds. After 3 unscanned codes the page shows "QR expired, try again".

## 15. Several numbers: routing

With `channels.routing = quota`, each send picks a number. Numbers under a brake are skipped. Among the rest, the one with the most quota left wins, and ties go to the better delivery rate. In shadow mode the new brakes do not affect routing.

## 16. Tenant-wide limits, plans and billing

| Limit | Default | Notes |
|---|---|---|
| Per-number day (`channels.dailyCap`) | Starter 250 · Business 500 · Enterprise 1000 | Read live |
| Plan speed (`bulk.maxSpeed`) | Slow · Normal · Fast | Set by plan |
| Business daily / monthly cap (`bulk.dailyCap`, `bulk.monthlyCap`) | off | Across all numbers |
| Billing: messages per month | from the plan (Starter 1,000 · Business 25,000 · Enterprise unlimited) | Over the quota: sends refused, campaigns paused, auto-replies go quiet. Admin override per tenant; 0 = unlimited |
| Billing: API requests per month | from the plan (Starter 0 = no API access) | 429 when over |
| Billing: storage | from the plan | 413 when over |
| Campaign limits | `campaigns.maxRunning`, `maxScheduled`, scheduling, follow-ups, interactive | Per plan or tenant |
| Tenant controls | `sendingEnabled`, `campaignsEnabled`, `automationsEnabled` | Admin on/off switches per tenant |

An expired subscription blocks writes (402).

## 17. What the super admin can change

Everything below is a **platform-policy** setting. It can be set for the whole platform, per plan, or per tenant (tenant beats plan beats platform). `null` resets a value, every change is audited, and tenants cannot change any of it.

**Sending tables** (Rules tab, *WhatsApp channels*):
- `sending.levels`: every cell of the level table (days, new chats, per hour, gaps, rests, quiet time, needs).
- `sending.maxLevel`: highest level a tenant's numbers may reach.
- All brake thresholds: reply rate, blocks, failures, reports, delivery, stuck, block-rate pause, `qrVaryAbove`.
- `sending.daytimeFrom` / `daytimeTo`: the recipient's daytime window.
- `sending.brakesMode`: `shadow` or `enforce`.

**Admin overrides** (Rules tab, *Admin overrides*; all off by default):

| Switch | Effect | Still applies |
|---|---|---|
| **Skip quiet time** | Bulk keeps sending through the number's daily quiet windows and the tenant's quiet hours | Recipient daytime, plan window, gaps, limits, brakes |
| **Skip new-link wait** | A newly linked number starts bulk at once | The rest after a ban, levels, limits, brakes |
| **Skip growth cap** (`sending.skipGrowthCap`) | A day may reach the level's full day at once, without the 35% climb over the best recent day | Levels, plan day, gaps, brakes |

**Per number** (Admin › Services › WhatsApp channels):
- **Pin level:** set a number to any level 0-11. It skips the wait and idle decay; brakes and caps still apply. Choosing a level above the earned one shows a ban-risk warning. A ban or a new phone clears the pin.
- **End wait:** shown as an orange "New-link wait" pill in the number's row; ends that number's wait after linking now.
- **Brakes off** (shield button): turns the number's brakes off for 1 hour to 30 days (`PUT /api/admin/numbers/:id/brakes { hours }`, `null` turns them back on). Ignored while off: reply, report, block, failure, ban, delivery, stuck and unstable brakes, and the campaign pause on blocks. Still applies: WhatsApp's own restriction, the level, the plan day, the growth cap and the pace. A ban after it was set turns the brakes back on.
- **Business left sending safety**: an account admin can leave safety from the number page (`POST /api/safety/custom/exit`, the same consent fields as custom limits, kind `safety_exit`, asked again on every exit; `DELETE` rejoins). It forces `safetyEnabled: false` over every other layer for all the business's numbers. It is not gated by `allowCustomSafety`. The tenant panel shows who left and when.
- **Pause, resume, force disconnect, move to another business.** Moving clears the pin, the brakes-off and the answers.
- **History:** level changes, brake events, shadow triggers and the delivery window, for each number.

**Per tenant:**
- Anti-ban settings: daily limit, delays, rests, rate, retries, `recipientDailyCap`, quiet hours, failure stop.
- Limits: numbers, users, templates, list size, media size, blocked words.
- Controls, plan, quotas, security, and stop all bulk.

## 18. What the business sees

The business never sees levels, warm-up or brakes by name. Each number shows one line:

- "**N messages a day** · rises gradually to **{plan}** a day", or
- "Answer 2 questions to start sending", or
- a plain reason when sending is held, for example a WhatsApp ban recovery, a WhatsApp restriction, a pause, or "A newly linked number waits before bulk sending. It starts Tue 14:05."

The campaign review page keeps only the banners that explain a wait: unanswered questions, and messages that go out tomorrow.

## 19. Alerts and audit

**Ops alerts** go to `OPS_ALERT_WEBHOOK`. Each is signed with HMAC-SHA256 (`X-Signature: t=…,v1=…`, with a second signature while the secret is being changed), and is also logged and written to the audit log. Alerts are sent for:
- an unexpected logout or a ban,
- a business's 2nd ban within 30 days across its numbers (`tenant_bans`): every number of that business stays at its current level for 14 days from that ban,
- the Unstable brake,
- the Delivery or Stuck brake (shadow triggers are labelled as shadow),
- "messages waiting but nothing sent for 6 hours during sending hours",
- a failed backup or re-encryption.

There is at most 1 alert per kind per number per hour and 30 an hour across the platform, plus an hourly summary of any held back.

**Audit log entries:**
- every admin policy change (`policy.change`), pin (`channel.admin.level_pin` / `level_unpin`), brakes off / on (`channel.admin.brakes_off` / `brakes_on`), a business leaving or rejoining safety (`safety.exit` / `safety.rejoin`) and ended wait (`channel.admin.end_link_wait`);
- number answers and skips (`channel.start`, `channel.start_skip`);
- every computed level change (`safety_events` kind `level` or `shadow`, with a reason such as promote, demote_delivery, demote_stuck, demote_replies, hold_probation, engaged or idle);
- a snapshot on every ban (`safety_events` kind `ban_snapshot`, JSON detail): the level, brakes, today's budgets, 48h replies, the delivery window and the 7-day health just before the ban, kept after the history restarts.

## 20. Where it lives in the code

| Area | File |
|---|---|
| Levels, brakes, health, block rule, typing, quiet windows | `server/src/campaign/humanize.js` |
| Today's allowance, growth cap, pacing, variation rule | `server/src/campaign/safety.js` |
| The send queue, holds, retries, 429 backoff, scans | `server/src/campaign/manager.js` |
| Every input (deliveries, replies, brakes) read from the database | `server/src/db.js` (`sendingLedger`, `deliveryWindow`) |
| Admin-editable tables, overrides, start levels | `server/src/policy/levels.js` |
| Plan day, routing, ban guard, per-number admin actions | `server/src/policy/channels.js`, `server/src/policy/channelOps.js` |
| Kill switch, campaign caps, tenant controls | `server/src/policy/campaignOps.js`, `server/src/policy/bulk.js` |
| Connection handling | `server/src/transports/baileys.js` |
| Opt-out keywords | `server/src/autoreply/optout.js` |
| Questions popup, number card | `web/src/app/connection/number-questions.*`, `web/src/app/channels/channel-card.*` |
| Admin number view | `web/src/app/admin/channels-ops.*` |
| Operations, keys, backups, alerts | `docs/OPS.md` |
