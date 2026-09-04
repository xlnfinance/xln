/**
 * The signer's on-chain wallet and the faucets. Balances come straight from
 * the jurisdiction adapter (the same `readWalletSnapshot` the SvelteKit
 * assets tab uses); faucets go to the runtime's HTTP API exactly as the
 * frontend sends them, with the sandbox's local equivalents where the page
 * hosts the chain itself.
 */
import { isAddress } from 'ethers';
import { postJson } from '../http';
import { demoFaucet, getDemoTopology } from '../sandbox';
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
	const tokens = registry.filter(token => isAddress(token.address));
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

/**
 * Faucets, in the frontend's request shapes. `amount` is a decimal string in
 * token units ("100", "0.1"); the server parses it.
 */
export async function requestFaucet(
	kind: FaucetKind,
	input: { entityId: string; signerId: string; runtimeId: string; hubEntityId?: string; tokenId: number; tokenSymbol: string; amount: string },
): Promise<void> {
	switch (kind) {
		case 'erc20':
			await postJson('/api/faucet/erc20', { userAddress: input.signerId, tokenSymbol: input.tokenSymbol, amount: input.amount });
			return;
		case 'gas':
			await postJson('/api/faucet/gas', { userAddress: input.signerId, amount: input.amount });
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

/** True when the page hosts the demo chain and hub, so faucets can run locally. */
export function sandboxFaucetsAvailable(): boolean {
	return getDemoTopology() !== null;
}

/**
 * Sandbox faucets: the hub pays over credit (off-chain) or the BrowserVM
 * deployer tops the signer up (on-chain). `fundSignerWallet` funds *to* a
 * target balance, so the target is the current balance plus the request.
 * Gas is not offered: the BrowserVM keeps every funded signer at 1000 ETH.
 */
export async function sandboxFaucet(kind: 'offchain' | 'erc20', input: { entityId: string; signerId: string; tokenSymbol: string; amount: bigint }): Promise<void> {
	if (kind === 'offchain') {
		await demoFaucet(input.entityId, input.amount);
		return;
	}
	const jadapter = await hostedJAdapter(input.entityId, input.signerId);
	if (!jadapter.fundSignerWallet) throw new Error('This chain cannot mint to a wallet');
	const registry = await jadapter.getTokenRegistry();
	const token = registry.find(entry => entry.symbol.toUpperCase() === input.tokenSymbol.toUpperCase());
	if (!token) throw new Error(`Unknown sandbox token ${input.tokenSymbol}`);
	const snapshot = await jadapter.readWalletSnapshot({ owner: input.signerId, tokenAddresses: [token.address] });
	const current = snapshot.tokenBalances[0] ?? 0n;
	await jadapter.fundSignerWallet(input.signerId, current + input.amount, token.symbol);
}
