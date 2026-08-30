import type { ReactNode } from 'react';

import { OPS_LINKS } from './ops-model';
import './styles/ops-shell.css';

export function OpsShell({ activePath, children }: Readonly<{
  activePath: string;
  children: ReactNode;
}>) {
  return (
    <main className="ops-shell">
      <aside className="ops-rail">
        <a className="ops-brand" href="/health" aria-label="xln operations">xln</a>
        <div className="ops-rail-context">
          <span>OPS</span>
          <strong>CONTROL</strong>
        </div>
        <nav className="ops-nav" aria-label="Operator navigation">
          {OPS_LINKS.map(link => (
            <a
              aria-current={link.href === activePath ? 'page' : undefined}
              className={link.href === activePath ? 'is-current' : undefined}
              href={link.href}
              key={link.href}
            >
              <span>{link.label}</span>
              <i aria-hidden="true" />
            </a>
          ))}
        </nav>
        <p>Operator-only evidence.<br />No inferred readiness.</p>
      </aside>
      <div className="ops-canvas">{children}</div>
    </main>
  );
}
