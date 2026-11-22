import { keccak256, Transaction, type JsonRpcProvider } from 'ethers';
import { evmAttemptSlot } from '../../../../../core/storage/queries/evm-attempts';
import { networks } from '../../identities';
import { preflightProvider, RpcEnvironmentError, runtimeRpc } from '../../provider';
import { ExecutionCallNotAuthorized, validateAuthorizedWire } from '../calls';
import { receiptSlots, verifyAuthorizedReceipt } from '../receipt-event';
import { findMinedNonceReceipt } from '../nonce-receipt';
import type { ChainAuthority, ExecutionAuthority, PayerGrant } from '../authority';
import { ObservationUnavailable } from '../boundary';
import { bounded, rpcIssue } from './rpc-observation';

type Slot = ReturnType<typeof receiptSlots>[number];
type Step = Slot[0];
type Entry = ReturnType<typeof verifyAuthorizedReceipt>;
type SlotIdentity = {
  step: Step;
  chainId: number;
  payer: string;
  nonce: number;
  knownHashes: readonly string[];
};
export type SlotObservation = SlotIdentity &
  (
    | ({
        consumed: true;
        hash: string;
        block: { number: number; hash: string };
        via: 'hash' | 'nonce';
        reason: string | null;
      } & (
        | { status: 'confirmed' | 'reverted'; entry: Entry }
        | { status: 'conflict'; via: 'nonce'; reason: string; entry: null }
      ))
    | {
        status: 'pending' | 'unobserved' | 'unavailable';
        consumed: boolean | null;
        hash: string | null;
        block: null;
        via: 'hash' | null;
        reason: string;
        entry: null;
      }
  );

const hashesFor = (hashes: ReadContext['knownHashes'], [, , chain, payer, nonce]: Slot) =>
  hashes.get(evmAttemptSlot(chain.chainId, payer.address, nonce)) ?? [];

const slotBase = ([step, , chain, payer, nonce]: Slot, knownHashes: readonly string[]) => ({
  step,
  chainId: chain.chainId,
  payer: payer.address,
  nonce,
  consumed: null,
  hash: null,
  knownHashes,
  block: null,
  via: null,
  entry: null,
});

const unavailable = (slot: Slot, reason: string, knownHashes: readonly string[]) => ({
  ...slotBase(slot, knownHashes),
  status: 'unavailable' as const,
  reason,
});

const verifyAnchor = async (provider: JsonRpcProvider, chain: ChainAuthority): Promise<void> => {
  const [network, anchor] = await Promise.all([
    provider.send('eth_chainId', []),
    provider.getBlock(chain.anchorNumber),
  ]);
  if (typeof network !== 'string' || !/^0x[0-9a-f]+$/i.test(network) || BigInt(network) !== BigInt(chain.chainId))
    throw new Error('USDC_EXECUTION_CHAIN_MISMATCH');
  if (!anchor) throw new ObservationUnavailable('USDC_STATUS_CHAIN_ANCHOR_UNAVAILABLE');
  if (anchor.hash !== chain.anchorHash) throw new ObservationUnavailable('USDC_EXECUTION_ANCHOR_CHANGED');
};

const chainPoint = async (current: JsonRpcProvider, chain: ChainAuthority) => {
  const [block] = await Promise.all([current.getBlock('latest'), verifyAnchor(current, chain)]);
  if (!block?.hash || block.number < chain.anchorNumber)
    throw new ObservationUnavailable('USDC_STATUS_CHAIN_POINT_UNAVAILABLE');
  await Promise.all(
    Object.entries(chain.codeHashes).map(async ([address, hash]) => {
      if (keccak256(await current.getCode(address, block.number)) !== hash)
        throw new Error('USDC_EXECUTION_CODE_CHANGED');
    }),
  );
  return { number: block.number, hash: block.hash };
};

