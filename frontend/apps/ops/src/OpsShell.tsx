import { type ReactNode } from 'react';
import type { OpsRouteContract } from './ops-route-capabilities';

const links = [
  ['/health', 'Health'], ['/qa', 'QA'], ['/runs', 'Runs'],
  ['/scenarios', 'Scenarios'], ['/ai', 'AI'], ['/embed', 'Embed'],
] as const;

export const OpsShell = ({ route, children }: Readonly<{ route: OpsRouteContract; children: ReactNode }>) => route.id === 'embed' ? (
  <main className="ops-embed-main" data-route="embed">{children}</main>
) : (
  <div className="ops-shell" data-route={route.id}>
    <header className="ops-topbar">
      <a href="/health" className="ops-brand">xln<span>/ops</span></a>
      <span className="ops-audience">{route.audience}</span>
      <span className="ops-live"><i /> isolated surface</span>
    </header>
    <aside className="ops-sidebar">
      <nav aria-label="Operator routes">
        {links.map(([href, label], index) => <a key={href} href={href} aria-current={route.id === href.slice(1) || (route.id === 'ai' && href === '/ai') ? 'page' : undefined}><small>{String(index + 1).padStart(2, '0')}</small>{label}</a>)}
      </nav>
      <div className="ops-boundary"><span>capabilities</span>{route.capabilities.map(capability => <code key={capability}>{capability}</code>)}</div>
    </aside>
    <main className="ops-main">{children}</main>
  </div>
);
