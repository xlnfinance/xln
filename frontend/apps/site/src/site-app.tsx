import { InstallPage } from './install-page';
import { LandingPage } from './landing-page';
import { RcpanPage } from './rcpan-page';
import { Arrow, SiteFooter, SiteShell } from './site-shell';
import type { SitePage } from './site-model';

function PendingRoute({ pathname }: Readonly<{ pathname: string }>) {
  return (
    <SiteShell activeRoute="pending">
      <main className="pending-route">
        <p className="kicker">React site migration</p>
        <h1>This route stays canonical for now.</h1>
        <p><code>{pathname}</code> is outside the `/` and `/install` pilot. The Svelte production route is unchanged.</p>
        <a className="text-link" href="/">Return to the pilot <Arrow /></a>
      </main>
      <SiteFooter />
    </SiteShell>
  );
}

export function SiteApp({ page }: Readonly<{ page: SitePage }>) {
  if (page.kind === 'home') return <LandingPage />;
  if (page.kind === 'install') return <InstallPage />;
  if (page.kind === 'rcpan') return <RcpanPage />;
  return <PendingRoute pathname={page.pathname} />;
}