const byKnownHash = async (
  current: JsonRpcProvider,
  authority: ExecutionAuthority,
  slot: Slot,
  hash: string,
  point: number,
) => {
  const [, , chain, payer, nonce] = slot;
  const transaction = await current.getTransaction(hash);
  if (!transaction) return null;
  const wire = validateAuthorizedWire(authority, chain, Transaction.from(transaction).serialized);
  if (
    wire.transaction.hash !== hash ||
    transaction.hash !== hash ||
    wire.payer.address !== payer.address ||
    wire.transaction.nonce !== nonce
  )
    throw new Error('USDC_STATUS_KNOWN_TRANSACTION_MISMATCH');
  if (transaction.blockNumber === null || transaction.blockNumber > point) return { hash, entry: null };
  const [receipt, block] = await Promise.all([
    current.getTransactionReceipt(hash),
    current.getBlock(transaction.blockNumber),
  ]);
  if (!receipt || block?.hash !== transaction.blockHash) return null;
  if (receipt.blockNumber <= chain.anchorNumber) throw new Error('USDC_STATUS_RECEIPT_BEFORE_ANCHOR');
  return { hash, entry: verifyAuthorizedReceipt(authority, chain, payer, nonce, { transaction, receipt }) };
};

const minedSlot = (slot: Slot, entry: Entry, via: 'hash' | 'nonce', hashes: readonly string[]): SlotObservation => ({
  ...slotBase(slot, hashes),
  status: entry.receipt.status === 1 ? 'confirmed' : 'reverted',
  consumed: true,
  hash: entry.receipt.hash,
  block: { number: entry.receipt.blockNumber, hash: entry.receipt.blockHash },
  via,
  reason: entry.receipt.status === 0 ? 'USDC_STATUS_TRANSACTION_REVERTED' : null,
  entry,
});

const historyPoint = async (historical: JsonRpcProvider, chain: ChainAuthority, currentHeight: number) => {
  const [height] = await Promise.all([historical.getBlockNumber(), verifyAnchor(historical, chain)]);
  return Math.min(height, currentHeight);
};

const verifyPayerAnchor = async (provider: JsonRpcProvider, chain: ChainAuthority, payer: PayerGrant) => {
  if ((await provider.getTransactionCount(payer.address, chain.anchorNumber)) !== payer.firstNonce)
    throw new Error('USDC_EXECUTION_NONCE_ANCHOR_MISMATCH');
};

const verifyKnownHashAnchor = async (ctx: ReadContext, chain: ChainAuthority, payer: PayerGrant): Promise<void> => {
  try {
    await bounded(verifyPayerAnchor(ctx.current, chain, payer), 6_000);
  } catch (error) {
    // An explicit nonce mismatch is evidence and must never be overridden.
    const issue = rpcIssue(error);
    if (!ctx.historical || ctx.historical === ctx.current) throw new ObservationUnavailable(issue);
    const archive = ctx.historical;
    await bounded(verifyAnchor(archive, chain), 6_000);
    await bounded(verifyPayerAnchor(archive, chain, payer), 6_000);
  }
};

type ReadContext = {
  authority: ExecutionAuthority;
  current: JsonRpcProvider;
  point: number;
  historical: JsonRpcProvider | null;
  history: () => Promise<number>;
  knownHashes: ReadonlyMap<string, readonly string[]>;
};

const readConsumed = async (ctx: ReadContext, slot: Slot): Promise<SlotObservation> => {
  const [, , chain, payer, nonce] = slot;
  if (!ctx.historical) throw new ObservationUnavailable('USDC_STATUS_HISTORY_RPC_UNCONFIGURED');
  const upper = await ctx.history();
  const [, atUpper] = await Promise.all([
    verifyPayerAnchor(ctx.historical, chain, payer),
    ctx.historical.getTransactionCount(payer.address, upper),
  ]);
  if (atUpper <= nonce) throw new ObservationUnavailable('USDC_STATUS_HISTORY_NONCE_UNAVAILABLE');
  const providers = { current: ctx.current, historical: ctx.historical };
  const entry = await findMinedNonceReceipt(providers, chain, payer, nonce, upper);
  const hashes = hashesFor(ctx.knownHashes, slot);
  try {
    return minedSlot(slot, verifyAuthorizedReceipt(ctx.authority, chain, payer, nonce, entry), 'nonce', hashes);
  } catch (error) {
    if (!(error instanceof ExecutionCallNotAuthorized)) throw error;
    return {
      ...slotBase(slot, hashes),
      status: 'conflict',
      consumed: true,
      hash: entry.receipt.hash,
      block: { number: entry.receipt.blockNumber, hash: entry.receipt.blockHash },
      via: 'nonce',
      reason: 'USDC_STATUS_NONCE_CONFLICT',
    };
  }
};

