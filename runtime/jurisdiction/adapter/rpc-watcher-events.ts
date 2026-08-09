import { ethers } from 'ethers';
import {
  Depository__factory,
  EntityProvider__factory,
} from '../../../jurisdictions/typechain-types';
import type { AuthenticatedRpcLog } from '../machine/receipt-codec';
import { CANONICAL_J_EVENTS } from '../machine/event-catalog';
import {
  buildCertifiedRegistrationEvidence,
  markLocalJAuthorityRuntimeTx,
} from '../machine/registration-evidence';
import type { DisputeFinalizationEvidence } from '../../types/jurisdiction-events';
import type { JReplica } from '../../types/jurisdiction-runtime';
import type { RuntimeReplica, RuntimeTx } from '../../runtime/types';
import { decodeJEventLog } from './j-event-log-decoder';
import {
  shouldEmitExternalWalletAllowanceDelta,
  shouldEmitExternalWalletBalanceDelta,
  type ExternalWalletTrackedOwnerCursor,
  type PreparedAuthenticatedWatcherLog,
} from './rpc-public';
import {
  normalizeEvmAddress,
  type AuthenticatedTxLocation,
  type WatchedErc20Token,
} from './rpc-watcher-inputs';
import type { JEvent } from './types';
import type { TxDisputeProofBodyEvidence } from './rpc-public';

type WatcherLogKind = 'depository' | 'entityProvider' | 'erc20';

type WatcherEventDecodeInput = {
  env: RuntimeReplica;
  watcherReplica: JReplica;
  logs: readonly PreparedAuthenticatedWatcherLog[];
  depositoryAddress: string;
  entityProviderAddress: string;
  tokenByAddress: ReadonlyMap<string, WatchedErc20Token>;
  trackedOwners: ReadonlyMap<string, ExternalWalletTrackedOwnerCursor[]>;
  observedThroughHeight: number;
  observedTipBlockHash: string;
  observedHeadHeight: number;
  confirmationDepth: number;
  findDisputeFinalizationEvidence(
    txHash: string,
    args: Record<string, unknown>,
    location: AuthenticatedTxLocation,
  ): Promise<DisputeFinalizationEvidence | undefined>;
  findDisputeProofBody(
    txHash: string,
    eventName: TxDisputeProofBodyEvidence['eventName'],
    args: Record<string, unknown>,
    location: AuthenticatedTxLocation,
  ): Promise<TxDisputeProofBodyEvidence['proofbody']>;
};

export type WatcherEventDecodeResult = {
  events: JEvent[];
  authorityTxsByBlock: Map<number, RuntimeTx[]>;
};

const entityProviderInterface = EntityProvider__factory.createInterface();
const depositoryInterface = Depository__factory.createInterface();

const erc20Interface = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);
const TRACKED_ERC20_EVENT_TOPICS = new Set([
  ethers.id('Transfer(address,address,uint256)').toLowerCase(),
  ethers.id('Approval(address,address,uint256)').toLowerCase(),
]);

const requireErc20Amount = (value: unknown, eventName: string): bigint => {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new Error(`J_WATCHER_ERC20_AMOUNT_INVALID:event=${eventName}:value=${String(value)}`);
  }
  return value;
};

const classifyWatcherLog = (
  log: AuthenticatedRpcLog,
  input: Pick<WatcherEventDecodeInput, 'depositoryAddress' | 'entityProviderAddress'>,
): WatcherLogKind => {
  const address = log.address.toLowerCase();
  if (address === input.depositoryAddress) return 'depository';
  if (address === input.entityProviderAddress) return 'entityProvider';
  return 'erc20';
};

const appendAuthorityTx = (
  byBlock: Map<number, RuntimeTx[]>,
  blockNumber: number,
  tx: RuntimeTx,
): void => {
  byBlock.set(blockNumber, [...(byBlock.get(blockNumber) ?? []), tx]);
};

const decodeExternalWalletEvents = (
  log: AuthenticatedRpcLog,
  parsed: ethers.LogDescription,
  token: WatchedErc20Token,
  trackedOwners: ReadonlyMap<string, ExternalWalletTrackedOwnerCursor[]>,
): JEvent[] => {
  const tokenAddress = normalizeEvmAddress(log.address);
  if (!tokenAddress) return [];
  if (parsed.name === 'Transfer') {
    const from = normalizeEvmAddress(parsed.args[0]);
    const to = normalizeEvmAddress(parsed.args[1]);
    if (from && to && from === to) return [];
    const amount = requireErc20Amount(parsed.args[2], parsed.name);
    const deltas = [
      ...(from && from !== ethers.ZeroAddress
        ? [{ owner: from, balanceDelta: `-${amount.toString()}` }]
        : []),
      ...(to && to !== ethers.ZeroAddress
        ? [{ owner: to, balanceDelta: amount.toString() }]
        : []),
    ];
    return deltas.flatMap(delta =>
      (trackedOwners.get(delta.owner) ?? []).flatMap(tracked =>
        shouldEmitExternalWalletBalanceDelta(tracked, tokenAddress, log.blockNumber)
          ? [{
              name: 'ExternalWalletDelta' as const,
              args: {
                entityId: tracked.entityId,
                owner: delta.owner,
                tokenAddress,
                tokenId: token.tokenId,
                balanceDelta: delta.balanceDelta,
              },
              blockNumber: log.blockNumber,
              blockHash: log.blockHash,
              transactionHash: log.transactionHash,
              logIndex: log.index,
            }]
          : [],
      ),
    );
  }
  if (parsed.name !== 'Approval') return [];
  const owner = normalizeEvmAddress(parsed.args[0]);
  const spender = normalizeEvmAddress(parsed.args[1]);
  if (!owner || !spender) return [];
  const allowance = requireErc20Amount(parsed.args[2], parsed.name).toString();
  return (trackedOwners.get(owner) ?? []).flatMap(tracked =>
    shouldEmitExternalWalletAllowanceDelta(
      tracked,
      tokenAddress,
      spender,
      log.blockNumber,
    )
      ? [{
          name: 'ExternalWalletDelta' as const,
          args: {
            entityId: tracked.entityId,
            owner,
            tokenAddress,
            tokenId: token.tokenId,
            spender,
            allowance,
          },
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          logIndex: log.index,
        }]
      : [],
  );
};

