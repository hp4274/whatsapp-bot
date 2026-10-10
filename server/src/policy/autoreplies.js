/** Platform rules for auto replies. See `index.js` for the field shape. */

const S = 'auto_replies';

export const AUTOREPLY_POLICY = Object.freeze([
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
]);
