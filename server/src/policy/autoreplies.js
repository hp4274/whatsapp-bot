/** Platform rules for auto replies. See `index.js` for the field shape. */

const S = 'auto_replies';

export const AUTOREPLY_POLICY = Object.freeze([
    // Auto replies answer someone who wrote in; by default they are not traffic the business pays for.
    { key: 'autoReplies.countTowardQuota', service: S, group: 'Quota', type: 'bool', default: false, scopes: ['global'],
      label: 'Count auto replies toward message limits',
      hint: 'Off: auto replies never use the daily cap or the plan\'s message quota, and still go out when those run out.' },
    { key: 'autoReplies.maxRules', service: S, group: 'Limits', type: 'int', default: 0, min: 0, max: 10000, unlimitedAt: 0,
      label: 'Maximum rules', hint: '0 = no limit.' },
    { key: 'autoReplies.allowKeywords', service: S, group: 'Limits', type: 'bool', default: true,
      label: 'Allow keyword rules' },
    { key: 'autoReplies.allowMenus', service: S, group: 'Limits', type: 'bool', default: true,
      label: 'Allow menus' },
    { key: 'autoReplies.optOutWords', service: S, group: 'Opt-out', type: 'list', default: ['STOP', 'UNSUBSCRIBE'],
      label: 'Opt-out words', hint: 'Every business inherits these and cannot remove them. One per line.' },
    { key: 'autoReplies.maxPerContactHour', service: S, group: 'Loop protection', type: 'int', default: 5, min: 0, max: 1000, unlimitedAt: 0,
      label: 'Max auto-replies per contact per hour', hint: 'Stops two bots answering each other forever. 0 = no limit.' },
    { key: 'autoReplies.quietHoursEnabled', service: S, group: 'Quiet hours', type: 'bool', default: false,
      label: 'Platform quiet hours', hint: 'No auto-replies in this window, in the business time zone.' },
    { key: 'autoReplies.quietStart', service: S, group: 'Quiet hours', type: 'text', default: '22:00',
      label: 'Quiet from (HH:MM)' },
    { key: 'autoReplies.quietEnd', service: S, group: 'Quiet hours', type: 'text', default: '07:00',
      label: 'Quiet until (HH:MM)' },
    { key: 'autoReplies.allowAi', service: S, group: 'AI', type: 'bool', default: true,
      label: 'Allow AI / FAQ answers', hint: 'Lets a business answer from its FAQ automatically.' },

    // What a business may build. Switched off, existing rules of that kind stay saved but stop replying.
    { key: 'autoReplies.allowIntents', service: S, group: 'Features', type: 'bool', default: true,
      label: 'Intent rules and synonyms', hint: '"rate kya hai" answers a Price rule; "cost" finds "price".' },
    { key: 'autoReplies.allowMessageTypes', service: S, group: 'Features', type: 'bool', default: true,
      label: 'Message-type rules', hint: 'Reply to a photo, file, voice note or location.' },
    { key: 'autoReplies.allowQuestions', service: S, group: 'Features', type: 'bool', default: true,
      label: 'Ask questions', hint: 'Rules that collect a name, phone number, order ID one question at a time.' },
    { key: 'autoReplies.allowTranslations', service: S, group: 'Features', type: 'bool', default: true,
      label: "Replies in the customer's language", hint: 'Language detection and translated replies.' },
    { key: 'autoReplies.allowWelcome', service: S, group: 'Features', type: 'bool', default: true, label: 'Welcome message' },
    { key: 'autoReplies.allowAway', service: S, group: 'Features', type: 'bool', default: true, label: 'Away / business hours message' },
    { key: 'autoReplies.allowFallback', service: S, group: 'Features', type: 'bool', default: true, label: 'Default fallback' },
    { key: 'autoReplies.allowHandoff', service: S, group: 'Features', type: 'bool', default: true,
      label: 'Human handoff', hint: 'Customers can ask for a person; the bot pauses for them.' },

    { key: 'autoReplies.maxQuestions', service: S, group: 'Limits', type: 'int', default: 8, min: 1, max: 8,
      label: 'Questions per rule' },
    { key: 'autoReplies.maxVariants', service: S, group: 'Limits', type: 'int', default: 10, min: 1, max: 10,
      label: 'Reply variants per rule' },
    { key: 'autoReplies.maxLanguages', service: S, group: 'Limits', type: 'int', default: 0, min: 0, max: 60, unlimitedAt: 0,
      label: 'Languages per reply', hint: 'Translations a reply may have. 0 = no limit.' },

    { key: 'autoReplies.maxPauseHours', service: S, group: 'Handoff', type: 'int', default: 72, min: 0, max: 720,
      label: 'Longest bot pause (hours)', hint: 'After a handoff or a reply from the phone. A business may choose less.' },
    { key: 'autoReplies.maxHandoffAfter', service: S, group: 'Handoff', type: 'int', default: 5, min: 0, max: 20,
      label: 'Latest automatic handover', hint: 'The most unanswered messages in an hour a business may allow before a person takes over.' },

    { key: 'autoReplies.minDelaySec', service: S, group: 'Timing', type: 'int', default: 0, min: 0, max: 60,
      label: 'Shortest reply delay (seconds)' },
    { key: 'autoReplies.maxDelaySec', service: S, group: 'Timing', type: 'int', default: 10, min: 0, max: 120,
      label: 'Longest reply delay (seconds)', hint: 'A business picks its delay inside this range.',
      check: (v) => (Number(v['autoReplies.maxDelaySec']) < Number(v['autoReplies.minDelaySec'] ?? 0)
          ? 'The longest reply delay must not be shorter than the shortest.' : null) },
    { key: 'autoReplies.logDays', service: S, group: 'Timing', type: 'int', default: 30, min: 1, max: 365,
      label: 'Keep the Activity log (days)' },
]);
