import { normalizeInboundText } from './engine.js';

const OPTOUT_KEYWORDS = new Set(['stop', 'unsubscribe', 'cancel', 'quit', 'optout', 'end']);
const OPTIN_KEYWORDS = new Set(['start', 'unstop', 'subscribe']);

export async function processOptOut(db, transport, msg) {
    const text = normalizeInboundText(msg.body);

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
