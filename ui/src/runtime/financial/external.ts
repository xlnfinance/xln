/**
 * The signer's on-chain wallet and the faucets. Balances come straight from
 * the jurisdiction adapter (the same `readWalletSnapshot` the SvelteKit
 * assets tab uses); faucets go to the runtime's HTTP API exactly as the
 * frontend sends them, with the sandbox's local equivalents where the page
 * hosts the chain itself.
 */
import { useEffect } from 'react';
import { isAddress } from 'ethers';
import { postJson } from '../http';
import { useApp } from '../store';
import { hostedJAdapter } from './move';

export type ExternalWalletRow = {
	tokenId: number;
	symbol: string;
	name: string;
	address: string;
	decimals: number;
	balance: bigint;
	/** Allowance granted to the Depository; null for the native coin. */
	allowance: bigint | null;
	error?: string;
};

export type ExternalWallet = {
	owner: string;
	depository: string;
	headBlockNumber: number;
	native: bigint | null;
	rows: ExternalWalletRow[];
};

const normalize = (value: unknown): string => String(value || '').trim().toLowerCase();

/** One snapshot of the signer's ERC20 balances and Depository allowances at the chain head. */
export async function readExternalWallet(entityId: string, signerId: string): Promise<ExternalWallet> {
	const jadapter = await hostedJAdapter(entityId, signerId);
	const registry = await jadapter.getTokenRegistry();
	// readWalletSnapshot reads ERC-20 balanceOf/allowance. ERC-1155 company
	// classes share one provider address and belong to the Ownership view.
	const tokens = registry.filter(token => token.tokenType === 0 && isAddress(token.address));
	const depository = normalize(jadapter.addresses.depository);
	const headBlockNumber = Number(await (jadapter.getCurrentBlockNumber?.() ?? jadapter.provider.getBlockNumber()));
	const snapshot = await jadapter.readWalletSnapshot({
		owner: signerId,
		tokenAddresses: tokens.map(token => token.address),
		allowances: tokens.map(token => ({ tokenAddress: token.address, spender: depository })),
		includeNativeBalance: true,
		blockTag: headBlockNumber,
	});
	const tokenErrors = new Map((snapshot.tokenErrors ?? []).map(entry => [normalize(entry.tokenAddress), String(entry.error || 'read failed')]));
	const rows: ExternalWalletRow[] = tokens.map((token, index) => {
		const error = tokenErrors.get(normalize(token.address));
		return {
			tokenId: Number(token.tokenId),
			symbol: token.symbol,
			name: token.name,
			address: normalize(token.address),
			decimals: Number(token.decimals),
			balance: snapshot.tokenBalances[index] ?? 0n,
			allowance: snapshot.allowances?.[index] ?? 0n,
			...(error ? { error } : {}),
		};
	});
	return { owner: normalize(signerId), depository, headBlockNumber, native: snapshot.nativeBalance, rows };
}

export type FaucetKind = 'erc20' | 'gas' | 'reserve' | 'offchain';

/** ETH per gas faucet request: the public cap on the dev stack, enough for every on-chain action in the tour. */
const GAS_FAUCET_ETH = '0.1';

/**
 * Faucets, in the frontend's request shapes. `amount` is a decimal string in
 * token units ("100", "0.1"); the server parses it.
 */
export async function requestFaucet(
	kind: FaucetKind,
	input: { entityId: string; signerId: string; runtimeId: string; jurisdiction: string; hubEntityId?: string; tokenId: number; tokenSymbol: string; amount: string },
): Promise<void> {
	const jurisdiction = input.jurisdiction;
	if ((kind === 'erc20' || kind === 'gas') && !jurisdiction) throw new Error('Select a network before requesting test funds.');
	switch (kind) {
		case 'erc20':
			await postJson('/api/faucet/erc20', { userAddress: input.signerId, tokenSymbol: input.tokenSymbol, amount: input.amount, jurisdiction });
			return;
		case 'gas':
			// Gas is ETH, not the token amount in the form; the public faucet caps gas at 0.1 ETH (XLN_FAUCET_MAX_GAS_AMOUNT),
			// the same amount the SvelteKit wallet asks for.
			await postJson('/api/faucet/gas', { userAddress: input.signerId, amount: GAS_FAUCET_ETH, jurisdiction });
			return;
		case 'reserve':
			await postJson('/api/faucet/reserve', { userEntityId: input.entityId, tokenId: input.tokenId, tokenSymbol: input.tokenSymbol, amount: input.amount });
			return;
		case 'offchain':
			if (!input.hubEntityId) throw new Error('Pick the hub that funds the account');
			await postJson(
				'/api/faucet/offchain',
				{ userEntityId: input.entityId, userRuntimeId: input.runtimeId, hubEntityId: input.hubEntityId, tokenId: input.tokenId, amount: input.amount },
				30_000,
			);
			return;
		default:
			throw new Error(`Unknown faucet ${String(kind)}`);
	}
}

/**
 * Keeps the store's on-chain rows fresh for the active entity: one read per
 * committed runtime frame, throttled, embedded runtimes only (a remote runtime
 * feeds the same numbers through its own watcher into `core.externalWallet`).
 */
export function useExternalWalletSync(entityId: string, signerId: string): void {
	const height = useApp(s => s.height);
	const setExternalRows = useApp(s => s.setExternalRows);
	useEffect(() => {
		if (!entityId || !signerId) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			readExternalWallet(entityId, signerId)
				.then(wallet => {
					if (!cancelled) setExternalRows(wallet.rows);
				})
				.catch(() => {
					if (!cancelled) setExternalRows([]);
				});
		}, 400);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [entityId, signerId, height, setExternalRows]);
}
