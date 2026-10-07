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
  { path: '**', redirectTo: 'connection' },
];
