/** Display name and Tabler icon (`ti ti-<icon>`) for each platform service. */
export const SERVICE_META: Record<string, { label: string; icon: string; sends?: boolean; uncapped?: boolean }> = {
  school_whatsapp_bot: { label: 'School WhatsApp bot', icon: 'school', sends: true },
  whatsapp_channels: { label: 'WhatsApp numbers', icon: 'device-mobile' },
  contacts: { label: 'Contacts', icon: 'address-book' },
  templates: { label: 'Templates', icon: 'file-text' },
  // Sends, but answers someone who wrote in: no daily cap, no pacing (and off the quota unless the platform says so).
  auto_replies: { label: 'Auto replies', icon: 'message-bolt', sends: true, uncapped: true },
  // Bulk messages and campaigns are one service: its rules cover both.
  campaigns: { label: 'Campaigns', icon: 'speakerphone', sends: true },
  // A code someone is waiting for: never held back by the daily cap or pacing.
  otp: { label: 'WhatsApp OTP', icon: 'password', sends: true, uncapped: true },
  catalog: { label: 'WhatsApp Catalog', icon: 'building-store' },
  payment_reminders: { label: 'Payment reminders', icon: 'cash', sends: true },
  workflows: { label: 'Workflows', icon: 'hierarchy-3', sends: true },
  faq: { label: 'FAQ', icon: 'help-circle' },
  tickets: { label: 'Tickets', icon: 'ticket' },
  appointments: { label: 'Appointments', icon: 'calendar-event' },
  orders: { label: 'Orders', icon: 'shopping-cart' },
  leads: { label: 'Leads', icon: 'user-search' },
  subscriptions: { label: 'Subscriptions', icon: 'refresh' },
  events: { label: 'Events', icon: 'confetti' },
  api: { label: 'External API', icon: 'api' },
  analytics: { label: 'Analytics', icon: 'chart-bar' },
  integrations: { label: 'Integrations', icon: 'puzzle' },
  ai: { label: 'AI', icon: 'sparkles' },
  /** Policy only (quotas and security), not a service a business turns on. */
  account: { label: 'Security & quotas', icon: 'shield-lock' },
};

export const serviceMeta = (key: string) =>
  SERVICE_META[key] ?? { label: key.replace(/_/g, ' '), icon: 'components', sends: false };

/**
 * Services not open yet: listed and marked "Coming soon", but not reachable from the menus or switchable. The server
 * (tenancy.js soonServices) keeps them off every tenant and plan; keep the two lists in step.
 */
export const SOON_SERVICES: ReadonlySet<string> = new Set([
  'school_whatsapp_bot',
  'workflows',
  'subscriptions',
  'events',
  'api',
  'analytics',
  'integrations',
  'ai',
]);
