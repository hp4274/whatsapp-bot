/** Display name and Material Symbols icon for each platform service. */
export const SERVICE_META: Record<string, { label: string; icon: string; sends?: boolean }> = {
  school_whatsapp_bot: { label: 'School WhatsApp bot', icon: 'school', sends: true },
  whatsapp_channels: { label: 'WhatsApp numbers', icon: 'smartphone' },
  contacts: { label: 'Contacts', icon: 'contacts' },
  templates: { label: 'Templates', icon: 'description' },
  inbox: { label: 'Inbox', icon: 'inbox' },
  auto_replies: { label: 'Auto replies', icon: 'quickreply', sends: true },
  bulk_messages: { label: 'Bulk message', icon: 'send', sends: true },
  campaigns: { label: 'Campaigns', icon: 'campaign', sends: true },
  payment_reminders: { label: 'Payment reminders', icon: 'payments', sends: true },
  workflows: { label: 'Workflows', icon: 'account_tree', sends: true },
  faq: { label: 'FAQ', icon: 'help' },
  tickets: { label: 'Tickets', icon: 'confirmation_number' },
  appointments: { label: 'Appointments', icon: 'event' },
  orders: { label: 'Orders', icon: 'shopping_cart' },
  leads: { label: 'Leads', icon: 'person_search' },
  subscriptions: { label: 'Subscriptions', icon: 'autorenew' },
  events: { label: 'Events', icon: 'celebration' },
  api: { label: 'External API', icon: 'api' },
  analytics: { label: 'Analytics', icon: 'analytics' },
  integrations: { label: 'Integrations', icon: 'extension' },
  ai: { label: 'AI', icon: 'auto_awesome' },
};

export const serviceMeta = (key: string) =>
  SERVICE_META[key] ?? { label: key.replace(/_/g, ' '), icon: 'widgets', sends: false };