const readKnownHash = async (ctx: ReadContext, slot: Slot, hash: string) => {
  try {
    const result = await bounded(byKnownHash(ctx.current, ctx.authority, slot, hash, ctx.point), 6_000);
    return { result, issue: null };
  } catch (error) {
    return { result: null, issue: rpcIssue(error) };
  }
};

const readSlot = async (ctx: ReadContext, slot: Slot): Promise<SlotObservation> => {
  const [, , chain, payer, nonce] = slot;
  const hashes = hashesFor(ctx.knownHashes, slot);
  let consumed: boolean | null = null;
  try {
    const known = await Promise.all(hashes.map(hash => readKnownHash(ctx, slot, hash)));
    const mined = known.find(candidate => candidate.result?.entry)?.result?.entry;
    if (mined) {
      consumed = true;
      await verifyKnownHashAnchor(ctx, chain, payer);
      return minedSlot(slot, mined, 'hash', hashes);
    }
    const confirmedNonce = await bounded(ctx.current.getTransactionCount(payer.address, ctx.point), 6_000);
    if (confirmedNonce < payer.firstNonce) throw new Error('USDC_EXECUTION_NONCE_ANCHOR_MISMATCH');
    consumed = confirmedNonce > nonce;
    if (consumed) return await bounded(readConsumed(ctx, slot), 12_000);
    const pending = known.find(candidate => candidate.result !== null)?.result;
    const pendingObserved =
      pending !== undefined ||
      (await bounded(ctx.current.getTransactionCount(payer.address, 'pending'), 6_000)) > nonce;
    const issue = known.find(candidate => candidate.issue !== null)?.issue;
    if (!pendingObserved && issue) return { ...unavailable(slot, issue, hashes), consumed };
    return {
      ...slotBase(slot, hashes),
      consumed,
      status: pendingObserved ? 'pending' : 'unobserved',
      hash: pending?.hash ?? null,
      via: pending ? 'hash' : null,
      reason: pendingObserved ? 'USDC_STATUS_PENDING_EVIDENCE' : 'USDC_STATUS_TRANSACTION_NOT_OBSERVED',
    };
  } catch (error) {
    return { ...unavailable(slot, rpcIssue(error), hashes), consumed };
  }
};

export const observeBoundSlots = async (
  authority: ExecutionAuthority,
  chain: ChainAuthority,
  slots: Slot[],
  knownHashes: ReadonlyMap<string, readonly string[]>,
  current: JsonRpcProvider,
  historical: JsonRpcProvider | null,
) => {
  try {
    const point = await bounded(chainPoint(current, chain), 8_000);
    let history: Promise<number> | undefined;
    const ctx: ReadContext = {
      authority,
      current,
      point: point.number,
      historical,
      knownHashes,
      history: () => (history ??= historyPoint(historical!, chain, point.number)),
    };
    const observed = await Promise.all(slots.map(slot => readSlot(ctx, slot)));
    if ((await bounded(current.getBlock(point.number), 6_000))?.hash !== point.hash)
      throw new ObservationUnavailable('USDC_STATUS_CHAIN_POINT_CHANGED');
    return { chainId: chain.chainId, point, error: null, slots: observed };
  } catch (error) {
    const reason = rpcIssue(error);
    return unavailableChain(chain, slots, knownHashes, reason);
  }
};

const unavailableChain = (
  chain: ChainAuthority,
  slots: Slot[],
  hashes: ReadContext['knownHashes'],
  reason: string,
) => ({
  chainId: chain.chainId,
  point: null,
  error: reason,
  slots: slots.map(slot => unavailable(slot, reason, hashesFor(hashes, slot))),
});

export const observeChain = async (
  authority: ExecutionAuthority,
  chain: ChainAuthority,
  slots: Slot[],
  knownHashes: ReadContext['knownHashes'],
) => {
  const network = networks.find(candidate => candidate.chainId === chain.chainId)!;
  let current: JsonRpcProvider | undefined;
  let historical: JsonRpcProvider | null = null;
  try {
    current = preflightProvider(runtimeRpc(network), chain.chainId, true);
    const archiveUrl = process.env[network.env];
    if (archiveUrl) historical = preflightProvider(archiveUrl, chain.chainId, true);
    return await observeBoundSlots(authority, chain, slots, knownHashes, current, historical);
  } catch (error) {
    if (!(error instanceof RpcEnvironmentError)) throw error;
    return unavailableChain(chain, slots, knownHashes, error.code);
  } finally {
    current?.destroy();
    historical?.destroy();
  }
};
