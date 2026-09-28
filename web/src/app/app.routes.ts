import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'connection' },
  {
    path: 'connection',
    title: 'Connection - WhatsApp Sender',
    loadComponent: () => import('./connection/connection').then((m) => m.ConnectionView),
  },
  {
    path: 'campaign',
    title: 'Messaging & Campaign - WhatsApp Sender',
    loadComponent: () => import('./campaign/campaign').then((m) => m.CampaignView),
  },
  {
    path: 'history',
    title: 'History - WhatsApp Sender',
    loadComponent: () => import('./history/history').then((m) => m.HistoryView),
  },
  { path: '**', redirectTo: 'connection' },
];
