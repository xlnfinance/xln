import { ethers, type Signer } from 'ethers';
import type { Depository, EntityProvider } from '../../../../../jurisdictions/typechain-types/index.ts';
import {
  assertEntityProviderActionJTxBinding,
  assertEntityProviderActionResolutionReceipt,
} from '../../../../entity/entity-provider-action';
import { normalizeEntityId } from '../../../../entity/id';
import type { JTx } from '../../../../types/jurisdiction-runtime';
import { classifyJAdapterFailure, makeJAdapterFailureResult } from '../../core/failure';
import { parseReceiptLogsToJEvents } from '../../j-event-log-decoder';
import { eventCarriers, type FeeOverrides, type RpcReceipt } from '../rpc-boundary';
import type { JEvent, JSubmitResult } from '../../types';
import { hashBoardProposalHankoPayload } from '../../../../hanko/onchain-domain';

type EntityProviderJTx = Extract<
  JTx,
  {
    type: 'entityProviderTransfer' | 'entityProviderReleaseControlShares' | 'entityProviderCancelAction';
  }
>;
type ControlBoardProposalJTx = Extract<JTx, { type: 'entityProviderProposeControlBoard' }>;
type ActivateBoardJTx = Extract<JTx, { type: 'entityProviderActivateBoard' }>;

export type RpcEntityProviderSubmitContext = {
  chainId: number;
  watchOnly: boolean;
  signer: Signer;
  entityProvider: EntityProvider;
  depository: Depository;
  getDepositoryAddress(): Promise<string>;
  getEntityProviderAddress(): Promise<string>;
  signerForPrivateKey(privateKey: string): Promise<Signer>;
  readActionReceipt(entityId: string, actionNonce: bigint): Promise<JEvent | null>;
  runSerialized<T>(work: () => Promise<T>): Promise<T>;
  estimateGas(estimate: () => Promise<bigint>): Promise<bigint>;
  send(
    signer: Signer,
    label: string,
    submit: (nonce: number, feeOverrides: FeeOverrides) => Promise<unknown>,
  ): Promise<RpcReceipt>;
};

type EntityProviderActionCall = {
  staticCall(): Promise<unknown>;
  estimateGas(): Promise<bigint>;
  send(nonce: number, feeOverrides: FeeOverrides, gasLimit: bigint): Promise<unknown>;
};

const createActionCall = (
  contract: EntityProvider,
  jTx: EntityProviderJTx,
  hankoSignature: string,
): EntityProviderActionCall => {
  const { intent } = jTx.data;
  if (intent.payload.kind === 'entityTransferTokens') {
    const args = [
      intent.entityNumber,
      intent.payload.transfer.to,
      intent.payload.transfer.tokenId,
      intent.payload.transfer.amount,
      hankoSignature,
    ] as const;
    return {
      staticCall: () => contract.entityTransferTokens.staticCall(...args),
      estimateGas: () => contract.entityTransferTokens.estimateGas(...args),
      send: (nonce, feeOverrides, gasLimit) =>
        contract.entityTransferTokens(...args, {
          gasLimit,
          nonce,
          ...feeOverrides,
        }),
    };
  }
  if (intent.payload.kind === 'releaseControlShares') {
    const args = [
      intent.entityNumber,
      intent.payload.release.recipientAddress,
      intent.payload.release.controlAmount,
      intent.payload.release.dividendAmount,
      intent.payload.release.purpose,
      hankoSignature,
    ] as const;
    return {
      staticCall: () => contract.releaseControlShares.staticCall(...args),
      estimateGas: () => contract.releaseControlShares.estimateGas(...args),
      send: (nonce, feeOverrides, gasLimit) =>
        contract.releaseControlShares(...args, {
          gasLimit,
          nonce,
          ...feeOverrides,
        }),
    };
  }
  const args = [
    intent.entityNumber,
    intent.payload.cancel.cancelledActionHash,
    intent.payload.cancel.cancelledActionKind,
    hankoSignature,
  ] as const;
  return {
    staticCall: () => contract.cancelEntityProviderAction.staticCall(...args),
    estimateGas: () => contract.cancelEntityProviderAction.estimateGas(...args),
    send: (nonce, feeOverrides, gasLimit) =>
      contract.cancelEntityProviderAction(...args, {
        gasLimit,
        nonce,
        ...feeOverrides,
      }),
  };
};

