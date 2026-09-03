import { create } from 'zustand';
import type { RuntimeAdapterStatus } from '@xln/core/api/public/runtime-module';

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

/** The three places money lives. Each can be hidden from Home. */
export type PlaceKey = 'onchain' | 'reserve' | 'accounts';
export type PlaceVisibility = Record<PlaceKey, boolean>;

const VAULTS_KEY = 'xln-ui-vaults';
const ACTIVE_VAULT_KEY = 'xln-ui-active-vault';
const THEME_KEY = 'xln-ui-theme';
const USD_PER_PX_KEY = 'xln-ui-usd-per-px';
const SCALE_MODE_KEY = 'xln-ui-scale-mode';
/** Track the auto scale fits the largest balance into: the hero bar on desktop, the screen width on a phone. */
const AUTO_FIT_PX = 560;
const autoFitPx = (): number => Math.min(AUTO_FIT_PX, Math.max(240, (typeof window === 'undefined' ? AUTO_FIT_PX : window.innerWidth) - 56));
const NICE_STEPS = [1, 2, 5];
const PLACES_KEY = 'xln-ui-places';

export const USD_PER_PX_MIN = 1;
export const USD_PER_PX_MAX = 1000;
const USD_PER_PX_DEFAULT = 10;

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

export function clampUsdPerPx(value: number): number {
	if (!Number.isFinite(value)) return USD_PER_PX_DEFAULT;
	return Math.min(USD_PER_PX_MAX, Math.max(USD_PER_PX_MIN, value));
}

function applyUsdPerPx(usdPerPx: number): void {
	document.documentElement.style.setProperty('--ppu', String(1 / usdPerPx));
}

function readInitialUsdPerPx(): number {
	const stored = Number(localStorage.getItem(USD_PER_PX_KEY));
	const value = stored > 0 ? clampUsdPerPx(stored) : USD_PER_PX_DEFAULT;
	applyUsdPerPx(value);
	return value;
}

export type ScaleMode = 'auto' | 'fixed';

function readInitialScaleMode(): ScaleMode {
	return localStorage.getItem(SCALE_MODE_KEY) === 'fixed' ? 'fixed' : 'auto';
}

/** Smallest 1-2-5 step (dollars per pixel) at which `maxUsd` fits the auto-fit track. */
export function niceUsdPerPx(maxUsd: number): number {
	const raw = Math.max(USD_PER_PX_MIN, maxUsd / autoFitPx());
	let magnitude = 1;
	while (magnitude * 10 <= raw) magnitude *= 10;
	for (const step of NICE_STEPS) {
		if (step * magnitude >= raw) return clampUsdPerPx(step * magnitude);
	}
	return clampUsdPerPx(10 * magnitude);
}

function readInitialPlaces(): PlaceVisibility {
	const defaults: PlaceVisibility = { onchain: true, reserve: true, accounts: true };
	try {
		const raw = localStorage.getItem(PLACES_KEY);
		if (!raw) return defaults;
		const parsed = JSON.parse(raw) as Partial<Record<PlaceKey, unknown>>;
		return {
			onchain: parsed.onchain !== false,
			reserve: parsed.reserve !== false,
			accounts: parsed.accounts !== false,
		};
	} catch {
		return defaults;
	}
}

let toastSeq = 0;

type AppState = {
	theme: ThemeName;
	setTheme: (theme: ThemeName) => void;

	/** Dollars per pixel for every bar. Persisted; drives the --ppu CSS variable. */
	usdPerPx: number;
	/** `auto` fits the largest bar on Home to the track; `fixed` pins the user's own scale. */
	scaleMode: ScaleMode;
	setUsdPerPx: (usdPerPx: number) => void;
	setScaleMode: (mode: ScaleMode) => void;
	/** Home reports its largest bar; in auto mode the scale follows it. */
	fitScale: (maxUsd: number) => void;

	places: PlaceVisibility;
	setPlaceVisible: (place: PlaceKey, visible: boolean) => void;

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
	/** True while an embedded runtime is booting or seeding: keep the gate up. */
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
	/** Drop every toast: a route change or a committed receipt supersedes them. */
	clearToasts: () => void;
};

export const useApp = create<AppState>((set, get) => ({
	theme: readInitialTheme(),
	setTheme: theme => {
		localStorage.setItem(THEME_KEY, theme);
		document.documentElement.dataset['theme'] = theme;
		set({ theme });
	},

	usdPerPx: readInitialUsdPerPx(),
	scaleMode: readInitialScaleMode(),
	setScaleMode: mode => {
		localStorage.setItem(SCALE_MODE_KEY, mode);
		set({ scaleMode: mode });
	},
	fitScale: maxUsd => {
		if (get().scaleMode !== 'auto' || !(maxUsd > 0)) return;
		const usdPerPx = niceUsdPerPx(maxUsd);
		if (usdPerPx === get().usdPerPx) return;
		applyUsdPerPx(usdPerPx);
		set({ usdPerPx });
	},
	setUsdPerPx: value => {
		const usdPerPx = clampUsdPerPx(value);
		localStorage.setItem(USD_PER_PX_KEY, String(usdPerPx));
		localStorage.setItem(SCALE_MODE_KEY, 'fixed');
		applyUsdPerPx(usdPerPx);
		set({ usdPerPx, scaleMode: 'fixed' });
	},

	places: readInitialPlaces(),
	setPlaceVisible: (place, visible) => {
		const places = { ...get().places, [place]: visible };
		localStorage.setItem(PLACES_KEY, JSON.stringify(places));
		set({ places });
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
	clearToasts: () => set({ toasts: [] }),
}));
