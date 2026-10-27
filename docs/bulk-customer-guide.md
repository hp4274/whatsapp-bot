# Bulk Messaging: A Guide for New Customers

Written for customers, in plain words. The full rule reference for the team is [bulk.md](bulk.md); if a rule changes there, update the numbers here too.

## How it works

You send bulk messages from your own WhatsApp number, linked to the system by scanning a QR code. The system then sends for you slowly and in a human pattern, so WhatsApp doesn't treat your number as spam.

This is not WhatsApp's paid Business API. It works like WhatsApp Web: your phone stays the owner of the number, and the system acts as one more linked device. That's why it's quick to start and has no per-message fees. It's also why WhatsApp can ban the number if it is pushed too hard, so the system controls the pace for you.

What happens to a campaign:

1. You choose a list of contacts and write the message, with images, links, a menu or a carousel if you like.
2. The system checks the campaign against its safety rules before anything is sent.
3. Messages go out one at a time with random gaps, a "typing…" moment and regular breaks, the way a person sends from a phone.
4. When the number reaches its limit for the day, the campaign pauses and continues the next day. Nothing is lost.
5. You follow it live: sent, delivered, read, replied and failed for every contact.

## Getting started

Bulk sending starts about 24 hours after you link a number. That first-day rest matters: a number that starts mass-sending minutes after a new device links is a classic spam pattern.

1. **Link your number.** In the app, open the number page and scan the QR code with WhatsApp on your phone, under *Linked devices*. Keep the phone charged and online most of the time.
2. **Answer two questions** about the number. Your answers set how fast it starts:
    - *How old is this number on WhatsApp?* Under 1 month, 1–6 months, 6–24 months, or 2+ years.
    - *How has it been used?* New or hardly used, light personal use, regular daily chats, or busy business number.
3. **Wait out the rest.** You can still reply to people and send single messages during the rest. Only bulk and new-chat sending waits. If the number is old and already busy, the rest can end early once 40 messages have been delivered.
4. **Upload your contacts** and send your first campaign.

An old, busy number starts higher (up to level 7). A brand-new number starts at level 2, with small daily amounts. You can skip the questions, but then the number starts at your plan's full daily amount, and the app asks you to accept the higher ban risk first.

**Only message people who know you.** Your contacts should be customers who gave you their number and expect to hear from you. Lists that were bought or scraped are the fastest way to get a number banned.

## Sending levels and speed

Every number has a level, from 1 to 11. A new number sends 10 messages a day; a proven one can reach 1,000. The number moves up on its own as it builds a clean history: days of activity, messages delivered, and bulk messages delivered. You never have to raise it by hand.

| Level | Name | Messages a day | New chats a day | Per hour | Gap between messages | To reach it |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | First steps | 10 | 3 | 5 | 1.5–5 min | Start |
| 2 | Settling in | 20 | 5 | 8 | 1–3 min | 3 days, 8 delivered |
| 3 | Building | 40 | 10 | 10 | 45 s–2.5 min | 6 days, 40 delivered |
| 4 | Growing | 60 | 15 | 12 | 40 s–2 min | 9 days, 100 delivered, 40 bulk |
| 5 | Steady | 100 | 20 | 15 | 30 s–2 min | 12 days, 220 delivered, 90 bulk |
| 6 | Trusted | 150 | 30 | 20 | 30–90 s | 17 days, 500 delivered, 200 bulk |
| 7 | Established | 200 | 50 | 30 | 20–90 s | 24 days, 1,000 delivered, 400 bulk |
| 8 | Proven | 250 | 80 | 30 | 20–60 s | 40 days, 2,500 delivered, 1,000 bulk |
| 9 | Reliable | 400 | 120 | 45 | 20–50 s | 40 days, 3,000 delivered, 1,500 bulk |
| 10 | Strong | 650 | 200 | 70 | 20–40 s | 40 days, 6,000 delivered, 3,000 bulk |
| 11 | Peak | 1,000 | 300 | 100 | 15–35 s | 45 days, 12,000 delivered, 6,000 bulk |

What the columns mean:

- **New chats** are people who have never chatted with your number. They count more than regular contacts, so they have their own smaller limit.
- **Gap** is picked at random within the range for every message, so no two campaigns follow the same pattern.

The pace also includes breaks:

- **Short rests.** Every few messages the number stops for 10–60 minutes, like a person putting the phone down.
- **Quiet hours.** Each day has one to eight hours with no bulk sending, longest for new numbers.
- **Recipient daytime.** Bulk goes out only between 9 am and 9 pm in the recipient's time.
- **Steady growth.** A day's amount can't jump more than 35% above the best clean day of the last week, even after the level goes up.

In practice, a new number takes about six weeks to reach full speed. That is normal and it's the safest route.

## Safety brakes

The system watches how people react to your messages and slows down or stops when the signs turn bad. You don't need to do anything: a brake lifts by itself once the numbers recover. Each brake shows on the number's page with the reason.

| What the system sees | What it does |
| --- | --- |
| Fewer than 15% of people reply (after 40+ reached in 48 hours) | Bulk, new chats and the hourly limit are cut in half until more people reply |
| More than 2% of people block you (after 40+ delivered in 7 days) | Messages to new chats wait until the rate drops |
| More than 3% of sends fail (after 20+ in 24 hours) | Messages to new chats wait; usually wrong numbers on the list |
| 3 spam reports within 72 hours | New chats close for 72 hours |
| Blocks reach 5% (after 40+ sent in 7 days) | Campaigns pause |
| WhatsApp says "slow down" (rate limit) | Sending backs off for 90 seconds or more |
| WhatsApp bans the number | The number rests 24 hours; a 2nd or 3rd ban within 30 days rests 48–72 hours, and it starts again from a low level |

