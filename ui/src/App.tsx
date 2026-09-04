import { useEffect } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Toasts } from './components/Toasts';
import { PaymentReceiptSheet } from './components/PaymentReceipt';
import { useApp } from './runtime/store';
import { startPaymentTerminal } from './runtime/financial/receipts';
import { Gate } from './screens/Gate';
import { Home } from './screens/Home';
import { AccountDetail } from './screens/AccountDetail';
import { Pay } from './screens/Pay';
import { Swap } from './screens/Swap';
import { Receive } from './screens/Receive';
import { Move } from './screens/Move';
import { ActivityScreen } from './screens/Activity';
import { SettingsScreen } from './screens/Settings';
import { Manage } from './screens/Manage';
import { Assets } from './screens/Assets';
import { Lending } from './screens/Lending';
import { Ownership } from './screens/Ownership';

/** `/#pay/<invoice>` is the canonical wallet link; it opens Pay with the invoice applied. */
function useInvoiceDeepLink(): void {
	const navigate = useNavigate();
	const { hash } = useLocation();
	useEffect(() => {
		const raw = hash.startsWith('#') ? hash.slice(1) : hash;
		if (!raw.toLowerCase().startsWith('pay/')) return;
		navigate('/pay', { replace: true, state: { invoice: window.location.href } });
	}, [hash, navigate]);
}

export default function App() {
	const status = useApp(s => s.adapterStatus);
	const booting = useApp(s => s.booting);
	const activeEntityId = useApp(s => s.activeEntityId);
	// The wallet needs a connected runtime and a chosen entity; anything less stays on the gate.
	const connected = status === 'connected' && !booting && Boolean(activeEntityId);

	useInvoiceDeepLink();

	useEffect(() => {
		if (!connected) return;
		return startPaymentTerminal();
	}, [connected]);

	if (!connected) {
		return (
			<>
				<Gate />
				<Toasts />
			</>
		);
	}

	return (
		<Shell>
			<Routes>
				<Route path="/" element={<Home />} />
				<Route path="/accounts/:counterpartyId" element={<AccountDetail />} />
				<Route path="/pay" element={<Pay />} />
				<Route path="/swap" element={<Swap />} />
				<Route path="/receive" element={<Receive />} />
				<Route path="/move" element={<Move />} />
				<Route path="/manage" element={<Manage />} />
				<Route path="/assets" element={<Assets />} />
				<Route path="/lend" element={<Lending />} />
				<Route path="/ownership" element={<Ownership />} />
				<Route path="/activity" element={<ActivityScreen />} />
				<Route path="/settings" element={<SettingsScreen />} />
				<Route path="*" element={<Home />} />
			</Routes>
			<PaymentReceiptSheet />
		</Shell>
	);
}
