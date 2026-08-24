import { lazy, Suspense } from 'react';

import { InstallPage } from './install-page';
import { LandingPage } from './landing-page';
import { RcpanPage } from './rcpan-page';
import { Arrow, SiteFooter, SiteShell } from './site-shell';
import type { SitePage } from './site-model';
import { UnicastPage } from './unicast-page';

const ReleasesPage = lazy(() => import('./releases-page').then((module) => ({ default: module.ReleasesPage })));

function PendingRoute({ pathname }: Readonly<{ pathname: string }>) {
  return (
    <SiteShell activeRoute="pending">
      <main className="pending-route">
        <p className="kicker">React site migration</p>
        <h1>This route stays canonical for now.</h1>
        <p><code>{pathname}</code> has not moved into the React site candidate yet. The Svelte production route is unchanged.</p>
        <a className="text-link" href="/">Return to the pilot <Arrow /></a>
      </main>
      <SiteFooter />
    </SiteShell>
  );
}

function ReleasesFallback() {
  return <SiteShell activeRoute="/releases"><main className="releases-page"><section className="release-state"><span>Loading release verifier</span><h1>Opening the<br />engineering ledger.</h1></section></main><SiteFooter /></SiteShell>;
}

export function SiteApp({ page }: Readonly<{ page: SitePage }>) {
  if (page.kind === 'home') return <LandingPage />;
  if (page.kind === 'install') return <InstallPage />;
  if (page.kind === 'rcpan') return <RcpanPage />;
  if (page.kind === 'unicast') return <UnicastPage />;
  if (page.kind === 'releases') return <Suspense fallback={<ReleasesFallback />}><ReleasesPage /></Suspense>;
  return <PendingRoute pathname={page.pathname} />;
}
