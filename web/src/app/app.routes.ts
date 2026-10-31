import { Routes } from '@angular/router';

import { authGuard, homeGuard, roleGuard } from './core/auth';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  {
    path: 'login',
    title: 'Sign in - Wapzo',
    loadComponent: () => import('./auth/login').then((m) => m.LoginView),
  },
  {
    path: 'home',
    title: 'Home - Wapzo',
    canActivate: [homeGuard],
    loadComponent: () => import('./home/home').then((m) => m.Home),
  },
  {
    path: 'connection',
    title: 'Connection - Wapzo',
    // Every action on this page is admin-only on the server; an agent would only meet 403s.
    canActivate: [roleGuard('admin')],
    loadComponent: () => import('./connection/connection').then((m) => m.ConnectionView),
  },
  {
    path: 'contacts',
    title: 'Contacts - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./contacts/contacts').then((m) => m.ContactsView),
  },
  {
    path: 'campaign',
    title: 'Messaging & Campaign - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./campaign/campaign').then((m) => m.CampaignView),
  },
  {
    path: 'campaigns',
    title: 'Campaigns - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./campaigns/campaigns-list').then((m) => m.CampaignsListView),
  },
  {
    path: 'campaigns/:id',
    title: 'Campaign - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./campaigns/campaign-detail').then((m) => m.CampaignDetailView),
  },
  {
    path: 'storage',
    title: 'Storage - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./storage/storage').then((m) => m.StorageView),
  },
  {
    path: 'auto-replies',
    title: 'Auto-Replies - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./auto-replies/auto-replies').then((m) => m.AutoRepliesView),
  },
  {
    path: 'templates',
    title: 'Templates - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./templates/templates').then((m) => m.TemplatesView),
  },
  {
    path: 'inbox',
    title: 'Inbox - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./inbox/inbox').then((m) => m.InboxView),
  },
  {
    path: 'tickets',
    title: 'Tickets - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./tickets/tickets').then((m) => m.TicketsView),
  },
  {
    path: 'knowledge',
    title: 'FAQ - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./knowledge/knowledge').then((m) => m.KnowledgeView),
  },
  {
    path: 'payment-reminder',
    title: 'Payment Reminder - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./payment-reminder/payment-reminder').then((m) => m.PaymentReminderView),
  },
  {
    path: 'records/:type',
    title: 'Records - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./records/records').then((m) => m.RecordsView),
  },
  {
    path: 'workflows',
    title: 'Workflows - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./workflows/workflows').then((m) => m.WorkflowsView),
  },
  {
    path: 'developer',
    title: 'API & Webhooks - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./developer/developer').then((m) => m.DeveloperView),
  },
  {
    path: 'analytics',
    title: 'Analytics - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./analytics/analytics').then((m) => m.AnalyticsView),
  },
  {
    path: 'history',
    title: 'History - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./history/history').then((m) => m.HistoryView),
  },
  {
    path: 'channels',
    title: 'WhatsApp Numbers - Wapzo',
    // Adding, linking and renaming numbers are admin-only on the server.
    canActivate: [roleGuard('admin')],
    loadComponent: () => import('./channels/channels').then((m) => m.ChannelsView),
  },
  {
    path: 'school',
    title: 'School Assistant - Wapzo',
    canActivate: [authGuard],
    loadComponent: () => import('./school/school').then((m) => m.SchoolView),
  },
  {
    path: 'team',
    title: 'Team - Wapzo',
    canActivate: [roleGuard('admin')],
    loadComponent: () => import('./team/team').then((m) => m.TeamView),
  },
  {
    path: 'admin/tenants',
    title: 'Tenants - Wapzo',
    canActivate: [roleGuard('super_admin')],
    loadComponent: () => import('./admin/tenants').then((m) => m.TenantsView),
  },
  {
    path: 'admin/plans',
    title: 'Plans & billing - Wapzo',
    canActivate: [roleGuard('super_admin')],
    loadComponent: () => import('./admin/plans').then((m) => m.PlansView),
  },
  {
    path: 'admin/usage',
    title: 'Usage - Wapzo',
    canActivate: [roleGuard('super_admin')],
    data: { kind: 'usage' },
    loadComponent: () => import('./admin/ops').then((m) => m.AdminOpsView),
  },
  {
    path: 'admin/health',
    title: 'Health - Wapzo',
    canActivate: [roleGuard('super_admin')],
    data: { kind: 'health' },
    loadComponent: () => import('./admin/ops').then((m) => m.AdminOpsView),
  },
  {
    path: 'admin/audit-logs',
    title: 'Audit Logs - Wapzo',
    canActivate: [roleGuard('super_admin')],
    data: { kind: 'audit' },
    loadComponent: () => import('./admin/ops').then((m) => m.AdminOpsView),
  },
  {
    path: 'admin/channels',
    title: 'Channels - Wapzo',
    canActivate: [roleGuard('super_admin')],
    data: { kind: 'channels' },
    loadComponent: () => import('./admin/ops').then((m) => m.AdminOpsView),
  },
  {
    path: 'admin/number-collections',
    title: 'Number collections - Wapzo',
    canActivate: [roleGuard('super_admin')],
    loadComponent: () => import('./admin/number-collections').then((m) => m.NumberCollectionsView),
  },
  {
    path: 'admin/services/:service',
    title: 'Service settings - Wapzo',
    canActivate: [roleGuard('super_admin')],
    loadComponent: () => import('./admin/service').then((m) => m.ServiceView),
  },
  { path: '**', redirectTo: 'home' },
];
