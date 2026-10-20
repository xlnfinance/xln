/**
 * The signer's on-chain wallet and the faucets. Balances come straight from
 * the jurisdiction adapter (the same `readWalletSnapshot` the SvelteKit
 * assets tab uses); faucets go to the runtime's HTTP API exactly as the
 * frontend sends them, with the sandbox's local equivalents where the page
 * hosts the chain itself.
 */
import { useEffect, useState } from 'react';
import { isAddress } from 'ethers';
import { postJson, resolveApiBase } from '../http';
import { useApp } from '../store';
import type { TokenCatalogEntry } from '../token-meta';
import { hostedJAdapter } from './move';
import { requireAdapter } from '../adapter';
import {
  walletSnapshotSourceAdvance,
  type WalletSnapshotSourceAdvance,
} from '@xln/core/jurisdiction/adapter/rpc/wallet/snapshot-source';
import type { RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
import {
	fetchExternalTokenCatalog,
	requestExternalWalletSnapshot,
} from '@xln/frontend/lib/components/Entity/external-wallet-reader';

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
	catalog: TokenCatalogEntry[];
};

const normalize = (value: unknown): string =>
	String(value || '')
		.trim()
		.toLowerCase();

/** One snapshot of the signer's ERC20 balances and Depository allowances at the chain head. */
export async function readExternalWallet(entityId: string, signerId: string): Promise<ExternalWallet> {
	if (requireAdapter().mode === 'remote') return readRemoteExternalWallet(entityId, signerId);
	const jadapter = await hostedJAdapter(entityId, signerId);
	const registry = await jadapter.getTokenRegistry();
	// readWalletSnapshot reads ERC-20 balanceOf/allowance. ERC-1155 company
	// classes share one provider address; keep their metadata in the full catalog.
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
	const tokenErrors = new Map(
		(snapshot.tokenErrors ?? []).map(entry => [normalize(entry.tokenAddress), String(entry.error || 'read failed')]),
	);
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
	return { owner: normalize(signerId), depository, headBlockNumber, native: snapshot.nativeBalance, rows,
		catalog: registry.map(token => ({ tokenId: Number(token.tokenId), symbol: token.symbol, name: token.name, decimals: token.decimals })),
	};
}

/** Remote wallets use the same validated HTTP catalog/snapshot reader as the full wallet. */
async function readRemoteExternalWallet(entityId: string, signerId: string): Promise<ExternalWallet> {
	const frame = await requireAdapter().read<RuntimeAdapterViewFrame>('view-frame', {
		entityId,
		accountsLimit: 1,
		booksLimit: 1,
	});
	const depository = String(frame.activeEntity?.core?.config.jurisdiction?.depositoryAddress || '');
	if (!isAddress(depository)) throw new Error('JURISDICTION_DEPOSITORY_UNAVAILABLE');
	const apiBase = resolveApiBase();
	const registry = await fetchExternalTokenCatalog(apiBase, entityId);
	const tokens = registry.filter(token => token.tokenType === 0);
	const snapshot = await requestExternalWalletSnapshot(
		apiBase,
		entityId,
		signerId,
		tokens,
		tokens.map(token => ({ tokenAddress: token.address, spender: depository })),
	);
	if (!snapshot) throw new Error('EXTERNAL_WALLET_SNAPSHOT_UNAVAILABLE');
	const headBlockNumber = snapshot.headBlockNumber;
	if (typeof headBlockNumber !== 'number' || !Number.isSafeInteger(headBlockNumber))
		throw new Error('EXTERNAL_WALLET_HEAD_MISSING');
	const rows = tokens.map((token, index) => {
		const error = snapshot.tokenErrors?.find(
			entry => normalize(entry.tokenAddress) === normalize(token.address),
		)?.error;
		return {
			tokenId: token.tokenId!,
			symbol: token.symbol,
			name: token.symbol,
			address: token.address,
			decimals: token.decimals,
			balance: snapshot.balances[index]!,
			allowance: snapshot.allowanceValues[index]!,
			...(error ? { error } : {}),
		};
	});
	return { owner: normalize(signerId), depository, headBlockNumber, native: snapshot.nativeBalance, rows,
		catalog: registry.map(token => ({ tokenId: Number(token.tokenId), symbol: token.symbol, name: token.symbol, decimals: token.decimals })),
	};
}

