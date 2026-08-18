import { Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Toasts } from './components/Toasts';
import { useApp } from './core/store';
import { Gate } from './screens/Gate';
import { Home } from './screens/Home';
import { Accounts } from './screens/Accounts';
import { AccountDetail } from './screens/AccountDetail';
import { Pay } from './screens/Pay';
import { Swap } from './screens/Swap';
import { Receive } from './screens/Receive';
import { ActivityScreen } from './screens/Activity';
import { SettingsScreen } from './screens/Settings';

export default function App() {
	const status = useApp(s => s.adapterStatus);
	const booting = useApp(s => s.booting);

	if (status !== 'connected' || booting) {
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
				<Route path="/accounts" element={<Accounts />} />
				<Route path="/accounts/:counterpartyId" element={<AccountDetail />} />
				<Route path="/pay" element={<Pay />} />
				<Route path="/swap" element={<Swap />} />
				<Route path="/receive" element={<Receive />} />
				<Route path="/activity" element={<ActivityScreen />} />
				<Route path="/settings" element={<SettingsScreen />} />
				<Route path="*" element={<Home />} />
			</Routes>
		</Shell>
	);
}
