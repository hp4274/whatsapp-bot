/**
 * Written how-to guides shown in the side panel (PageGuide). Plain data, one file per module in ./guides/: a page
 * gets a guide by adding its file to GUIDES and its path to GUIDE_PATHS. The words follow the buttons and labels the
 * user sees on screen.
 */
import { analytics } from './guides/analytics';
import { appointments } from './guides/appointments';
import { autoReplies } from './guides/auto-replies';
import { campaigns } from './guides/campaigns';
import { catalog } from './guides/catalog';
import { contacts } from './guides/contacts';
import { developer } from './guides/developer';
import { events } from './guides/events';
import { faq } from './guides/faq';
import { history } from './guides/history';
import { home } from './guides/home';
import { leads } from './guides/leads';
import { orders } from './guides/orders';
import { otp } from './guides/otp';
import { paymentReminder } from './guides/payment-reminder';
import { school } from './guides/school';
import { storage } from './guides/storage';
import { subscriptions } from './guides/subscriptions';
import { team } from './guides/team';
import { templates } from './guides/templates';
import { tickets } from './guides/tickets';
import { whatsapp } from './guides/whatsapp';
import { workflows } from './guides/workflows';

export interface GuideTask {
  readonly title: string;
  readonly steps: readonly string[];
  /** One short line after the steps: a tip or a warning. */
  readonly tip?: string;
}

export interface Guide {
  readonly title: string;
  readonly intro: string;
  readonly tasks: readonly GuideTask[];
}

export const GUIDES: Readonly<Record<string, Guide>> = {
  analytics, appointments, autoReplies, campaigns, catalog, contacts, developer, events, faq, history, home, leads,
  orders, otp, paymentReminder, school, storage, subscriptions, team, templates, tickets, whatsapp, workflows,
};

/** Which pages show which guide: a URL starting with the path opens that guide. Longest match wins. */
export const GUIDE_PATHS: readonly (readonly [string, string])[] = [
  ['/home', 'home'],
  ['/campaigns', 'campaigns'],
  ['/campaign', 'campaigns'],
  ['/templates', 'templates'],
  ['/auto-replies', 'autoReplies'],
  ['/storage', 'storage'],
  ['/school', 'school'],
  ['/otp', 'otp'],
  ['/contacts', 'contacts'],
  ['/tickets', 'tickets'],
  ['/knowledge', 'faq'],
  ['/payment-reminder', 'paymentReminder'],
  ['/records/appointment', 'appointments'],
  ['/records/order', 'orders'],
  ['/records/lead', 'leads'],
  ['/records/subscription', 'subscriptions'],
  ['/records/event', 'events'],
  ['/catalog', 'catalog'],
  ['/analytics', 'analytics'],
  ['/history', 'history'],
  ['/whatsapp', 'whatsapp'],
  ['/team', 'team'],
  ['/workflows', 'workflows'],
  ['/developer', 'developer'],
];

/** The guide key for a URL, or null when the page has no guide. */
export function guideFor(url: string): string | null {
  const path = url.split(/[?#]/)[0];
  const hit = GUIDE_PATHS.filter(([prefix]) => path === prefix || path.startsWith(prefix + '/')).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : null;
}
