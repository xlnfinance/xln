import type { Signer } from 'ethers';
import { ethers } from 'ethers';
import { normalizeEntityId } from '../../entity/id';
import { prepareSignedBatch } from '../../hanko/batch';
import { decodeJBatch, type JBatch } from '../machine/batch';
import { parseReceiptLogsToJEvents } from './j-event-log-decoder';
import { DEV_CHAIN_IDS } from './chain-ids';
import {
  PROCESS_BATCH_GAS_FLOOR,
  applyProcessBatchGasFloor,
} from './rpc-public';
import {
  eventCarriers,
  type RpcReceipt,
  type TxOverrides,
  type UntypedNonPayableMethod,
} from './rpc-boundary';
import type { RpcChainIo } from './rpc-chain-io';
import type { RpcContractStack } from './rpc-contract-stack';
import type { RpcTransactionSequencer } from './rpc-transaction-sequencer';
import type { JAdapter, JBatchReceipt, JEvent, JReserveMint, JAdapterConfig } from './types';
import { createRpcExternalDeposit } from './rpc-external-deposit';

export type RpcWriteMethods = Pick<
  JAdapter,
  'processBatch' | 'enforceDebts' | 'debugFundReserves' | 'debugFundReservesBatch' | 'externalTokenToReserve'
>;

export type RpcWriteContext = {
  config: JAdapterConfig;
  provider: ethers.JsonRpcProvider;
  signer: Signer;
  chainIo: RpcChainIo;
  stack: RpcContractStack;
  sequencer: RpcTransactionSequencer;
  mintDebugEnabled: boolean;
  isQuiet(): boolean;
};

const sendTypedTx = async (
  context: RpcWriteContext,
  label: string,
  method: unknown,
  args: unknown[],
  options: {
    minimumGasLimit?: bigint;
    txNonce: number | null;
    resetSignerNonce: boolean;
  },
): Promise<RpcReceipt> => {
  const txMethod = method as UntypedNonPayableMethod;
  const estimated = await context.chainIo.estimateGas(
    () => txMethod.estimateGas(...args),
  );
  const gasLimit = options.minimumGasLimit !== undefined && estimated < options.minimumGasLimit
    ? options.minimumGasLimit
    : estimated;
  if (options.resetSignerNonce) await context.sequencer.reset();
  const feeOverrides = await context.chainIo.buildFeeOverrides();
  const overrides: TxOverrides = options.txNonce === null
    ? { gasLimit, ...feeOverrides }
    : { gasLimit, nonce: options.txNonce, ...feeOverrides };
  return context.chainIo.waitForReceipt(await txMethod(...args, overrides), label);
};

const batchSignerPrivateKey = (context: RpcWriteContext): string => {
  if (context.config.privateKey) return context.config.privateKey;
  const key = (context.signer as ethers.Wallet | { privateKey?: string }).privateKey;
  if (typeof key === 'string' && key.startsWith('0x')) return key;
  throw new Error('[JAdapter:rpc] processBatch requires a signer private key for Hanko signing');
};

export const processRpcSignedBatch = async (
  context: RpcWriteContext,
  entityId: string,
  batch: JBatch,
  txSigner?: Signer,
  signingKey?: string,
): Promise<JBatchReceipt> => {
  const activeSigner = txSigner ?? context.signer;
  return context.sequencer.runFor(activeSigner, async () => {
    try {
      const currentNonce = await context.stack.depository.entityNonces(normalizeEntityId(entityId));
      const prepared = prepareSignedBatch(
        batch,
        entityId,
        signingKey ?? batchSignerPrivateKey(context),
        BigInt(context.config.chainId),
        await context.stack.depository.getAddress(),
        currentNonce,
      );
      const depository = txSigner
        ? context.stack.depository.connect(txSigner)
        : context.stack.depository;
      const estimatedGas = await context.chainIo.estimateGas(
        () => depository.processBatch.estimateGas(
          prepared.encodedBatch,
          prepared.hankoData,
          prepared.nextNonce,
        ),
      );
      const gasLimit = applyProcessBatchGasFloor(
        estimatedGas,
        batch.disputeFinalizations.length,
      );
      const tx = await depository.processBatch(
        prepared.encodedBatch,
        prepared.hankoData,
        prepared.nextNonce,
        {
          gasLimit,
          nonce: await context.sequencer.allocateFor(activeSigner),
          ...await context.chainIo.buildFeeOverrides(),
        },
      );
      const receipt = await context.chainIo.waitForReceipt(tx, 'processBatch');
      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        events: parseReceiptLogsToJEvents(
          receipt,
          eventCarriers(context.stack.depository, context.stack.entityProvider),
        ),
      };
    } catch (error) {
      await context.sequencer.resetFor(activeSigner);
      throw error;
    }
  });
};

