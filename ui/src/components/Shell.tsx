import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../runtime/store';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icons';
import { Toasts } from './Toasts';
import { Palette } from './Palette';
import { useExternalWalletSync } from '../runtime/financial/external';
import { useWallet } from '../runtime/views';

/**
 * Destinations only. Pay, Receive and Swap are flows pushed over Home with a
 * back control, so no action is ever offered twice on one screen.
 */
const NAV: Array<{ to: string; label: string; icon: IconName; match: (pathname: string) => boolean }> = [
	{
		to: '/',
		label: 'Home',
		icon: 'home',
		match: pathname => pathname === '/' || pathname.startsWith('/accounts') || pathname === '/pay' || pathname === '/receive' || pathname === '/swap' || pathname === '/move',
	},
	{ to: '/activity', label: 'Activity', icon: 'activity', match: pathname => pathname.startsWith('/activity') },
	{
		to: '/manage',
		label: 'Manage',
		icon: 'accounts',
		match: pathname => pathname.startsWith('/manage') || pathname.startsWith('/assets') || pathname.startsWith('/lend') || pathname.startsWith('/ownership') || pathname.startsWith('/sovereignty') || pathname.startsWith('/desk'),
	},
	{ to: '/settings', label: 'Settings', icon: 'settings', match: pathname => pathname.startsWith('/settings') },
];

/** Screens with their own back control and one primary action; the tab bar would compete with them on a phone. */
const FLOW_ROUTES = new Set(['/pay', '/receive', '/swap', '/move']);

export function Shell({ children }: { children: ReactNode }) {
	const { pathname } = useLocation();
	const entityId = useApp(s => s.activeEntityId);
	const wallet = useWallet(entityId);
	useExternalWalletSync(wallet.entityId, wallet.signerId);
	const clearToasts = useApp(s => s.clearToasts);
	// A toast belongs to the screen that raised it.
	useEffect(() => clearToasts(), [pathname, clearToasts]);

	return (
		<div className="app">
			<Palette />
			<nav className="rail" aria-label="Primary">
				<div className="rail-mark" aria-hidden>
					△
				</div>
				{NAV.map(item => (
					<NavLink
						key={item.to}
						to={item.to}
						className={`rail-item${item.match(pathname) ? ' active' : ''}`}
						aria-label={item.label}
						title={item.label}
					>
						<Icon name={item.icon} size={19} />
					</NavLink>
				))}
				<div className="rail-spacer" />
			</nav>

			<main className="main">{children}</main>

			<nav className={`tabbar${FLOW_ROUTES.has(pathname) ? ' flow' : ''}`} aria-label="Primary">
				{NAV.map(item => (
					<NavLink key={item.to} to={item.to} className={`tabbar-item${item.match(pathname) ? ' active' : ''}`}>
						<Icon name={item.icon} size={20} />
						<span>{item.label}</span>
					</NavLink>
				))}
			</nav>

			<Toasts />
		</div>
	);
}
