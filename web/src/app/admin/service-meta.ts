/** Display name and Tabler icon (`ti ti-<icon>`) for each platform service. */
export const SERVICE_META: Record<string, { label: string; icon: string; sends?: boolean }> = {
  school_whatsapp_bot: { label: 'School WhatsApp bot', icon: 'school', sends: true },
  whatsapp_channels: { label: 'WhatsApp numbers', icon: 'device-mobile' },
  contacts: { label: 'Contacts', icon: 'address-book' },
  templates: { label: 'Templates', icon: 'file-text' },
  inbox: { label: 'Inbox', icon: 'inbox' },
  auto_replies: { label: 'Auto replies', icon: 'message-bolt', sends: true },
  bulk_messages: { label: 'Bulk message', icon: 'send', sends: true },
  campaigns: { label: 'Campaigns', icon: 'speakerphone', sends: true },
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
};

export const serviceMeta = (key: string) =>
  SERVICE_META[key] ?? { label: key.replace(/_/g, ' '), icon: 'components', sends: false };
