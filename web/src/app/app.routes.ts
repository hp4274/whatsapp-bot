import { Routes } from '@angular/router';

import { authGuard, roleGuard } from './core/auth';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'connection' },
  {
    path: 'login',
    title: 'Sign in - WhatsApp Sender',
    loadComponent: () => import('./auth/login').then((m) => m.LoginView),
  },
  {
    path: 'connection',
    title: 'Connection - WhatsApp Sender',
    canActivate: [authGuard],
    loadComponent: () => import('./connection/connection').then((m) => m.ConnectionView),
  },
  {
    path: 'contacts',
    title: 'Contacts - WhatsApp Sender',
    canActivate: [authGuard],
    loadComponent: () => import('./contacts/contacts').then((m) => m.ContactsView),
  },
  {
    path: 'campaign',
    title: 'Messaging & Campaign - WhatsApp Sender',
    canActivate: [authGuard],
    loadComponent: () => import('./campaign/campaign').then((m) => m.CampaignView),
  },
  {
    path: 'auto-replies',
    title: 'Auto-Replies - WhatsApp Sender',
    canActivate: [authGuard],
    loadComponent: () => import('./auto-replies/auto-replies').then((m) => m.AutoRepliesView),
  },
  {
    path: 'payment-reminder',
    title: 'Payment Reminder - WhatsApp Sender',
    canActivate: [authGuard],
    loadComponent: () => import('./payment-reminder/payment-reminder').then((m) => m.PaymentReminderView),
  },
  {
    path: 'history',
    title: 'History - WhatsApp Sender',
    canActivate: [authGuard],
    loadComponent: () => import('./history/history').then((m) => m.HistoryView),
  },
  {
    path: 'channels',
    title: 'WhatsApp Numbers - WhatsApp Sender',
    canActivate: [authGuard],
    loadComponent: () => import('./channels/channels').then((m) => m.ChannelsView),
  },
  {
    path: 'school',
    title: 'School Assistant - WhatsApp Sender',
    canActivate: [authGuard],
    loadComponent: () => import('./school/school').then((m) => m.SchoolView),
  },
  {
    path: 'team',
    title: 'Team - WhatsApp Sender',
    canActivate: [roleGuard('admin')],
    loadComponent: () => import('./team/team').then((m) => m.TeamView),
  },
  {
    path: 'admin/tenants',
    title: 'Tenants - WhatsApp Sender',
    canActivate: [roleGuard('super_admin')],
    loadComponent: () => import('./admin/tenants').then((m) => m.TenantsView),
  },
  {
    path: 'admin/plans',
    title: 'Plans - WhatsApp Sender',
    canActivate: [roleGuard('super_admin')],
    data: { kind: 'plans' },
    loadComponent: () => import('./admin/ops').then((m) => m.AdminOpsView),
  },
  {
    path: 'admin/usage',
    title: 'Usage - WhatsApp Sender',
    canActivate: [roleGuard('super_admin')],
    data: { kind: 'usage' },
    loadComponent: () => import('./admin/ops').then((m) => m.AdminOpsView),
  },
  {
    path: 'admin/health',
    title: 'Health - WhatsApp Sender',
    canActivate: [roleGuard('super_admin')],
    data: { kind: 'health' },
    loadComponent: () => import('./admin/ops').then((m) => m.AdminOpsView),
  },
  {
    path: 'admin/audit-logs',
    title: 'Audit Logs - WhatsApp Sender',
    canActivate: [roleGuard('super_admin')],
    data: { kind: 'audit' },
    loadComponent: () => import('./admin/ops').then((m) => m.AdminOpsView),
  },
  {
    path: 'admin/channels',
    title: 'Channels - WhatsApp Sender',
    canActivate: [roleGuard('super_admin')],
    data: { kind: 'channels' },
    loadComponent: () => import('./admin/ops').then((m) => m.AdminOpsView),
  },
  {
    path: 'admin/services/:service',
    title: 'Service settings - WhatsApp Sender',
    canActivate: [roleGuard('super_admin')],
    loadComponent: () => import('./admin/service').then((m) => m.ServiceView),
  },
  { path: '**', redirectTo: 'connection' },
];
