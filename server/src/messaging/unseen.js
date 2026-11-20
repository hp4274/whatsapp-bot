/**
 * "Delivered" is not "shown". A phone sends a delivery receipt for a message it receives but cannot draw: on
 * 2026-11-19 campaign buttons showed as delivered in the app while nobody saw them on their phone.
 *
 * Reading is the only sign from outside that a message really showed. So, per number and per kind of tappable
 * message (reply buttons, a list, call or link buttons, a carousel): if enough of that kind was delivered and
 * nobody read, tapped or answered a single one, while the same number's ordinary messages ARE read (its
 * recipients do send read receipts), that kind is not showing on phones.
 *
 * Looks at the last 48 hours, leaving out the last 2 so people have had time to open them.
 * shortcut: tappable kinds only; a picture or file that does not open would need the same check over plain media
 * messages, which keep no record of their kind (messages.message has the text only).
 */

export const UNSEEN = Object.freeze({ minDelivered: 10, minOrdinaryRead: 3, windowHours: 48, graceHours: 2 });

/** What each kind is called in a sentence. */
export const UNSEEN_KIND_LABEL = Object.freeze({
    buttons: 'reply buttons', list: 'a list menu', cta: 'call or link buttons', carousel: 'a carousel',
});

const HOUR_MS = 3_600_000;
/** The stored timestamps' shape (protocol.js utcNow), so text comparison orders them. */
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

/**
 * Every number and kind that looks unseen right now:
 * `[{ tenantId, channelId, kind, delivered, ordinaryRead }]`, from the platform-wide database handle.
 */
export function unseenKinds(raw, { now = Date.now(), limits = UNSEEN } = {}) {
    const from = stamp(now - limits.windowHours * HOUR_MS);
    const to = stamp(now - limits.graceHours * HOUR_MS);
    const tappable = raw.prepare(`
        SELECT s.tenant_id AS tenantId, s.channel_id AS channelId, json_extract(s.interactive, '$.type') AS kind,
               SUM(m.status IN ('DELIVERED', 'READ')) AS delivered,
               SUM(m.status = 'READ'
                   OR EXISTS (SELECT 1 FROM button_clicks c WHERE c.tenant_id = s.tenant_id AND c.message_id = s.message_id)
                   OR EXISTS (SELECT 1 FROM inbound_messages i WHERE i.tenant_id = s.tenant_id AND i.channel_id = s.channel_id
                                AND i.sender = s.recipient AND i.received_at > s.sent_at)) AS seen
        FROM interactive_sends s JOIN messages m ON m.message_id = s.message_id AND m.tenant_id = s.tenant_id
        WHERE s.sent_at >= ? AND s.sent_at < ? AND s.channel_id IS NOT NULL
        GROUP BY 1, 2, 3`).all(from, to);
    const flagged = tappable.filter((r) => r.delivered >= limits.minDelivered && r.seen === 0);
    if (!flagged.length) return [];
    // How many of each number's ordinary (not tappable) messages were read in the same hours.
    const ordinary = raw.prepare(`
        SELECT COUNT(*) AS n FROM messages m
        WHERE m.tenant_id = ? AND m.channel_id = ? AND m.direction = 'outbound' AND m.status = 'READ'
          AND m.sent_at >= ? AND m.sent_at < ?
          AND NOT EXISTS (SELECT 1 FROM interactive_sends s WHERE s.message_id = m.message_id)`);
    return flagged
        .map((r) => ({ ...r, ordinaryRead: ordinary.get(r.tenantId, r.channelId, from, to).n }))
        .filter((r) => r.ordinaryRead >= limits.minOrdinaryRead);
}

/** The alert's sentence, for the super admin and the business alike. */
export function unseenText({ kind, delivered }, numberName) {
    const what = UNSEEN_KIND_LABEL[kind] ?? `${kind} messages`;
    return `Messages with ${what} sent from ${numberName} may not be showing on phones: ${delivered} were delivered `
        + 'in the last 2 days, but nobody opened, tapped or answered one, while this number\'s ordinary messages are read. '
        + 'Check one on an Android phone and an iPhone before sending more.';
}
