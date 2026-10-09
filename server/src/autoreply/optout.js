import { normalizeInboundText } from './engine.js';

// Matched against the whole message after normalising case, punctuation and
// spacing/hyphens, so "STOP!", "Stop all", "opt-out" and "UNSUBSCRIBE." all count.
export const OPTOUT_KEYWORDS = new Set([
    'stop', 'stopall', 'stop all', 'unsubscribe', 'unsub', 'cancel', 'quit', 'optout', 'opt out', 'end',
    'stop messages', 'remove me', 'do not message', 'dont message',
]);
export const OPTIN_KEYWORDS = new Set(['start', 'unstop', 'subscribe', 'optin', 'opt in', 'resubscribe']);

export async function processOptOut(db, transport, msg) {
    const text = normalizeInboundText(msg.body).replace(/['’]/g, '').replace(/[-_\s]+/g, ' ').trim();

    if (OPTOUT_KEYWORDS.has(text)) {
        db.addOptOut(msg.sender, 'user_keyword_stop');
        if (transport?.isConnected?.()) {
            await transport.sendMessage(
                msg.sender,
                'You have successfully unsubscribed from all messages. No further announcements will be sent to this number. Reply "START" at any time if you wish to opt back in.'
            );
        }
        return { handled: true, action: 'opted_out' };
    }

    if (OPTIN_KEYWORDS.has(text)) {
        const removed = db.removeOptOut(msg.sender);
        if (removed && transport?.isConnected?.()) {
            await transport.sendMessage(
                msg.sender,
                'You have been re-subscribed to updates. Thank you for staying connected with us!'
            );
        }
        return { handled: Boolean(removed), action: removed ? 'opted_in' : 'not_opted_out' };
    }

    return { handled: false };
}
