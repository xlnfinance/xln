import type { EntityTx, RuntimeInput, SwapCommandPlan } from '@xln/runtime/api/public/runtime-module';

import { submitActiveCrossJurisdictionIntent, submitRuntimeInput } from '$lib/stores/xlnStore';
import { runWalletIntentOnce, submitWalletFinancialCommand } from '../accounts/wallet-financial-actions';

export const submitWalletSwapPlan = async (
  requestIdentity: string,
  plan: SwapCommandPlan,
): Promise<string> => runWalletIntentOnce(`wallet-swap:${requestIdentity}:${plan.offerId}`, async () => {
  if (plan.mode === 'same') {
    await submitRuntimeInput(plan.runtimeInput);
    return plan.offerId;
  }
  if (plan.targetSetupInput) await submitRuntimeInput(plan.targetSetupInput);
  await submitActiveCrossJurisdictionIntent(plan.crossJurisdictionIntent, {
    waitForTargetReady: plan.targetSetupInput !== null,
  });
  return plan.offerId;
});

const entityCommand = (
  entityId: string,
  signerId: string,
  entityTx: EntityTx,
): RuntimeInput => {
  const entity = entityId.trim().toLowerCase();
  const signer = signerId.trim().toLowerCase();
  if (!entity || !signer) throw new Error('WALLET_SWAP_COMMAND_PARTY_MISSING');
  return { runtimeTxs: [], entityInputs: [{ entityId: entity, signerId: signer, entityTxs: [entityTx] }] };
};

export const requestWalletSwapCancel = async (input: Readonly<{
  entityId: string;
  signerId: string;
  accountId: string;
  offerId: string;
}>): Promise<void> => {
  const accountId = input.accountId.trim().toLowerCase();
  const offerId = input.offerId.trim();
  if (!accountId || !offerId) throw new Error('WALLET_SWAP_CANCEL_IDENTITY_MISSING');
  await submitWalletFinancialCommand(
    `wallet-swap-cancel:${input.entityId}:${accountId}:${offerId}`,
    entityCommand(input.entityId, input.signerId, {
      type: 'proposeCancelSwap',
      data: { counterpartyEntityId: accountId, offerId },
    }),
  );
};

export const requestWalletCrossSwapClear = async (input: Readonly<{
  entityId: string;
  signerId: string;
  orderId: string;
  cancelRemainder: boolean;
}>): Promise<void> => {
  const orderId = input.orderId.trim();
  if (!orderId) throw new Error('WALLET_CROSS_SWAP_ORDER_ID_MISSING');
  await submitWalletFinancialCommand(
    `wallet-cross-swap-clear:${input.entityId}:${orderId}:${input.cancelRemainder}`,
    entityCommand(input.entityId, input.signerId, {
      type: 'requestCrossJurisdictionClear',
      data: { orderId, cancelRemainder: input.cancelRemainder },
    }),
  );
};
