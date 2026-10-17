import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icons';

/**
 * Every screen opens the same way: an accent breadcrumb to its parent section,
 * one large title, an optional line under it and the screen's own controls on
 * the right. The breadcrumb names where it goes and goes exactly there; a
 * top-level screen shows a plain eyebrow in the same place.
 */
export function PageHead({
  title,
  parent,
  eyebrow,
  sub,
  actions,
}: {
  title: ReactNode;
  parent?: { label: string; to: string };
  /** Top-level screens have no parent; the eyebrow keeps every title at the same height. */
  eyebrow?: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="page-head">
      <div>
        {parent ? (
          <button
            type="button"
            className="crumb"
            onClick={() => navigate(parent.to)}
            aria-label="Back"
            data-testid="back"
          >
            <Icon name="chevronLeft" size={15} />
            {parent.label}
          </button>
        ) : eyebrow ? (
          <span className="crumb static">{eyebrow}</span>
        ) : null}
        <h1 className="page-title">{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export const HOME = { label: 'Home', to: '/' } as const;
export const MANAGE = { label: 'Manage', to: '/manage' } as const;
