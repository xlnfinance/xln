import { normalizeEntityId } from '../entity/id';
import { getBatchSize, isBatchEmpty } from '../jurisdiction/batch';
import { assertSealedJBatchBinding } from '../jurisdiction/sealed-batch';
import { assertEntityProviderActionJTxBinding } from '../entity/entity-provider-action';
import type { JTx } from '../types';
import type { BrowserVMProvider } from './browservm-provider';
import type {
  JAdapter,
  JAdapterAddresses,
  JBatchReceipt,
  JEvent,
  JSubmitResult,
} from './types';
import { makeJAdapterFailureResult } from './failure';

type BrowserVmSubmitContext = {
  chainId: number;
  addresses: JAdapterAddresses;
  browserVM: BrowserVMProvider;
};

type SubmitOptions = Parameters<JAdapter['submitTx']>[1];

export const receiptFromEvents = (events: JEvent[]): JBatchReceipt => ({
  txHash: events.find(event => event.transactionHash && event.transactionHash !== '0x')?.transactionHash ?? '0x',
  blockNumber: events.reduce((maximum, event) => Math.max(maximum, Number(event.blockNumber || 0)), 0),
  events,
});

const submitMint = async (
  context: BrowserVmSubmitContext,
  jTx: Extract<JTx, { type: 'mint' }>,
): Promise<JSubmitResult> => {
  const entityId = String(jTx.data.entityId || jTx.entityId || '');
  const tokenId = Number(jTx.data.tokenId);
  const amount = jTx.data.amount;
  if (!entityId || !Number.isFinite(tokenId) || amount <= 0n) {
    return { success: false, error: 'Invalid mint payload' };
  }
  const events = await context.browserVM.debugFundReserves(entityId, tokenId, amount);
  return { success: true, events, blockNumber: receiptFromEvents(events).blockNumber };
};

const submitDebtEnforcement = async (
  context: BrowserVmSubmitContext,
  jTx: Extract<JTx, { type: 'debtEnforcement' }>,
): Promise<JSubmitResult> => {
  const entityId = String(jTx.entityId || '').toLowerCase();
  const tokenId = Number(jTx.data.tokenId);
  const maxIterations = BigInt(jTx.data.maxIterations);
  if (!entityId || !Number.isInteger(tokenId) || tokenId < 0 || maxIterations <= 0n) {
    return { success: false, error: 'Invalid debt enforcement payload' };
  }
  await context.browserVM.enforceDebts(entityId, tokenId, maxIterations);
  return { success: true };
};

type EntityProviderJTx = Extract<
  JTx,
  {
    type: 'entityProviderTransfer' | 'entityProviderReleaseControlShares' | 'entityProviderCancelAction';
  }
>;

const submitEntityProviderAction = async (
  context: BrowserVmSubmitContext,
  jTx: EntityProviderJTx,
): Promise<JSubmitResult> => {
  if (!jTx.data.hankoSignature) {
    return {
      success: false,
      error: `ENTITY_PROVIDER_ACTION_CONSENSUS_HANKO_MISSING:${normalizeEntityId(jTx.entityId)}`,
    };
  }
  try {
    assertEntityProviderActionJTxBinding(jTx, {
      chainId: context.chainId,
      entityProviderAddress: context.addresses.entityProvider,
      depositoryAddress: context.addresses.depository,
    });
    const events =
      await context.browserVM.submitEntityProviderAction(jTx.data.intent, jTx.data.hankoSignature, {
        entityId: normalizeEntityId(jTx.entityId),
        kind:
          jTx.type === 'entityProviderTransfer'
            ? 'entityTransferTokens'
            : jTx.type === 'entityProviderReleaseControlShares'
              ? 'releaseControlShares'
              : 'cancelPendingAction',
      });
    const receipt = receiptFromEvents(events);
    return {
      success: true,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      events,
    };
  } catch (error) {
    return makeJAdapterFailureResult(error);
  }
};

const submitBatch = async (
  context: BrowserVmSubmitContext,
  jTx: Extract<JTx, { type: 'batch' }>,
  options: SubmitOptions,
): Promise<JSubmitResult> => {
  try {
    assertSealedJBatchBinding(jTx, {
      chainId: context.chainId,
      depositoryAddress: context.addresses.depository,
    });
  } catch (error) {
    return makeJAdapterFailureResult(error);
  }
  const batchData = jTx.data;
  const batch = batchData.batch;
  if (isBatchEmpty(batch)) return { success: true };
  try {
    const externalBatch = batch.externalTokenToReserve.length > 0;
    const events =
      externalBatch && options.signerPrivateKey
        ? await context.browserVM.processBatchAs(
            batchData.encodedBatch!,
            batchData.hankoSignature!,
            BigInt(batchData.entityNonce!),
            options.signerPrivateKey,
          )
        : await context.browserVM.processBatch(
            batchData.encodedBatch!,
            batchData.hankoSignature!,
            BigInt(batchData.entityNonce!),
          );
    const receipt = receiptFromEvents(events);
    console.log(`✅ [JAdapter:browservm] Batch executed (${getBatchSize(batch)} ops) block=${receipt.blockNumber}`);
    return {
      success: true,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      events,
    };
  } catch (error) {
    return makeJAdapterFailureResult(error);
  }
};

export const createBrowserVmSubmitTx =
  (context: BrowserVmSubmitContext): JAdapter['submitTx'] =>
  async (jTx, options) => {
    if (typeof options.timestamp === 'number') {
      context.browserVM.setBlockTimestamp(options.timestamp);
    }
    if (jTx.type === 'mint') return submitMint(context, jTx);
    if (jTx.type === 'debtEnforcement') {
      return submitDebtEnforcement(context, jTx);
    }
    if (
      jTx.type === 'entityProviderTransfer' ||
      jTx.type === 'entityProviderReleaseControlShares' ||
      jTx.type === 'entityProviderCancelAction'
    ) {
      return submitEntityProviderAction(context, jTx);
    }
    if (jTx.type === 'batch') return submitBatch(context, jTx, options);
    const unhandled: never = jTx;
    return {
      success: false,
      error: `Unhandled JTx type: ${(unhandled as { type?: string }).type}`,
    };
  };
