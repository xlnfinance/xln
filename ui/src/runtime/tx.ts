import { sendRuntimeInput } from './commands';
import type { EntityTx, RuntimeInput } from '@xln/core/api/public/runtime-module';
import type { RuntimeAdapterSendResult } from '@xln/core/api/runtime-adapter/types';
import { getEmbeddedEnv } from './adapter';

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
	return sendRuntimeInput(buildEntityInput(entityId, signerId, entityTxs));
}

export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 30_000,
	pollMs = 60,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
    const state = getEmbeddedEnv()?.infrastructure;
    if (state?.halted) {
      const cause = state.fatalDebugPayload?.message ?? 'HALTED_REQUIRES_OPERATOR';
      throw new Error(/DUPLICATE_RUNTIME_CONNECTION|DIRECT_DUPLICATE_RUNTIME_SESSION/.test(cause)
        ? 'This wallet is already open elsewhere. Close the other wallet before reopening here.'
        : `Wallet stopped. Reopen it before continuing. (${cause})`);
    }
		if (await predicate()) return;
		if (Date.now() > deadline) throw new Error(`TIMEOUT: ${label}`);
		await new Promise(resolve => setTimeout(resolve, pollMs));
	}
}
