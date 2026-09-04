import { normalizeEntityId } from '../../../entity/id';
import { compactHankoForChain } from '../../../hanko/short';
import { batchOpCount, isBatchEmpty } from '../../machine/batch';
import { assertSealedJBatchBinding } from '../../machine/batch/sealed-batch';
import { assertEntityProviderActionJTxBinding } from '../../../entity/entity-provider-action';
import type { JTx } from '../../../types/jurisdiction-runtime';
import type { BrowserVMProvider } from './browservm-provider';
import type { JAdapter, JAdapterAddresses, JBatchReceipt, JEvent, JSubmitResult } from '../types';
import { makeJAdapterFailureResult } from '../kernel/failure';
import { submitDebtEnforcement, submitMint } from '../rpc/write/rpc-submit-basic';
import { hashBoardProposalHankoPayload } from '../../../hanko/onchain-domain';

type BrowserVmSubmitContext = {
  chainId: number;
  addresses: JAdapterAddresses;
  browserVM: BrowserVMProvider;
};

type SubmitOptions = Parameters<JAdapter['submitTx']>[1];

export const receiptFromEvents = (events: JEvent[]): JBatchReceipt => {
  if (events.length === 0) {
    throw new Error('J_ADAPTER_RECEIPT_EVENTS_EMPTY');
  }
  const txHash = events[0]!.transactionHash;
  const blockNumber = events.reduce((maximum, event) => Math.max(maximum, event.blockNumber), 0);
  if (!txHash || txHash === '0x' || blockNumber < 1) {
    throw new Error(`J_ADAPTER_RECEIPT_COORDINATES_INVALID:${txHash}:${blockNumber}`);
  }
  return { txHash, blockNumber, events };
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
    // Consensus certifies full envelopes; the chain accepts the 65-byte form for
    // a lazy single-signer entity, so compact at the submission boundary only.
    const hankoData = compactHankoForChain(jTx.data.hankoSignature, jTx.data.intent.actionHash);
    const events = await context.browserVM.submitEntityProviderAction(jTx.data.intent, hankoData, {
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

const submitControlBoardProposal = async (
  context: BrowserVmSubmitContext,
  jTx: Extract<JTx, { type: 'entityProviderProposeControlBoard' }>,
): Promise<JSubmitResult> => {
  try {
    const expectedHash = hashBoardProposalHankoPayload(
      {
        chainId: context.chainId,
        entityProviderAddress: context.addresses.entityProvider,
        boardEpoch: jTx.data.boardEpoch,
      },
      {
        entityId: jTx.data.targetEntityId,
        newBoardHash: jTx.data.newBoardHash,
        authority: 1,
        actionNonce: jTx.data.actionNonce,
      },
    ).toLowerCase();
    if (expectedHash !== jTx.data.proposalHash.toLowerCase()) {
      throw new Error(`CONTROL_BOARD_PROPOSAL_HASH_MISMATCH:${jTx.data.proposalHash}:${expectedHash}`);
    }
    const hankos = jTx.data.supporterVotes.map((vote) => {
      if (!vote.hankoSignature) throw new Error(`CONTROL_BOARD_PROPOSAL_HANKO_MISSING:${vote.entityId}`);
      return vote.hankoSignature;
    });
    const events = await context.browserVM.submitControlBoardProposal(
      jTx.data.targetEntityId,
      jTx.data.newBoardHash,
      hankos,
    );
    const receipt = receiptFromEvents(events);
    return { success: true, txHash: receipt.txHash, blockNumber: receipt.blockNumber, events };
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
    const hankoData = compactHankoForChain(batchData.hankoSignature, batchData.batchHash);
    const events =
      externalBatch && options.signerPrivateKey
        ? await context.browserVM.processBatchAs(
            batchData.encodedBatch,
            hankoData,
            BigInt(batchData.entityNonce),
            options.signerPrivateKey,
          )
        : await context.browserVM.processBatch(
            batchData.encodedBatch,
            hankoData,
            BigInt(batchData.entityNonce),
          );
    const receipt = receiptFromEvents(events);
    console.log(`✅ [JAdapter:browservm] Batch executed (${batchOpCount(batch)} ops) block=${receipt.blockNumber}`);
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
    if (jTx.type === 'mint') {
      return submitMint(jTx, true, (entityId, tokenId, amount) =>
        context.browserVM.debugFundReserves(entityId, tokenId, amount),
      );
    }
    if (jTx.type === 'debtEnforcement') {
      return submitDebtEnforcement(jTx, (entityId, tokenId, maxIterations) =>
        context.browserVM.enforceDebts(entityId, tokenId, maxIterations),
      );
    }
    if (
      jTx.type === 'entityProviderTransfer' ||
      jTx.type === 'entityProviderReleaseControlShares' ||
      jTx.type === 'entityProviderCancelAction'
    ) {
      return submitEntityProviderAction(context, jTx);
    }
    if (jTx.type === 'entityProviderProposeControlBoard') {
      return submitControlBoardProposal(context, jTx);
    }
    if (jTx.type === 'entityProviderActivateBoard') {
      try {
        const events = await context.browserVM.activateBoard(jTx.data.targetEntityId);
        const receipt = receiptFromEvents(events);
        return { success: true, txHash: receipt.txHash, blockNumber: receipt.blockNumber, events };
      } catch (error) {
        return makeJAdapterFailureResult(error);
      }
    }
    if (jTx.type === 'batch') return submitBatch(context, jTx, options);
    const unhandled: never = jTx;
    return {
      success: false,
      error: `Unhandled JTx type: ${(unhandled as { type?: string }).type}`,
    };
  };
