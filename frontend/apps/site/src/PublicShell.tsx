import type { ReactNode } from 'react';

const NAV_ITEMS = [
  ['App', '/app'],
  ['Install', '/install'],
  ['Docs', '/docs'],
  ['RCPAN', '/rcpan'],
  ['Releases', '/releases'],
] as const;

const activePath = (): string => window.location.pathname.replace(/\/$/, '') || '/';

export const PublicShell = ({ children }: Readonly<{ children: ReactNode }>) => (
  <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="site-header">
      <a className="site-mark" href="/" aria-label="xln home">
        <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 3 27h26L16 3Zm0 7 6.8 13H9.2L16 10Zm-7.8 9h15.6" /></svg>
        <span>xln</span>
      </a>
      <nav aria-label="Public navigation">
        {NAV_ITEMS.map(([label, href]) => (
          <a key={href} href={href} className={activePath() === href ? 'active' : undefined}>{label}</a>
        ))}
      </nav>
    </header>
    <main id="main-content">{children}</main>
    <dialog id="site-error-dialog" className="site-error-dialog">
      <p>Unexpected site error</p>
      <pre id="site-error-message" />
      <button type="button" onClick={() => window.location.reload()}>Reload</button>
    </dialog>
  </>
);
