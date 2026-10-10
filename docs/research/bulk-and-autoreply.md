# Bulk messaging and auto-replies: competitor research

Researched 2026-10-10. Vendor features come from vendor docs and marketing, so treat them as claims. "Us today" comes from reading `server/src/autoreply/engine.js`, `server/src/campaign/manager.js`, `server/src/campaigns/`, `server/src/messaging/interactive.js`, `server/src/protocol.js` and the web `campaign` and `auto-replies` pages.

Legend: **Y** = has it, **P** = partial or only on some plans, **N** = doesn't have it, **?** = couldn't confirm.

## 1. Feature matrix

### A. Bulk / broadcast

| Feature | WATI | AiSensy | Gallabox | Interakt | Respond.io | WA-Web tools (extensions, Whapi, Wablas) | Us today |
|---|---|---|---|---|---|---|---|
| CSV/XLSX import + column mapping | Y | Y | Y | Y | Y | Y (CSV, no mapping) | P: import works, but columns are fixed (`message` column per row) |
| Variables + fallback values | Y | Y | Y | Y | Y | P (`{name}` only) | Y: `{var\|default}` and spintax |
| Preview / test send | Y | Y | Y | Y | Y (send to yourself) | P | Y: preview flags missing variables per recipient |
| Media (image, video, doc) | Y | Y | Y | Y | Y | Y | Y |
| Interactive buttons / list / CTA | Y (template buttons) | Y | Y (+ WhatsApp Flows) | Y | Y | P (Whapi only, "as-is", unreliable) | P: `interactive.js` validates and renders a numbered-text fallback, but outbound Cloud sending isn't wired up |
| Approved Cloud templates with variables | Y | Y | Y | Y | Y | n/a | P: Cloud transport sends one configured `templateName` with no parameters |
| Scheduling | Y | Y | Y (up to 30 days ahead) | Y | Y | Y | Y (`scheduled_at`) |
| Recurring schedule | ? | ? | N (only "Repeat", which copies a broadcast) | ? | Y (via workflows) | P | N |
| Throttling / anti-ban pacing | n/a (Meta tiers) | n/a | n/a | n/a | n/a | Y (random 3-30 s delays, batches) | Y: adaptive pacing, daily cap, quiet hours, sending window, dedupe, variation check |
| Retargeting (read and didn't reply, clicked, replied with X) | Y (Pro and up) | Y | Y (adds clicked, replied to Flow, failed) | ? | P (segments) | N | N |
| A/B testing | N | P (blog guidance) | N | N | N (needs routing workaround) | N | N |
| Analytics: sent/delivered/read/failed | Y | Y | Y (+ "not on WhatsApp") | Y | Y | P | Y |
| Analytics: replied / clicked / cost | Y / P / P | Y / Y / P | Y / Y / ? | Y / ? / ? | Y / ? / ? | N | N / N / N |
| Automatic retries | ? | Y (up to 3) | Y | ? | ? | P | Y (`RetryPolicy`) |
| Opt-out handling | Y | Y | Y (Unsubscribed status) | Y | Y | N | Y (STOP/START keywords) |
| Quality rating / tier visibility | Y | Y | Y | Y | Y | n/a | P: quality is fetched for the health check only |

### B. Auto-replies / chatbot

| Feature | WATI | AiSensy | Gallabox | Interakt | Respond.io | WA-Web tools | Us today |
|---|---|---|---|---|---|---|---|
| Match types | Exact, Contains, Fuzzy (80% similarity) | Keyword | Keyword | Keyword | Keyword + AI intent | Exact/contains | Exact, Contains, Regex, Fallback (the FAQ module has Dice fuzzy matching, but the auto-replies don't use it) |
| Rule priority | Exact > Contains > Fuzzy, oldest first | ? | ? | ? | Workflow order | list order | List order, first match wins |
| Business hours + out-of-office | Y | Y (with timezone) | Y (21 slots, away message at most once a day) | Y (several slots a day, plus a "delayed response" nudge) | Y | P | N (sending windows only apply to outbound bulk) |
| Welcome message (new chat) | Y (only if no keyword matched) | Y | Y | Y | Y | P | N |
| Default fallback | Y | Y | Y | Y | Y | P | Y |
| Menus / flows / button replies | Y | Y (paid add-on) | Y | Y | Y | P (numbered text) | P: workflow engine plus `matchReply` (taps or typed numbers) |
| Media replies | Y | Y | Y | Y | Y | Y | N (replies are text only) |
| Human handoff | Y (route to team) | Y | Y | Y | Y (AI hands over with context) | N | Y (inbox takeover and handback) |
| AI replies / agents | Y (add-on) | Y (separate product) | Y (Essential plan and up) | Y (extra cost) | Y | P (via webhook) | N (FAQ matching only) |
| Per-rule analytics | ? | ? | ? | ? | Y | N | N |
| Cooldown / once-per-period | ? | ? | Y (away message once a day) | ? | Y | ? | **Mismatch**: the UI saves `cooldownSec`, but the engine says "No cooldown" and ignores it |
| Testing console | P | P | P | P | Y | N | Y (test text and preview endpoint) |

## 2. What we should offer

Items marked **[Both]** work on both Cloud API and WhatsApp Web.

### Must
1. **Retargeting from campaign results [Both]**: "delivered, not read", "read, no reply", "replied", "picked option X", "failed". WATI, AiSensy and Gallabox all lead with this. We already store `messages.campaign_id` and statuses, so it is a saved audience filter.
2. **Reply tracking per campaign [Both]**: count an inbound message from a recipient within N hours as a reply, and record which button or number they picked. Retargeting and the "replied" metric both depend on it.
3. **Business hours + out-of-office + welcome rules [Both]**: every competitor has these. Follow the WATI order: keyword rule > welcome/OOO > fallback. Send the away message at most once per contact per day.
4. **Honour the auto-reply cooldown [Both]**: the UI already saves `cooldownSec`, and today the engine ignores it. Either implement it or remove the field.
5. **Cloud template sending with parameters + 24h-window routing [Cloud]**: send a free-form message inside the window and an approved template with mapped variables outside it. Today we send only one fixed template, so cold Cloud campaigns fail (error 131047).
6. **Wire up the interactive messages [Both]**: native buttons, lists and CTA on Cloud. On WhatsApp Web, send the numbered-text fallback from `interactive.js`. Taps and typed numbers come back through `matchReply` into rules and workflows.
7. **Column mapping on import [Both]**: map sheet columns to phone, name and custom fields, with a phone-normalisation preview. The other products all have this.
8. **Handle error 131049 [Cloud]**: don't retry a marketing template to the same user within 24 hours. Our generic retry policy makes this worse.

### Should
9. **Media + interactive auto-replies [Both]**: a rule replies with an image, document or menu, not only text.
10. **Fuzzy matching for auto-replies [Both]**: reuse the Dice matcher from `knowledge/` with a threshold (WATI defaults to 80%).
11. **Per-rule and per-campaign analytics [Both]**: rule hits, replies, opt-outs triggered, and the estimated Cloud cost (category × country rate).
12. **Recurring campaigns [Both]**: daily, weekly or monthly on top of the scheduler (we already have leases and retries). Few competitors do this cleanly.
13. **Quality rating + messaging-limit panel [Cloud]**: show the tier (250 / 2K / 10K / 100K / unlimited, set per business portfolio since Oct 2025) and hold back a campaign that would exceed it.
14. **WA-Web safety profile [Web]**: warm-up ramp for new numbers, a cap on messages to unsaved numbers, random delays, and an "only opted-in contacts" check. Keep it opinionated, because ban risk is the main complaint about WA-Web tools.
15. **Marketing opt-out button [Both]**: a "Stop promotions" quick reply on marketing sends, handled by the existing STOP flow.

### Could
16. **A/B split [Both]**: two message variants with a percentage split, and the winner chosen on reply rate. Almost nobody has it natively, so it would set us apart.
17. **AI fallback reply [Both]**: when no rule matches, an LLM grounded on the FAQ answers, with handoff on low confidence.
18. **Retry-failed button [Both]**: one click re-queues the failed recipients, after the 24-hour cool-off for 131049.
19. **WhatsApp Flows (forms) [Cloud]**: Gallabox retargets on Flow submissions.

## 3. WhatsApp policy constraints

**Cloud API (Meta)**
- **24-hour customer service window**: free-form text, media and interactive messages are allowed only within 24 hours of the user's last message. Outside the window you must send an approved template (otherwise error 131047).
- **Pricing (since 1 Jul 2025)**: charged per delivered message, by template category (Marketing, Utility, Authentication) and recipient country. Service replies are free inside the window, and so are utility templates since Jul 2025. Utility templates must be non-promotional. Meta recategorises misused templates.
- **Per-user marketing cap**: Meta silently limits how many marketing templates a person receives from all businesses combined. Blocked sends fail with error 131049. Wait at least 24 hours before resending. Utility messages and in-window messages are generally exempt.
- **Messaging limits**: unique users per rolling 24 hours, at the business-portfolio level: 250 → 2K → 10K → 100K → unlimited. Meta upgrades the limit when you use at least half of it with Medium or High quality.
- **Reply buttons**: at most 3, title at most 20 characters and unique, ID at most 256 characters, body at most 1024 characters, footer at most 60. The header can be text, image, video or document.
- **List messages**: at most 10 rows across at most 10 sections. Button text and footer at most 20 and 60 characters, section and row titles at most 24, row description at most 72, row ID at most 200, body at most 4096, text-only header at most 60.
- **CTA URL interactive message**: one URL button, display text at most 20 characters, body at most 1024 characters.
- **Template buttons**: at most 10 in total. Up to 10 quick replies, at most 2 URL buttons, 1 phone button and 1 copy-code button. Quick replies and action buttons must be grouped, not mixed. When there are more than 3 buttons, the rest collapse behind "See all options". Marketing templates should carry the opt-out quick reply.

**WhatsApp Web (whatsapp-web.js / Baileys)**
- Unofficial, and against WhatsApp's terms for bulk use. Numbers get banned for unsolicited bulk sends, and no delay setting "guarantees" safety.
- **Buttons and lists no longer render reliably**: both libraries have deprecated or broken them. Only Whapi's patched stack claims buttons work, "as-is". Always send the numbered-text fallback (our `renderFallbackText`) and match typed replies (`matchReply`).
- There are no templates, no 24-hour window and no per-message cost. The real limits are ban risk, warm-up, and the session staying connected.

## 4. Sources
- WATI broadcast statistics and retargeting: https://support.wati.io/en/articles/11463454-understanding-broadcast-statistics
- WATI first broadcast and scheduling: https://support.wati.io/en/articles/11462957-how-to-send-your-first-broadcast
- WATI keyword actions (Exact, Contains, Fuzzy): https://support.wati.io/en/articles/11463176-understanding-keyword-actions
- WATI welcome and OOO rules: https://support.wati.io/en/articles/11561609-understanding-built-in-automation-rules-out-of-office-ooo-and-welcome-message
- Gallabox retargeting: https://docs.gallabox.com/broadcast/broadcast-re-targeting
- Gallabox repeat broadcasts: https://docs.gallabox.com/broadcast/repeat-and-retarget-broadcasts
- Gallabox working hours: https://docs.gallabox.com/whatsapp-channel/configuration-message-settings
- AiSensy retargeting: https://m.aisensy.com/blog/whatsapp-retargeted-campaigns-feature/
- AiSensy campaign analytics: https://aisensy.com/tutorials/whatsapp-broadcast-campaign-analytics
- AiSensy welcome and off-hours replies: https://wiki.aisensy.com/en/articles/11502702-how-to-set-up-welcome-off-hours-auto-replies-in-aisensy-app
- AiSensy A/B testing guide: https://m.aisensy.com/blog/ab-test-whatsapp-marketing-campaigns/
- Interakt automation templates: https://www.interakt.shop/resource-center/whatsapp-automation-message-templates/
- DoubleTick broadcasting: https://doubletick.io/broadcasting
- DoubleTick Oct 2025 limit changes: https://learn.doubletick.io/whatsapp-business-api/upcoming-changes-to-whatsapp-messaging-limits-effective-october-7-2025
- Respond.io AI agents and handoff: https://respond.io/faqs/is-respondio-right-for-ai-agents-that-close-sales-not-just-answer-faqs
- Respond.io messaging limits: https://respond.io/help/whatsapp/whatsapp-messaging-limits
- Zoko AI assistant: https://www.zoko.io/services/whatsapp-ai-virtual-business-assistant
- Kommo knowledge base: https://support.kommo.com/
- Twilio message scheduling: https://twilio.com/docs/messaging/features/message-scheduling
- Twilio content types: https://static1.twilio.com/docs/content/content-types-overview
- Meta reply buttons: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
- Meta list messages: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
- Meta CTA URL messages: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-cta-url-messages
- Meta per-user marketing limits (131049): https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits/
- July 2025 per-message pricing: https://help.zoho.com/portal/en/community/topic/whatsapp-pricing-changes-pay-per-message-starting-july-1-2025
- Template button limits: https://docs.bird.com/api/touchpoints-api/supported-projects/whatsapp-approved-message-templates/creating-whatsapp-message-templates/text-template-blocks
- Marketing opt-out button: https://support.qiscus.com/hc/en-us/articles/13766924007577
- Whapi buttons status: https://support.whapi.cloud/help-desk/faq/current-status-of-buttons-on-whatsapp
- WA-Web libraries dropping buttons: https://dev.to/purpshell/buttons-and-lists-get-deprecated-by-many-libraries-54h
- Wablas overview: https://www.openassistantgpt.io/integrations/automation-platforms/wablas-whatsapp-api-gateway-service-for-business
