/**
 * Platform rules for message templates. See `index.js` for the field shape.
 * Defaults are permissive on purpose: an empty policy must not start refusing
 * templates businesses already have. Super admins tighten per plan.
 */

const S = 'templates';

export const TEMPLATE_POLICY = Object.freeze([
    { key: 'templates.maxTemplates', service: S, group: 'Limits', type: 'int', default: 0, min: 0, max: 100000, unlimitedAt: 0,
      label: 'Maximum templates', hint: '0 = no limit.' },
    { key: 'templates.requireApproval', service: S, group: 'Review', type: 'enum', default: 'off',
      options: [
          { value: 'off', label: 'No review' },
          { value: 'baileys', label: 'Review templates used on Baileys numbers' },
          { value: 'all', label: 'Review every template' },
      ],
      label: 'Approval queue', hint: 'A super admin approves a template before it can be sent. Meta reviews Cloud API templates itself.' },
    { key: 'templates.blockedWords', service: S, group: 'Content rules', type: 'list', default: [],
      label: 'Blocked words', hint: 'One per line. A template containing one cannot be saved.' },
    { key: 'templates.blockedDomains', service: S, group: 'Content rules', type: 'list', default: [],
      label: 'Blocked link domains', hint: 'One per line, e.g. bit.ly. Subdomains are blocked too.' },
    { key: 'templates.maxSpamScore', service: S, group: 'Content rules', type: 'int', default: 100, min: 0, max: 100,
      label: 'Spam score limit', hint: '0-100. Templates scoring above this are refused. 100 turns the check off.' },
    { key: 'templates.mediaTypes', service: S, group: 'Media and buttons', type: 'list', default: ['image', 'video', 'document', 'audio'],
      label: 'Allowed media types', hint: 'Any of: image, video, document, audio.' },
    { key: 'templates.maxMediaMb', service: S, group: 'Media and buttons', type: 'int', default: 100, min: 1, max: 100,
      label: 'Maximum media size (MB)' },
    { key: 'templates.buttonTypes', service: S, group: 'Media and buttons', type: 'list', default: ['quick_reply', 'url', 'call', 'copy'],
      label: 'Allowed button types', hint: 'Any of: quick_reply, url, call, copy.' },
    { key: 'templates.maxButtons', service: S, group: 'Media and buttons', type: 'int', default: 10, min: 0, max: 10,
      label: 'Maximum buttons per template' },
]);
