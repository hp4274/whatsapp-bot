const MATCH_TYPES = new Set(['EXACT', 'CONTAINS', 'REGEX', 'FALLBACK']);

export class AutoReplyEngine {
    constructor(db, transport, options = {}) {
        this.db = db;
        this.transport = transport;
        this.defaultCooldownSec = options.cooldownSec ?? 300;
        this.delayRangeMs = options.delayRangeMs ?? [2500, 4500];
        this.recentReplies = new Map();
    }

    setTransport(transport) {
        this.transport = transport;
    }

    async handleInbound(msg) {
        const text = normalizeInboundText(msg.body);
        if (!text || !this.transport?.isConnected?.()) return null;

        const rules = this.db.getActiveAutoReplies();
        const matchedRule = this.matchRule(text, rules);
        if (!matchedRule) return null;

        const cooldownSec = matchedRule.cooldownSec ?? this.defaultCooldownSec;
        const key = `${msg.sender}|${matchedRule.id}`;
        const now = Date.now();
        const lastSent = this.recentReplies.get(key) || 0;
        if (now - lastSent < cooldownSec * 1000) return null;

        this.recentReplies.set(key, now);
        await this.#delay();
        const responseText = this.formatResponse(matchedRule.replyBody, msg);
        const result = await this.transport.sendMessage(msg.sender, responseText);
        return { rule: matchedRule, responseText, result };
    }

    matchRule(text, rules) {
        for (const rule of rules) {
            const matchType = String(rule.matchType ?? '').toUpperCase();
            if (!MATCH_TYPES.has(matchType) || matchType === 'FALLBACK') continue;
            const keyword = normalizeInboundText(rule.keyword);
            if (!keyword && matchType !== 'REGEX') continue;
            if (matchType === 'EXACT' && text === keyword) return rule;
            if (matchType === 'CONTAINS' && text.includes(keyword)) return rule;
            if (matchType === 'REGEX') {
                try {
                    if (new RegExp(rule.keyword, 'i').test(text)) return rule;
                } catch {
                    continue;
                }
            }
        }
        return rules.find((rule) => String(rule.matchType).toUpperCase() === 'FALLBACK') || null;
    }

    formatResponse(template, msg, now = new Date()) {
        const hour = now.getHours();
        let timeGreeting = 'Good morning';
        if (hour >= 12 && hour < 17) timeGreeting = 'Good afternoon';
        else if (hour >= 17) timeGreeting = 'Good evening';

        const name = msg.senderName || 'Valued Customer';
        return String(template ?? '')
            .replace(/\{time_greeting\}/gi, timeGreeting)
            .replace(/\{name\}/gi, name)
            .replace(/\{sender\}/gi, msg.sender);
    }

    async #delay() {
        const [min, max] = this.delayRangeMs;
        const delayMs = Math.max(0, min + Math.floor(Math.random() * Math.max(1, max - min)));
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
}

export function normalizeInboundText(text) {
    return String(text ?? '')
        .trim()
        .toLowerCase()
        .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
        .replace(/[.!?,;:]+$/g, '')
        .trim();
}