The system also checks every campaign before it starts:

- **The message must vary.** The same exact text can go to at most 15 people. For a bigger list, add the person's name with a placeholder such as `{name}`, or use variations such as `{Hi|Hello|Hey}`.
- **An opt-out line** ("Reply STOP to stop messages") can go at the end of each message. The "Add opt-out line" box is ticked for your first campaign, and you choose after that. We recommend keeping it on for new contacts. Anyone who replies STOP is removed from future campaigns, with or without the line.
- **Numbers not on WhatsApp are skipped** before sending, so they don't count as failures.

## What your customers see

Messages arrive as a normal chat from your number, with your name and profile photo. The campaign editor shows a phone preview of exactly how the message will look.

| You add | They see |
| --- | --- |
| Text, emoji, the person's name | A normal message |
| An image, video or document | The file with your text as its caption |
| A link | A tappable link |
| Buttons or a list | A numbered menu in the text ("Reply 1 for prices, 2 for timings"); people reply with the number |
| A carousel | A photo album: a grid in the chat that opens into a swipe viewer, each card's text and options as its caption |

**Why buttons become a menu.** Real WhatsApp buttons from a QR-linked number don't show on many iPhones, on WhatsApp Web or on the desktop app, and they raise the ban risk. A numbered menu shows on every device and works the same way.

**Why a carousel arrives as an album.** WhatsApp's business-style swipe carousel from a QR-linked number shows on WhatsApp Web, but Android phones and iPhones don't display it. So the cards go as a WhatsApp photo album: a grid in the chat that people tap and swipe through, with each card's text and options as its caption. Albums show on Android, iPhone, iPad, Mac and WhatsApp Web. A one-card carousel arrives as a single image.

## Plans and limits

Your plan sets the most bulk messages one number can send in a day. The number's level sets what it can send today, and the lower of the two always applies.

| Plan | Bulk messages per number per day | Level that reaches it |
| --- | --- | --- |
| Starter | 250 | 8 (Proven) |
| Business | 500 | 10 (Strong) |
| Enterprise | 1,000 | 11 (Peak) |

So on the Business plan, a brand-new number still starts at 10–20 a day and grows into the 500. To send more in a day, link more numbers: each number has its own level and its own daily amount, and the system can share a campaign across them.

Replies to customers and one-to-one messages aren't bulk, so they don't use this amount.

## Cautions

WhatsApp can ban any number at any time, and no tool can promise it won't. The system keeps the risk low; these habits keep it lower.

**Do**

- Message people who know your business and expect to hear from you.
- Use a number that has been on WhatsApp for a while and is used for normal chats too.
- Write messages people want to answer: a question, an offer, a reminder. Replies are the strongest sign of a healthy number.
- Use the person's name and vary the wording.
- Clean your list: remove wrong numbers and anyone who asked you to stop.
- Keep the phone with the number charged, online, and with WhatsApp updated.
- Answer replies quickly, from the app or the phone.

**Don't**

- Don't use bought, scraped or shared contact lists.
- Don't send the same message to everyone without a name or any variation.
- Don't fill the first messages from a new number with links; plain, personal text is safest while it builds trust.
- Don't run bulk campaigns from the same number with another bulk tool at the same time.
- Don't log out of the linked device on your phone, or sending stops until you scan the QR code again.
- Don't ask us to skip the safety rules to send faster. The rest after linking and the levels exist because new numbers have been banned on their first day.

**If the number is banned:** WhatsApp sometimes lets you appeal from the phone app. The system rests the number automatically and starts it again slowly. A second ban within 30 days means a longer rest. If you keep getting bans, your contact list or your message is the cause, not the speed.

## Questions people ask

**Why is my campaign so slow?**
Because the number is new. Speed comes from the number's history, not from settings. Send a little every day and the level rises on its own; most numbers reach full speed in about six weeks.

**My campaign says "paused". Did something break?**
Usually not. A campaign pauses when the day's amount is used up, outside the recipient's daytime, or while a brake is on. It continues by itself, and the number's page tells you which one it is.

**Can I switch the safety rules off?**
Yes, but think hard first. An account admin can choose **Leave sending safety** on the number page. That turns off the levels, brakes, pacing and quiet hours for every number of your business. You read a warning and confirm with your name each time you leave. **Rejoin sending safety** turns everything back on with one click. Without safety, a ban is likely.

**Does my phone need to stay on?**
It should be online most of the time. The system works as a linked device, and WhatsApp unlinks devices whose phone stays offline for about two weeks.

**Will customers know I used a tool?**
They see a normal message from your number. Write it the way you would write to one customer.

**Can I use my personal number?**
You can, but a separate number for the business is safer: if it's ever banned, you don't lose your personal chats.

**Can I send to WhatsApp groups?**
Yes. You can pick the groups your number is in, and their members are added as contacts. The same levels and brakes apply to them.

**Why does my carousel arrive as a photo album?**
An album is the swipe format that every device shows. See [What your customers see](#what-your-customers-see).
