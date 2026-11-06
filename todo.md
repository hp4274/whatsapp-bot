# To do

Tick each item when it's done and checked in the browser.

## App shell and home

- [x] **Connect a number first.** After login, if the business has no connected WhatsApp number, show a popup that blocks the whole app until a number is connected. The popup links to the connect flow and is the only thing the user can use.
  - Files: `web/src/app/app.ts`, `web/src/app/app.html`, `web/src/app/connection/`
- [x] **Home: remove the WhatsApp number bar.**
  - Files: `web/src/app/home/home.html`
- [x] **Home: restructure plan usage.** Group it clearly and drop the rows for things we no longer offer, such as "API requests".
  - Files: `web/src/app/home/plan-usage.ts`, `plan-usage.html`, `plan-usage.scss`
- [x] **Sidebar: remove "New Campaign".** The New campaign button on the Campaigns page keeps opening it, as before.
  - Files: `web/src/app/app.ts:282`

## Campaigns

- [x] **Remove quiet time everywhere.** This covers the "quiet time today" line in Campaigns and the quiet-hours rule in the sending engine.
  - Web: `web/src/app/campaigns/`, `web/src/app/campaign/draft.ts`, `steps/review-step.ts`
  - Server: `server/src/campaign/humanize.js`, `safety.js`, `manager.js`
- [x] **New campaign: upload a file comes first,** before "Your contacts".
  - Files: `web/src/app/campaign/steps/audience-step.*`
- [x] **New campaign: keep every CSV column,** not only name and number.
  - The user chooses which columns to keep or remove.
  - Each kept column becomes a variable, shown so the user can insert it into the message.
  - Rework the after-upload screen so it is easy to use.
  - Files: `audience-step.*`, `draft.ts`, `message-step.*`; the server import code needs to keep the extra fields.
- [x] **Fix buttons, call to action and list menu.** Find out why they fail. Note: QR numbers can't send native buttons or lists, so the fix may be to send them as numbered text. Check this before building anything.
  - Files: `web/src/app/campaign/interactive/`, `server/src/transports/baileys.js`
- [x] **Show the estimated time to send all messages.** Base it on the number count, the gaps between messages and the daily limits.
  - Files: `steps/review-step.*`, campaign detail

## Numbers

- [x] **Remove the word "Baileys" from everything the user sees.** Admin-only screens can stay. Places to change:
  - `web/src/app/channels/channel-meta.ts:9` ("WhatsApp QR (Baileys)")
  - `server/src/policy/channelOps.js:111` (error message)
  - Connection errors in `server/src/transports/baileys.js`: lines 65, 235, 262, 338, 344, 351, 415 and 1026
  - The template review labels in `web/src/app/admin/template-review.html`
  - The customer docs (`docs/`)
- [x] **New number questions: question 2 becomes "How often do you use WhatsApp?"** Keep the level it seeds sensible.
  - Files: `web/src/app/connection/number-questions.ts`, plus the server code that maps the answers to a level
- [x] **Skipped questions can be answered later from Home.**
  - Files: `web/src/app/home/`, `web/src/app/connection/number-questions.ts`

## Super admin → user dashboard

- [x] **A daily limit set in super admin (for example 250,000) must show in the user dashboard.**
  - Find where the dashboard reads its day limit and why it ignores the admin's value.
  - Then check that every admin change (limits, plan, rules) shows on open user pages straight away.
  - Files: `server/src/app.js` (limits and touchTenants), `web/src/app/home/`, `web/src/app/channels/`

## Landing page

- [x] Fix text colour contrast (WCAG AA).
- [x] Make the hero slider's progress indicator smaller.
- [x] Section 2, last box ("Write once, send to all"): the paper-plane art is cut off. Fix it.
- [x] Replace the names "Arman Ali" and "Sana Qureshi" with different names.
- [x] Footer: the "W" and "V" in the Wuzie logo overlap. Fix the spacing.
- Files: `web/src/app/landing/landing.html`, `landing.scss`

## Before calling it done

- [x] Server tests pass (`cd server && npm test`).
- [x] The web build passes (`cd web && npm run build`).
- [ ] Each screen above is checked in a browser. Checked: the popup, Home, plan usage, the 250,000 limit, Campaigns, the column editor and the landing page. Not yet checked: the Review step estimate, the button/list note, the Home card for skipped questions (needs a real QR number) and an agent's view of the popup.
