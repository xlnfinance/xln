import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from './Icons';
import { useApp } from '../runtime/store';
import { useWallet } from '../runtime/views';

type Command = { id: string; title: string; hint?: string; icon: IconName; run: () => void; keywords?: string };

/**
 * ⌘K. Every destination and every account, one keystroke away. Desktop only:
 * on a phone the tab bar is the palette.
 */
export function Palette() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId);
	const theme = useApp(s => s.theme);
	const setTheme = useApp(s => s.setTheme);
	const density = useApp(s => s.density);
	const setDensity = useApp(s => s.setDensity);
	const setTour = useApp(s => s.setTour);
	const wallet = useWallet(entityId);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [cursor, setCursor] = useState(0);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				setOpen(value => !value);
			} else if (event.key === 'Escape') setOpen(false);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	useEffect(() => {
		if (open) {
			setQuery('');
			setCursor(0);
			setTimeout(() => input.current?.focus(), 0);
		}
	}, [open]);

	const commands = useMemo<Command[]>(() => {
		const go = (to: string) => () => navigate(to);
		const list: Command[] = [
			{ id: 'pay', title: 'Pay', hint: 'send money', icon: 'pay', run: go('/pay') },
			{ id: 'receive', title: 'Receive', hint: 'invoice, QR', icon: 'receive', run: go('/receive') },
			{ id: 'swap', title: 'Swap', hint: 'book at the hub', icon: 'swap', run: go('/swap') },
			{ id: 'move', title: 'Move', hint: 'wallet ↔ reserve ↔ account', icon: 'arrow', run: go('/move') },
			{ id: 'home', title: 'Home', icon: 'home', run: go('/') },
			{ id: 'desk', title: 'Desk', hint: 'dense console', icon: 'accounts', run: go('/desk') },
			{ id: 'activity', title: 'Activity', icon: 'activity', run: go('/activity') },
			{ id: 'manage', title: 'Manage', hint: 'batch, attention, doors', icon: 'accounts', run: go('/manage') },
			{ id: 'sovereignty', title: 'Sovereignty', hint: 'keys, proofs, exposure', icon: 'shield', run: go('/sovereignty') },
			{ id: 'assets', title: 'Assets', hint: 'on-chain wallet, faucets, debts', icon: 'wallet', run: go('/assets') },
			{ id: 'lend', title: 'Lending', icon: 'bank', run: go('/lend') },
			{ id: 'ownership', title: 'Ownership', icon: 'shield', run: go('/ownership') },
			{ id: 'settings', title: 'Settings', icon: 'settings', run: go('/settings') },
			{ id: 'tour', title: 'Guided tour', hint: 'five minutes, live sandbox', icon: 'bolt', run: () => setTour({ active: true, index: 0 }), keywords: 'learn tutorial help' },
			{ id: 'theme', title: theme === 'dark' ? 'Light theme' : 'Dark theme', icon: theme === 'dark' ? 'sun' : 'moon', run: () => setTheme(theme === 'dark' ? 'light' : 'dark'), keywords: 'theme appearance' },
			{ id: 'density', title: density === 'desk' ? 'Comfort layout' : 'Desk layout', icon: 'filter', run: () => setDensity(density === 'desk' ? 'comfort' : 'desk'), keywords: 'layout density' },
		];
		for (const account of wallet.accounts) {
			list.push({
				id: `account-${account.counterpartyId}`,
				title: account.label,
				hint: account.isHub ? 'hub account' : 'account',
				icon: 'accounts',
				run: go(`/accounts/${account.counterpartyId}`),
				keywords: account.counterpartyId,
			});
			list.push({ id: `pay-${account.counterpartyId}`, title: `Pay ${account.label}`, icon: 'pay', run: go(`/pay?to=${account.counterpartyId}`), keywords: 'send' });
		}
		return list;
	}, [navigate, theme, setTheme, density, setDensity, setTour, wallet.accounts]);

	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return commands.slice(0, 12);
		return commands.filter(command => `${command.title} ${command.hint ?? ''} ${command.keywords ?? ''}`.toLowerCase().includes(needle)).slice(0, 12);
	}, [commands, query]);

	if (!open) return null;
	const pick = (command: Command): void => {
		setOpen(false);
		command.run();
	};

	return (
		<div className="scrim" onClick={() => setOpen(false)} data-testid="palette">
			<div className="palette" onClick={event => event.stopPropagation()}>
				<div className="palette-input">
					<Icon name="filter" size={16} />
					<input
						ref={input}
						className="input"
						placeholder="Jump to… (⌘K)"
						value={query}
						onChange={event => {
							setQuery(event.target.value);
							setCursor(0);
						}}
						onKeyDown={event => {
							if (event.key === 'ArrowDown') {
								event.preventDefault();
								setCursor(value => Math.min(matches.length - 1, value + 1));
							} else if (event.key === 'ArrowUp') {
								event.preventDefault();
								setCursor(value => Math.max(0, value - 1));
							} else if (event.key === 'Enter' && matches[cursor]) pick(matches[cursor]);
						}}
						data-testid="palette-input"
					/>
				</div>
				<div className="palette-list" role="listbox">
					{matches.map((command, index) => (
						<button key={command.id} type="button" role="option" aria-selected={index === cursor} className={`palette-item${index === cursor ? ' active' : ''}`} onMouseEnter={() => setCursor(index)} onClick={() => pick(command)}>
							<Icon name={command.icon} size={15} />
							<span className="t">{command.title}</span>
							{command.hint ? <span className="s">{command.hint}</span> : null}
						</button>
					))}
					{matches.length === 0 ? <p className="note" style={{ padding: '10px 14px' }}>Nothing matches.</p> : null}
				</div>
			</div>
		</div>
	);
}
