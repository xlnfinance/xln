import { lazy, Suspense } from 'react';

import { InstallPage } from './install-page';
import { LandingPage } from './landing-page';
import { RcpanPage } from './rcpan-page';
import { Arrow, SiteFooter, SiteShell } from './site-shell';
import type { SitePage } from './site-model';
import { UnicastPage } from './unicast-page';

const ReleasesPage = lazy(() => import('./releases-page').then((module) => ({ default: module.ReleasesPage })));
const ReviewsPage = lazy(() => import('./reviews-page').then((module) => ({ default: module.ReviewsPage })));
const MarketCapPage = lazy(() => import('./market-cap-page').then((module) => ({ default: module.MarketCapPage })));

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

function ReviewsFallback() {
  return <SiteShell activeRoute="/reviews"><main className="reviews-page"><section className="reviews-loading"><span>Loading model perspectives</span><h1>Opening the<br />review transcript.</h1></section></main><SiteFooter /></SiteShell>;
}

function MarketCapFallback() {
  return <SiteShell activeRoute="/market-cap"><main className="market-page"><section className="market-state"><div className="market-loader" /><strong>Opening verified relay markets</strong><span>Preparing the Entity valuation ledger.</span></section></main><SiteFooter /></SiteShell>;
}

export function SiteApp({ page }: Readonly<{ page: SitePage }>) {
  if (page.kind === 'home') return <LandingPage />;
  if (page.kind === 'install') return <InstallPage />;
  if (page.kind === 'rcpan') return <RcpanPage />;
  if (page.kind === 'unicast') return <UnicastPage />;
  if (page.kind === 'releases') return <Suspense fallback={<ReleasesFallback />}><ReleasesPage /></Suspense>;
  if (page.kind === 'reviews') return <Suspense fallback={<ReviewsFallback />}><ReviewsPage /></Suspense>;
  if (page.kind === 'market-cap') return <Suspense fallback={<MarketCapFallback />}><MarketCapPage /></Suspense>;
  return <PendingRoute pathname={page.pathname} />;
}