const decodeCanonicalContractEvent = async (
  log: PreparedAuthenticatedWatcherLog,
  carrierInterface: ethers.Interface,
  findEvidence: WatcherEventDecodeInput['findDisputeFinalizationEvidence'],
  findProofBody: WatcherEventDecodeInput['findDisputeProofBody'],
): Promise<JEvent | null> => {
  const event = decodeJEventLog(
    log,
    carrierInterface,
    {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    },
    'J_WATCHER_CANONICAL_EVENT_DECODE_FAILED',
  );
  if (!CANONICAL_J_EVENTS.some(name => name === event.name)) return null;
  if (
    event.name === 'DisputeStarted' ||
    event.name === 'CounterDisputeRegistered' ||
    event.name === 'DisputeFinalized'
  ) {
    const location = {
      blockHash: log.authenticatedBlockHash,
      blockNumber: log.blockNumber,
    };
    const proofbody = await findProofBody(log.transactionHash, event.name, event.args, location);
    event.args[
      event.name === 'DisputeStarted'
        ? 'initialProofbody'
        : event.name === 'CounterDisputeRegistered'
          ? 'counterProofbody'
          : 'finalProofbody'
    ] = proofbody;
  }
  const disputeFinalizationEvidence =
    event.name === 'DisputeFinalized'
      ? await findEvidence(log.transactionHash, event.args, {
          blockHash: log.authenticatedBlockHash,
          blockNumber: log.blockNumber,
        })
      : undefined;
  if (disputeFinalizationEvidence) {
    event.args['initialProofbodyHash'] = disputeFinalizationEvidence.initialProofbodyHash;
  }
  return {
    ...event,
    ...(disputeFinalizationEvidence ? { disputeFinalizationEvidence } : {}),
  };
};

const decodeWatcherLog = async (
  input: WatcherEventDecodeInput,
  log: PreparedAuthenticatedWatcherLog,
  result: WatcherEventDecodeResult,
): Promise<void> => {
  const kind = classifyWatcherLog(log, input);
  if (kind === 'erc20') {
    // Token contracts may emit arbitrary custom events. Receipt authentication
    // proves the log is canonical, not that every log at a watched address is
    // part of the wallet projection. Skip unknown signatures; keep malformed
    // Transfer/Approval payloads fail-loud because those mutate wallet state.
    const topic0 = String(log.topics[0] ?? '').toLowerCase();
    if (!TRACKED_ERC20_EVENT_TOPICS.has(topic0)) return;
    const parsed = erc20Interface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!parsed) {
      throw new Error(
        `unrecognized erc20 log at block=${log.blockNumber} index=${log.index}`,
      );
    }
    const token = input.tokenByAddress.get(normalizeEvmAddress(log.address));
    if (token) {
      result.events.push(
        ...decodeExternalWalletEvents(log, parsed, token, input.trackedOwners),
      );
    }
    return;
  }

  const event = await decodeCanonicalContractEvent(
    log,
    kind === 'depository' ? depositoryInterface : entityProviderInterface,
    input.findDisputeFinalizationEvidence,
    input.findDisputeProofBody,
  );
  if (!event) return;
  if (
    kind === 'entityProvider' &&
    (event.name === 'EntityRegistered' || event.name === 'FoundationBootstrapped')
  ) {
    const evidence = buildCertifiedRegistrationEvidence(
      input.env,
      input.watcherReplica,
      event.name,
      log,
      {
        observedThroughHeight: input.observedThroughHeight,
        observedTipBlockHash: input.observedTipBlockHash,
        observedHeadHeight: input.observedHeadHeight,
        confirmationDepth: input.confirmationDepth,
      },
    );
    appendAuthorityTx(
      result.authorityTxsByBlock,
      log.blockNumber,
      markLocalJAuthorityRuntimeTx({
        type: 'recordAuthenticatedJAuthority',
        data: evidence,
      }),
    );
  }
  result.events.push(event);
};

export const decodeAuthenticatedWatcherEvents = async (
  input: WatcherEventDecodeInput,
): Promise<WatcherEventDecodeResult> => {
  const result: WatcherEventDecodeResult = {
    events: [],
    authorityTxsByBlock: new Map(),
  };
  for (const log of input.logs) {
    try {
      await decodeWatcherLog(input, log, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `J_EVENT_LOG_DECODE_FAILED:block=${log.blockNumber} ` +
          `tx=${log.transactionHash || 'unknown'} index=${log.index}: ${message}`,
      );
    }
  }
  return result;
};
