/** What a staff role can open (server adminRoles.js SECTION_ACTIONS), in sidebar order. */
export type AdminSection =
  | 'tenants'
  | 'leads'
  | 'plans'
  | 'payments'
  | 'referrals'
  | 'wapzo'
  | 'usage'
  | 'health'
  | 'number_collections'
  | 'audit'
  | 'channels'
  | 'services';

/** Every right a page can give (server adminRoles.js SECTION_ACTIONS); each page offers only its own. */
export type AdminAction =
  | 'view'
  | 'add'
  | 'edit'
  | 'delete'
  | 'answer'
  | 'pay'
  | 'send'
  | 'rules'
  | 'templates'
  | 'campaigns'
  | 'numbers';

/** A staff role's rights, per page; a page left out is not opened at all. */
export type Permissions = Partial<Record<AdminSection, readonly AdminAction[]>>;

/** One right as the role editor shows it: a short label on the toggle, the hint on hover. */
export interface AdminActionMeta {
  readonly key: AdminAction;
  readonly label: string;
  readonly hint: string;
}

export interface AdminSectionMeta {
  readonly key: AdminSection;
  readonly label: string;
  readonly icon: string;
  /** Where the section starts; the sidebar link, and where a staff member lands. */
  readonly path: string;
  /** What the page is, for the role editor. */
  readonly hint: string;
  /** View first, then what the page really lets someone do; the server allows no other. */
  readonly actions: readonly AdminActionMeta[];
}

const view = (hint: string): AdminActionMeta => ({ key: 'view', label: 'View', hint });

export const ADMIN_SECTIONS: readonly AdminSectionMeta[] = [
  {
    key: 'tenants',
    label: 'Tenants',
    icon: 'building',
    path: '/admin/tenants',
    hint: 'Every business and its settings',
    actions: [
      view('See businesses and open their workspace'),
      { key: 'add', label: 'Add', hint: 'Add new businesses' },
      { key: 'edit', label: 'Change', hint: 'Set up, activate or suspend; plans, payments, limits, services and sign-ins' },
      { key: 'delete', label: 'Delete', hint: 'Delete businesses' },
    ],
  },
  {
    key: 'leads',
    label: 'Leads',
    icon: 'user-plus',
    path: '/admin/leads',
    hint: 'Account requests from the website',
    actions: [view('See account requests'), { key: 'answer', label: 'Answer', hint: 'Accept or turn down requests' }],
  },
  {
    key: 'plans',
    label: 'Plans & billing',
    icon: 'crown',
    path: '/admin/plans',
    hint: 'What each plan costs and includes',
    actions: [
      view('See plans and who is on them'),
      { key: 'edit', label: 'Change', hint: 'Make new plans and change them' },
      { key: 'delete', label: 'Delete', hint: 'Delete plans' },
    ],
  },
  {
    key: 'payments',
    label: 'Payments',
    icon: 'cash',
    path: '/admin/payments',
    hint: 'What businesses paid',
    actions: [view('See every payment')],
  },
  {
    key: 'referrals',
    label: 'Referrals',
    icon: 'affiliate',
    path: '/admin/referrals',
    hint: 'Marketers and their commission',
    actions: [
      view('See marketers and what they earned'),
      { key: 'add', label: 'Add', hint: 'Add marketers' },
      { key: 'edit', label: 'Change', hint: 'Change marketers and the businesses they brought' },
      { key: 'pay', label: 'Pay out', hint: 'Mark commission as paid' },
    ],
  },
  {
    key: 'wapzo',
    label: 'Wapzo WhatsApp',
    icon: 'brand-whatsapp',
    path: '/admin/wapzo',
    hint: 'Messages from Wapzo’s own number',
    actions: [
      view('See the messages and the number'),
      { key: 'edit', label: 'Change', hint: 'Change the messages and Wapzo’s number' },
      { key: 'send', label: 'Send', hint: 'Send test and broadcast messages' },
    ],
  },
  {
    key: 'usage',
    label: 'Usage',
    icon: 'chart-histogram',
    path: '/admin/usage',
    hint: 'What each business has sent',
    actions: [view('See usage')],
  },
  {
    key: 'health',
    label: 'Health',
    icon: 'heart-rate-monitor',
    path: '/admin/health',
    hint: 'How every number is doing',
    actions: [view('See number health')],
  },
  {
    key: 'number_collections',
    label: 'Number collections',
    icon: 'address-book',
    path: '/admin/number-collections',
    hint: 'Numbers businesses collected',
    actions: [view('See collected numbers'), { key: 'delete', label: 'Delete', hint: 'Delete collected numbers' }],
  },
  {
    key: 'audit',
    label: 'Audit logs',
    icon: 'list-search',
    path: '/admin/audit-logs',
    hint: 'Who did what, and the server logs',
    actions: [view('See the audit trail and logs')],
  },
  {
    key: 'channels',
    label: 'Channels',
    icon: 'device-mobile',
    path: '/admin/channels',
    hint: 'Every WhatsApp number on the platform',
    actions: [view('See every number'), { key: 'edit', label: 'Control', hint: 'Pause, resume, move and limit numbers' }],
  },
  {
    key: 'services',
    label: 'Service settings',
    icon: 'adjustments',
    path: '/admin/services/whatsapp_channels',
    hint: 'Each service across every business',
    actions: [
      view('See each service and who has it'),
      { key: 'rules', label: 'Rules', hint: 'Change each service’s rules and limits' },
      { key: 'templates', label: 'Templates', hint: 'Approve or reject templates; keep the starter library' },
      { key: 'campaigns', label: 'Campaigns', hint: 'Pause, stop and control campaigns' },
      { key: 'numbers', label: 'Numbers', hint: 'Pause, resume and move numbers' },
    ],
  },
];

/** The section a URL belongs to, or undefined for pages every admin opens. */
export function sectionOfUrl(url: string): AdminSection | undefined {
  const path = url.split(/[?#]/)[0];
  // '/admin/services/whatsapp_channels' covers every '/admin/services/...'.
  const root = (s: AdminSectionMeta) => s.path.split('/').slice(0, 3).join('/');
  return ADMIN_SECTIONS.find((s) => path === root(s) || path.startsWith(root(s) + '/'))?.key;
}