const createCoreWriteMethods = (context: RpcWriteContext): Pick<RpcWriteMethods, 'processBatch' | 'enforceDebts'> => ({
  async processBatch(encodedBatch, hankoData, nonce) {
    return context.sequencer.run(async () => {
      try {
        const batch = decodeJBatch(encodedBatch);
        const receipt = await sendTypedTx(
          context,
          'processBatch',
          context.stack.depository.processBatch,
          [encodedBatch, hankoData, nonce],
          {
            ...(context.config.mode === 'tron' || batch.disputeFinalizations.length === 0
              ? {}
              : { minimumGasLimit: PROCESS_BATCH_GAS_FLOOR }),
            txNonce: await context.sequencer.allocate(),
            resetSignerNonce: true,
          },
        );
        return {
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          events: parseReceiptLogsToJEvents(
            receipt,
            eventCarriers(context.stack.depository, context.stack.entityProvider),
          ),
        };
      } catch (error) {
        await context.sequencer.reset();
        throw error;
      }
    });
  },
  async enforceDebts(entityId, tokenId, maxIterations = 100n) {
    await context.sequencer.run(async () => {
      try {
        await sendTypedTx(
          context,
          'enforceDebts',
          context.stack.depository.enforceDebts,
          [entityId, BigInt(tokenId), BigInt(maxIterations)],
          {
            txNonce: await context.sequencer.allocate(),
            resetSignerNonce: false,
          },
        );
      } catch (error) {
        await context.sequencer.reset();
        throw error;
      }
    });
  },
});

const createDebugWriteMethods = (
  context: RpcWriteContext,
): Pick<RpcWriteMethods, 'debugFundReserves' | 'debugFundReservesBatch'> => {
  const mint = async (entry: JReserveMint): Promise<JEvent[]> => {
    const receipt = await sendTypedTx(
      context,
      'mintToReserve',
      context.stack.depository.mintToReserve,
      [entry.entityId, BigInt(entry.tokenId), entry.amount],
      {
        txNonce: await context.sequencer.allocate(),
        resetSignerNonce: false,
      },
    );
    return parseReceiptLogsToJEvents(receipt, eventCarriers(context.stack.depository));
  };
  return {
    async debugFundReserves(entityId, tokenId, amount) {
      if (!DEV_CHAIN_IDS.has(context.config.chainId)) {
        throw new Error('debugFundReserves only available on configured dev chains - use real token deposits');
      }
      return context.sequencer.run(async () => {
        try {
          return await mint({ entityId, tokenId, amount });
        } catch (error) {
          await context.sequencer.reset();
          throw error;
        }
      });
    },
    async debugFundReservesBatch(mints) {
      if (!DEV_CHAIN_IDS.has(context.config.chainId)) {
        throw new Error('debugFundReservesBatch only available on configured dev chains');
      }
      if (mints.length === 0) return [];
      if (context.mintDebugEnabled && !context.isQuiet()) {
        const first = mints[0]!;
        console.log(
          `[JAdapter:rpc] mintToReserve loop start chainId=${context.config.chainId} count=${mints.length} ` +
            `first=${JSON.stringify({ ...first, amount: first.amount.toString() })}`,
        );
      }
      return context.sequencer.run(async () => {
        try {
          const events: JEvent[] = [];
          for (const entry of mints) events.push(...await mint(entry));
          return events;
        } catch (error) {
          await context.sequencer.reset();
          throw error;
        }
      });
    },
  };
};

export const createRpcWriteMethods = (context: RpcWriteContext): RpcWriteMethods => ({
  ...createCoreWriteMethods(context),
  ...createDebugWriteMethods(context),
  ...createRpcExternalDeposit(
    context,
    (entityId, batch, signer, signingKey) =>
      processRpcSignedBatch(context, entityId, batch, signer, signingKey),
  ),
});