export type FaucetKind = 'erc20' | 'gas' | 'reserve' | 'offchain';

/**
 * Faucets, in the frontend's request shapes. `amount` is a decimal string in
 * token units ("100", "0.1"); the server parses it.
 */
export async function requestFaucet(
	kind: FaucetKind,
	input: {
		entityId: string;
		signerId: string;
		runtimeId: string;
		jurisdiction: string;
		hubEntityId?: string;
		tokenId: number;
		tokenSymbol: string;
		amount: string;
	},
): Promise<void> {
	const jurisdiction = input.jurisdiction;
	if ((kind === 'erc20' || kind === 'gas') && !jurisdiction)
		throw new Error('Select a network before requesting test funds.');
	switch (kind) {
		case 'erc20':
			await postJson('/api/faucet/erc20', {
				userAddress: input.signerId,
				tokenSymbol: input.tokenSymbol,
				amount: input.amount,
				jurisdiction,
			});
			return;
		case 'gas':
			// The server sizes a gas grant from current fees and its configured cap.
			await postJson('/api/faucet/gas', { userAddress: input.signerId, jurisdiction });
			return;
		case 'reserve':
			await postJson('/api/faucet/reserve', {
				userEntityId: input.entityId,
				tokenId: input.tokenId,
				tokenSymbol: input.tokenSymbol,
				amount: input.amount,
			}, 90_000);
			return;
		case 'offchain':
			if (!input.hubEntityId) throw new Error('Pick the hub that funds the account');
			await postJson(
				'/api/faucet/offchain',
				{
					userEntityId: input.entityId,
					userRuntimeId: input.runtimeId,
					hubEntityId: input.hubEntityId,
					tokenId: input.tokenId,
					amount: input.amount,
				},
				30_000,
			);
			return;
		default:
			throw new Error(`Unknown faucet ${String(kind)}`);
	}
}

const EXTERNAL_WALLET_REFRESH = 'xln-external-wallet-refresh';

/** One snapshot owner serves Assets, Home and Move, including explicit faucet/refresh requests. */
export function requestExternalWalletRefresh(): void {
  window.dispatchEvent(new Event(EXTERNAL_WALLET_REFRESH));
}

export function useExternalWalletSync(entityId: string, signerId: string) {
  const setExternalWallet = useApp(s => s.setExternalWallet);
  const [snapshot, setSnapshot] = useState<{
    entityId: string;
    error: string;
    sourceAdvance: WalletSnapshotSourceAdvance | null;
  }>({ entityId: '', error: '', sourceAdvance: null });
  useEffect(() => {
    if (!entityId || !signerId) return;
    let cancelled = false;
    let reading = false;
    let requested = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      if (reading) {
        requested = true;
        return;
      }
      clearTimeout(timer);
      reading = true;
      requested = false;
      try {
        const wallet = await readExternalWallet(entityId, signerId);
        if (!cancelled) {
          setExternalWallet(wallet);
          setSnapshot({ entityId, error: '', sourceAdvance: null });
        }
      } catch (error) {
        if (!cancelled) {
          setExternalWallet(null);
          setSnapshot({
            entityId: '',
            error: error instanceof Error ? error.message : String(error),
            sourceAdvance: walletSnapshotSourceAdvance(error),
          });
        }
      } finally {
        reading = false;
        // An external ERC20 receipt need not create a Runtime frame. Poll only
        // after the previous read completes; frame traffic must not starve it.
        if (!cancelled) timer = setTimeout(() => void refresh(), requested ? 0 : 3_000);
      }
    };
    const request = (): void => {
      void refresh();
    };
    window.addEventListener(EXTERNAL_WALLET_REFRESH, request);
    timer = setTimeout(request, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(EXTERNAL_WALLET_REFRESH, request);
    };
  }, [entityId, signerId, setExternalWallet]);
  return {
    ready: Boolean(entityId) && snapshot.entityId === entityId,
    error: snapshot.error,
    sourceAdvance: snapshot.sourceAdvance,
    retry: requestExternalWalletRefresh,
  };
}
