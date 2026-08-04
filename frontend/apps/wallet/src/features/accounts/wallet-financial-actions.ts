import type { RuntimeInput } from '@xln/runtime/api/public/runtime-module';

import { recordRuntimeIngressReceipt } from '$lib/stores/runtimeCommandBus';
import { runtimeControllerHandleExternalStore } from '$lib/stores/runtimeControllerStore';
import { submitRuntimeInput } from '$lib/stores/xlnStore';

const pendingCommands = new Set<string>();

export const runWalletIntentOnce = async <T>(
  intentKey: string,
  action: () => Promise<T>,
): Promise<T> => {
  const key = String(intentKey || '').trim();
  if (!key) throw new Error('WALLET_COMMAND_INTENT_KEY_MISSING');
  if (pendingCommands.has(key)) throw new Error(`WALLET_COMMAND_ALREADY_PENDING:${key}`);
  pendingCommands.add(key);
  try {
    return await action();
  } finally {
    pendingCommands.delete(key);
  }
};

export const submitWalletFinancialCommand = async (
  intentKey: string,
  input: RuntimeInput,
): Promise<void> => runWalletIntentOnce(intentKey, () => submitRuntimeInput(input).then(() => undefined));

export const submitWalletFinancialCommandSequence = async (
  intentKey: string,
  inputs: readonly RuntimeInput[],
): Promise<void> => runWalletIntentOnce(intentKey, async () => {
  if (inputs.length === 0) throw new Error('WALLET_COMMAND_SEQUENCE_EMPTY');
  for (const input of inputs) await submitRuntimeInput(input);
});

export const isWalletFinancialCommandPending = (intentKey: string): boolean =>
  pendingCommands.has(String(intentKey || '').trim());

export const requestWalletCredit = async (input: Readonly<{
  userEntityId: string;
  hubEntityId: string;
  tokenId: number;
  amountRaw: bigint;
}>): Promise<void> => {
  const key = ['wallet-credit-request', input.userEntityId, input.hubEntityId, input.tokenId, input.amountRaw].join(':');
  await runWalletIntentOnce(key, async () => {
    const response = await fetch('/api/credit/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userEntityId: input.userEntityId,
        hubEntityId: input.hubEntityId,
        tokenId: input.tokenId,
        amount: input.amountRaw.toString(),
      }),
    });
    const result = await response.json() as {
      success?: boolean;
      error?: string;
      runtimeId?: string | null;
      statusUrl?: string | null;
      receipt?: Parameters<typeof recordRuntimeIngressReceipt>[0]['receipt'];
    };
    if (!response.ok || result.success !== true) {
      throw new Error(result.error || `Credit request failed (${response.status})`);
    }
    if (result.receipt) {
      const handle = runtimeControllerHandleExternalStore.getSnapshot();
      recordRuntimeIngressReceipt({
        runtimeId: result.runtimeId || handle.runtimeId || handle.id,
        mode: 'remote',
        receipt: result.receipt,
        statusUrl: result.statusUrl ?? null,
      });
    }
  });
};
