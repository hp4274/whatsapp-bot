import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding, withViewTransitions } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { routes } from './app.routes';
import { Auth, authInterceptor } from './core/auth';
import { Store } from './core/store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      // Pages crossfade; the class scopes the CSS to router transitions only (styles.scss).
      withViewTransitions({
        skipInitialTransition: true,
        onViewTransitionCreated: ({ transition }) => {
          const root = document.documentElement;
          root.classList.add('route-vt');
          transition.finished.finally(() => root.classList.remove('route-vt'));
        },
      }),
    ),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    // Resolve the stored token before the first route runs, so a reload does
    // not bounce a signed-in user to /login.
    provideAppInitializer(async () => {
      const auth = inject(Auth);
      const store = inject(Store);
      const user = await firstValueFrom(auth.restore());
      // A super admin only has a stream once they have entered a tenant.
      if (user && (user.role !== 'super_admin' || auth.actingTenantId() !== null)) store.start();
    }),
  ],
};