export const submitEntityProviderAction = async (
  context: RpcEntityProviderSubmitContext,
  jTx: EntityProviderJTx,
  signerPrivateKey: Uint8Array | undefined,
): Promise<JSubmitResult> => {
  const { intent } = jTx.data;
  const hankoSignature = jTx.data.hankoSignature;
  if (!hankoSignature) {
    return {
      success: false,
      error: `ENTITY_PROVIDER_ACTION_CONSENSUS_HANKO_MISSING:` + normalizeEntityId(jTx.entityId),
    };
  }
  try {
    if (context.watchOnly && !signerPrivateKey) {
      throw new Error('JADAPTER_WATCH_ONLY_SIGNER_REQUIRED:entityProviderAction');
    }
    const signer =
      context.watchOnly && signerPrivateKey
        ? await context.signerForPrivateKey(ethers.hexlify(signerPrivateKey))
        : context.signer;
    const contract = context.entityProvider.connect(signer);
    assertEntityProviderActionJTxBinding(jTx, {
      chainId: context.chainId,
      entityProviderAddress: await context.getEntityProviderAddress(),
      depositoryAddress: await context.getDepositoryAddress(),
    });
    return context.runSerialized(async () => {
      const chainNonce = await context.entityProvider.entityActionNonces(intent.entityId);
      if (chainNonce >= intent.actionNonce) {
        const receipt = await context.readActionReceipt(intent.entityId, intent.actionNonce);
        if (!receipt) {
          throw new Error(
            `ENTITY_PROVIDER_ACTION_NONCE_CONSUMED_WITHOUT_RECEIPT:` +
              `${intent.entityId}:${intent.actionNonce}:${chainNonce}`,
          );
        }
        assertEntityProviderActionResolutionReceipt(intent, receipt);
        return {
          success: true,
          txHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          events: [receipt],
        };
      }
      if (chainNonce + 1n !== intent.actionNonce) {
        throw new Error(`ENTITY_PROVIDER_ACTION_CHAIN_NONCE_MISMATCH:` + `${intent.actionNonce}:${chainNonce + 1n}`);
      }

      const action = createActionCall(contract, jTx, hankoSignature);
      try {
        await action.staticCall();
      } catch (error) {
        const failure = classifyJAdapterFailure(error);
        return makeJAdapterFailureResult(error, {
          category: failure.category === 'transient' ? 'transient' : 'terminal',
          code: failure.code,
          message: `EntityProvider action staticCall failed: ${failure.message}`,
        });
      }
      const gasLimit = await context.estimateGas(action.estimateGas);
      const receipt = await context.send(signer, `EntityProvider.${intent.payload.kind}`, (nonce, feeOverrides) =>
        action.send(nonce, feeOverrides, gasLimit),
      );
      const events = parseReceiptLogsToJEvents(receipt, eventCarriers(context.depository, context.entityProvider));
      const exact = events.filter(
        event => event.name === 'EntityProviderActionExecuted' || event.name === 'EntityProviderActionCancelled',
      );
      if (exact.length !== 1) {
        throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_COUNT_INVALID:${exact.length}`);
      }
      assertEntityProviderActionResolutionReceipt(intent, exact[0]!);
      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        events,
      };
    });
  } catch (error) {
    return makeJAdapterFailureResult(error);
  }
};

export const submitControlBoardProposal = async (
  context: RpcEntityProviderSubmitContext,
  jTx: ControlBoardProposalJTx,
  signerPrivateKey: Uint8Array | undefined,
): Promise<JSubmitResult> => {
  try {
    if (context.watchOnly && !signerPrivateKey) {
      throw new Error('JADAPTER_WATCH_ONLY_SIGNER_REQUIRED:controlBoardProposal');
    }
    const expectedHash = hashBoardProposalHankoPayload(
      {
        chainId: context.chainId,
        entityProviderAddress: await context.getEntityProviderAddress(),
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
    const signer = context.watchOnly && signerPrivateKey
      ? await context.signerForPrivateKey(ethers.hexlify(signerPrivateKey))
      : context.signer;
    const contract = context.entityProvider.connect(signer);
    return context.runSerialized(async () => {
      const chainNonce = await context.entityProvider.boardActionNonces(jTx.data.targetEntityId);
      if (chainNonce >= jTx.data.actionNonce) {
        const entity = await context.entityProvider.entities(jTx.data.targetEntityId);
        const proposed = String(entity.proposedBoardHash).toLowerCase();
        const current = String(entity.currentBoardHash).toLowerCase();
        if (chainNonce === jTx.data.actionNonce &&
            (proposed === jTx.data.newBoardHash.toLowerCase() || current === jTx.data.newBoardHash.toLowerCase())) {
          return { success: true };
        }
        throw new Error(`CONTROL_BOARD_PROPOSAL_CHAIN_NONCE_CONSUMED:${jTx.data.actionNonce}:${chainNonce}`);
      }
      if (chainNonce + 1n !== jTx.data.actionNonce) {
        throw new Error(`CONTROL_BOARD_PROPOSAL_CHAIN_NONCE_MISMATCH:${jTx.data.actionNonce}:${chainNonce + 1n}`);
      }
      const args = [jTx.data.targetEntityId, jTx.data.newBoardHash, 1, hankos] as const;
      try {
        await contract.proposeBoard.staticCall(...args);
      } catch (error) {
        const failure = classifyJAdapterFailure(error);
        return makeJAdapterFailureResult(error, {
          category: failure.category === 'transient' ? 'transient' : 'terminal',
          code: failure.code,
          message: `CONTROL board proposal staticCall failed: ${failure.message}`,
        });
      }
      const gasLimit = await context.estimateGas(() => contract.proposeBoard.estimateGas(...args));
      const receipt = await context.send(signer, 'EntityProvider.proposeBoard.CONTROL',
        (nonce, feeOverrides) => contract.proposeBoard(...args, { gasLimit, nonce, ...feeOverrides }));
      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        events: parseReceiptLogsToJEvents(receipt, eventCarriers(context.depository, context.entityProvider)),
      };
    });
  } catch (error) {
    return makeJAdapterFailureResult(error);
  }
};

export const submitBoardActivation = async (
  context: RpcEntityProviderSubmitContext,
  jTx: ActivateBoardJTx,
  signerPrivateKey: Uint8Array | undefined,
): Promise<JSubmitResult> => {
  try {
    if (context.watchOnly && !signerPrivateKey) {
      throw new Error('JADAPTER_WATCH_ONLY_SIGNER_REQUIRED:activateBoard');
    }
    const signer = context.watchOnly && signerPrivateKey
      ? await context.signerForPrivateKey(ethers.hexlify(signerPrivateKey))
      : context.signer;
    const contract = context.entityProvider.connect(signer);
    return context.runSerialized(async () => {
      const entity = await context.entityProvider.entities(jTx.data.targetEntityId);
      if (String(entity.proposedBoardHash).toLowerCase() === ethers.ZeroHash) return { success: true };
      try {
        await contract.activateBoard.staticCall(jTx.data.targetEntityId);
      } catch (error) {
        const failure = classifyJAdapterFailure(error);
        return makeJAdapterFailureResult(error, {
          category: failure.category,
          code: failure.code,
          message: `board activation staticCall failed: ${failure.message}`,
        });
      }
      const gasLimit = await context.estimateGas(() =>
        contract.activateBoard.estimateGas(jTx.data.targetEntityId));
      const receipt = await context.send(signer, 'EntityProvider.activateBoard',
        (nonce, feeOverrides) => contract.activateBoard(jTx.data.targetEntityId, {
          gasLimit,
          nonce,
          ...feeOverrides,
        }));
      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        events: parseReceiptLogsToJEvents(
          receipt,
          eventCarriers(context.depository, context.entityProvider),
        ),
      };
    });
  } catch (error) {
    return makeJAdapterFailureResult(error);
  }
};
