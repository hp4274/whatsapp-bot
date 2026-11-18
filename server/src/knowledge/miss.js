/**
 * A customer message that nothing answered: not the FAQ, not a keyword auto-reply. Called by handleInbound after
 * both had their turn, so the miss list holds real gaps only.
 */

import { ownerAlert } from '../moduleSweeps.js';
import { deliver } from '../school/routes.js';

/**
 * Note the miss and follow the business's "when nothing answers" setting. The reply and the owner alert go at most
 * once per contact per hour: someone asking three things in a row hears "we will get back to you" once.
 * Returns what happened, for tests: { noted, replied, alerted }.
 */
export function followUpMiss(state, msg, now = new Date()) {
    const out = { noted: false, replied: false, alerted: false };
    const knowledge = state.knowledge;
    if (!knowledge?.noteMiss(msg.body)) return out;
    out.noted = true;
    const { missReply, alertOwner } = knowledge.settings();
    const hour = Math.floor(now.getTime() / 3_600_000);
    const key = `faq-miss.${msg.sender}.${hour}`;
    if (missReply) {
        out.replied = deliver(state, { recipient: msg.sender, text: missReply, key, messageType: 'auto_reply' }) === 'sent';
        if (out.replied) {
            state.db.markInboundReplied?.(msg.messageId, 'faq:miss');
            state.autoReply?.log?.(msg, 'replied', 'FAQ: no answer found', missReply);
        }
    }
    if (alertOwner) {
        const text = `Wuzie: nothing answered a customer (+${msg.sender}). They asked:\n"${String(msg.body).slice(0, 300)}"`;
        out.alerted = ownerAlert(state, text, key) === 'sent';
    }
    return out;
}
