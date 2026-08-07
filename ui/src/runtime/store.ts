import { create } from 'zustand';
import type { RuntimeAdapterStatus } from '@xln/runtime/api/public/runtime-module';

export type ThemeName = 'dark' | 'light';

export type VaultKind = 'brainvault' | 'mnemonic' | 'sandbox' | 'remote';

export type VaultMeta = {
	id: string;
	name: string;
	kind: VaultKind;
	createdAt: number;
	brainvault?: { factor: number };
	remote?: { wsUrl: string };
};

export type Toast = {
	id: number;
	text: string;
	kind: 'info' | 'danger';
};

const VAULTS_KEY = 'xln-ui-vaults';
const ACTIVE_VAULT_KEY = 'xln-ui-active-vault';
const THEME_KEY = 'xln-ui-theme';

function readStoredVaults(): VaultMeta[] {
	try {
		const raw = localStorage.getItem(VAULTS_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is VaultMeta => {
			const v = entry as Partial<VaultMeta> | null;
			return Boolean(v && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.kind === 'string');
		});
	} catch {
		return [];
	}
}

function persistVaults(vaults: VaultMeta[]): void {
	localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults));
}

function readInitialTheme(): ThemeName {
	const stored = localStorage.getItem(THEME_KEY);
	if (stored === 'light' || stored === 'dark') return stored;
	return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark';
}

let toastSeq = 0;

type AppState = {
	theme: ThemeName;
	setTheme: (theme: ThemeName) => void;

	vaults: VaultMeta[];
	activeVaultId: string | null;
	addVault: (vault: VaultMeta) => void;
	removeVault: (id: string) => void;
	setActiveVault: (id: string | null) => void;

	/** Unlocked seed phrases, memory only. Never persisted. */
	sessionSeeds: Record<string, string>;
	unlockSeed: (vaultId: string, seed: string) => void;
	lockAll: () => void;

	adapterStatus: RuntimeAdapterStatus;
	height: number;
	commandReady: boolean;
	/** True while an embedded runtime is booting/seeding — keep the gate up. */
	booting: boolean;
	setBooting: (booting: boolean) => void;
	setAdapterState: (state: { status?: RuntimeAdapterStatus; height?: number; commandReady?: boolean }) => void;

	activeEntityId: string | null;
	setActiveEntityId: (entityId: string | null) => void;

	selectedTokenId: number;
	setSelectedTokenId: (tokenId: number) => void;

	toasts: Toast[];
	toast: (text: string, kind?: Toast['kind']) => void;
	dismissToast: (id: number) => void;
};

export const useApp = create<AppState>((set, get) => ({
	theme: readInitialTheme(),
	setTheme: theme => {
		localStorage.setItem(THEME_KEY, theme);
		document.documentElement.dataset['theme'] = theme;
		set({ theme });
	},

	vaults: readStoredVaults(),
	activeVaultId: localStorage.getItem(ACTIVE_VAULT_KEY),
	addVault: vault => {
		const vaults = [...get().vaults.filter(v => v.id !== vault.id), vault];
		persistVaults(vaults);
		set({ vaults });
	},
	removeVault: id => {
		const vaults = get().vaults.filter(v => v.id !== id);
		persistVaults(vaults);
		const sessionSeeds = { ...get().sessionSeeds };
		delete sessionSeeds[id];
		set({ vaults, sessionSeeds });
		if (get().activeVaultId === id) {
			localStorage.removeItem(ACTIVE_VAULT_KEY);
			set({ activeVaultId: null });
		}
	},
	setActiveVault: id => {
		if (id) localStorage.setItem(ACTIVE_VAULT_KEY, id);
		else localStorage.removeItem(ACTIVE_VAULT_KEY);
		set({ activeVaultId: id });
	},

	sessionSeeds: {},
	unlockSeed: (vaultId, seed) => set({ sessionSeeds: { ...get().sessionSeeds, [vaultId]: seed } }),
	lockAll: () => set({ sessionSeeds: {} }),

	adapterStatus: 'disconnected',
	height: 0,
	commandReady: false,
	booting: false,
	setBooting: booting => set({ booting }),
	setAdapterState: state =>
		set({
			...(state.status !== undefined ? { adapterStatus: state.status } : {}),
			...(state.height !== undefined ? { height: state.height } : {}),
			...(state.commandReady !== undefined ? { commandReady: state.commandReady } : {}),
		}),

	activeEntityId: null,
	setActiveEntityId: entityId => set({ activeEntityId: entityId }),

	selectedTokenId: 1,
	setSelectedTokenId: tokenId => set({ selectedTokenId: tokenId }),

	toasts: [],
	toast: (text, kind = 'info') => {
		const id = ++toastSeq;
		set({ toasts: [...get().toasts, { id, text, kind }] });
		setTimeout(() => get().dismissToast(id), kind === 'danger' ? 7000 : 4000);
	},
	dismissToast: id => set({ toasts: get().toasts.filter(t => t.id !== id) }),
}));
