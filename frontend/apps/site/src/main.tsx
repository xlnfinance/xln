import { lazy, StrictMode, Suspense, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

import { AppErrorBoundary } from './AppErrorBoundary';
import { scheduleSiteAnalytics } from './analytics';
import { installGlobalErrorSurface, reportSiteError } from './error-surface';
import { PublicShell } from './PublicShell';
import '../styles/site.css';

type PageModule = Readonly<{ default: ComponentType }>;

const PAGE_LOADERS: Readonly<Record<string, () => Promise<PageModule>>> = {
  '/': () => import('../pages/LandingPage'),
  '/install': () => import('../pages/InstallPage'),
  '/rcpan': () => import('../pages/RcpanPage'),
  '/releases': () => import('../pages/ReleasesPage'),
  '/reviews': () => import('../pages/ReviewsPage'),
  '/unicast': () => import('../pages/UnicastPage'),
};

const pathname = window.location.pathname.replace(/\/$/, '') || '/';
const loader = PAGE_LOADERS[pathname];
if (!loader) throw new Error(`REACT_SITE_ROUTE_UNKNOWN:${pathname}`);
const Page = lazy(loader);
const container = document.getElementById('root');
if (!container) throw new Error('REACT_SITE_ROOT_MISSING');

installGlobalErrorSurface();
createRoot(container, {
  onCaughtError: error => reportSiteError('react-caught', error),
  onRecoverableError: error => reportSiteError('react-recoverable', error),
  onUncaughtError: error => reportSiteError('react-uncaught', error),
}).render(
  <StrictMode>
    <AppErrorBoundary>
      <PublicShell>
        <Suspense fallback={<div className="site-loading" role="status">Loading xln…</div>}>
          <Page />
        </Suspense>
      </PublicShell>
    </AppErrorBoundary>
  </StrictMode>,
);
scheduleSiteAnalytics();
