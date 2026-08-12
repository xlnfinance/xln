import { NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icons';
import { Toasts } from './Toasts';

const NAV: Array<{ to: string; label: string; icon: IconName }> = [
	{ to: '/', label: 'Home', icon: 'home' },
	{ to: '/accounts', label: 'Accounts', icon: 'accounts' },
	{ to: '/pay', label: 'Pay', icon: 'pay' },
	{ to: '/swap', label: 'Swap', icon: 'swap' },
	{ to: '/activity', label: 'Activity', icon: 'activity' },
	{ to: '/settings', label: 'Settings', icon: 'settings' },
];

export function Shell({ children }: { children: ReactNode }) {
	const location = useLocation();

	return (
		<div className="app">
			<nav className="rail" aria-label="Primary">
				<div className="rail-mark" aria-hidden>
					<span />
				</div>
				{NAV.map(item => (
					<NavLink
						key={item.to}
						to={item.to}
						end={item.to === '/'}
						className={({ isActive }) => `rail-item${isActive ? ' active' : ''}`}
						aria-label={item.label}
						title={item.label}
					>
						<Icon name={item.icon} size={18} />
					</NavLink>
				))}
				<div className="rail-spacer" />
			</nav>

			<main className="main">{children}</main>

			<nav className="tabbar" aria-label="Primary">
				{NAV.map(item => {
					const active = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to);
					return (
						<NavLink key={item.to} to={item.to} className={`tabbar-item${active ? ' active' : ''}`}>
							<Icon name={item.icon} size={18} />
							<span>{item.label}</span>
						</NavLink>
					);
				})}
			</nav>

			<Toasts />
		</div>
	);
}
