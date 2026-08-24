import type { MouseEvent, ReactNode } from 'react';

type SiteShellProps = Readonly<{
  activeRoute: '/' | '/install' | '/rcpan' | '/unicast' | 'pending';
  children: ReactNode;
}>;

type LaunchLinkProps = Readonly<{
  className?: string;
  children: ReactNode;
}>;

export function Arrow({ diagonal = false }: Readonly<{ diagonal?: boolean }>) {
  return <span aria-hidden="true">{diagonal ? '↗' : '→'}</span>;
}

export function LaunchLink({ className, children }: LaunchLinkProps) {
  const openWallet = (_event: MouseEvent<HTMLAnchorElement>): void => {
    window.localStorage.setItem('open', 'true');
  };
  return <a className={className} href="/app" onClick={openWallet}>{children}</a>;
}

export function SiteShell({ activeRoute, children }: SiteShellProps) {
  return (
    <div className="site-frame">
      <header className="site-header">
        <a className="site-wordmark" href="/" aria-label="xln home">xln<span>.</span></a>
        <nav aria-label="Primary navigation">
          <a className={activeRoute === '/' ? 'is-active' : undefined} href="/">Thesis</a>
          <a className={activeRoute === '/rcpan' ? 'is-active' : undefined} href="/rcpan">RCPAN</a>
          <a className={activeRoute === '/unicast' ? 'is-active' : undefined} href="/unicast">Unicast</a>
          <a className={activeRoute === '/install' ? 'is-active' : undefined} href="/install">Install</a>
          <a href="/docs">Docs</a>
        </nav>
        <LaunchLink className="header-launch">Launch <Arrow /></LaunchLink>
      </header>
      {children}
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <a className="site-wordmark" href="/" aria-label="xln home">xln<span>.</span></a>
      <p>Cross-local network<br />Off-chain settlement · on-chain anchoring</p>
      <div className="footer-links">
        <a href="https://github.com/xlnfinance/xln" target="_blank" rel="noreferrer">GitHub <Arrow diagonal /></a>
        <a href="https://x.com/xlnfinance" target="_blank" rel="noreferrer">X <Arrow diagonal /></a>
        <a href="mailto:h@xln.finance">Contact <Arrow diagonal /></a>
      </div>
    </footer>
  );
}
