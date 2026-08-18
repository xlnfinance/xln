import type { EntityTx, RuntimeInput } from '@xln/core/api/public/runtime-module';
import type { RuntimeAdapterSendResult } from '@xln/core/api/runtime-adapter/types';
import { requireAdapter } from './adapter';

/** Standard 24h bilateral response window — matches the protocol's non-hub default. */
export const DEFAULT_ACCOUNT_DISPUTE_CONFIG = { leftResponseSeconds: 86_400, rightResponseSeconds: 86_400 };

export function buildEntityInput(entityId: string, signerId: string, entityTxs: EntityTx[]): RuntimeInput {
	return {
		runtimeTxs: [],
		entityInputs: [{ entityId, signerId, entityTxs }],
	};
}

export async function sendEntityTxs(
	entityId: string,
	signerId: string,
	entityTxs: EntityTx[],
): Promise<RuntimeAdapterSendResult> {
	return requireAdapter().send(buildEntityInput(entityId, signerId, entityTxs));
}

export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 30_000,
	pollMs = 60,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`);
		await new Promise(resolve => setTimeout(resolve, pollMs));
	}
}
