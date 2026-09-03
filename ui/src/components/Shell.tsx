import { NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icons';
import { Toasts } from './Toasts';

/**
 * Destinations only. Pay, Receive and Swap are flows pushed over Home with a
 * back control, so no action is ever offered twice on one screen.
 */
const NAV: Array<{ to: string; label: string; icon: IconName; match: (pathname: string) => boolean }> = [
	{
		to: '/',
		label: 'Home',
		icon: 'home',
		match: pathname => pathname === '/' || pathname.startsWith('/accounts') || pathname === '/pay' || pathname === '/receive' || pathname === '/swap',
	},
	{ to: '/activity', label: 'Activity', icon: 'activity', match: pathname => pathname.startsWith('/activity') },
	{ to: '/settings', label: 'Settings', icon: 'settings', match: pathname => pathname.startsWith('/settings') },
];

export function Shell({ children }: { children: ReactNode }) {
	const { pathname } = useLocation();

	return (
		<div className="app">
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

			<nav className="tabbar" aria-label="Primary">
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
