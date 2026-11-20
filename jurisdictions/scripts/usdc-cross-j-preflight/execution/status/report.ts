import { join } from 'node:path';
import { decodeJBatch } from '../../../../../core/jurisdiction/machine/batch';
import { safeStringify } from '../../../../../core/protocol/serialization';
import { receiptFields } from '../../../../../core/scenarios/usdc-poc/evidence';
import { requireTokenTransfer } from '../../../../../core/scenarios/usdc-poc/target-evidence';
import {
  authorityDigest,
  catalogDigest,
  readAuthority,
  requireAuthorityCatalog,
  verifyExecutionBindings,
  type ExecutionAuthority,
} from '../authority';
import type { StatusConfig } from '../config';
import { receiptSlots } from '../receipt-event';
import { observeChain, type SlotObservation } from './chain';
import { observeHubCover, observeWal } from './wal';

type WalState = NonNullable<Awaited<ReturnType<typeof observeWal>>['state']>;

const requireBindings = (config: StatusConfig, authority: ExecutionAuthority): number => {
  const runIndex = authority.runIds.indexOf(config.runId);
  if (runIndex < 0) throw new Error('USDC_EXECUTION_RUN_NOT_AUTHORIZED');
  const catalog = join(config.stand.directory, 'jurisdictions.json');
  if (catalogDigest(catalog) !== authority.catalogDigest) throw new Error('USDC_STATUS_CATALOG_DIGEST_MISMATCH');
  requireAuthorityCatalog(authority.chains, catalog);
  verifyExecutionBindings(config.stand.directory, config.stand.apiBase, authority);
  return runIndex;
};

const verifyDeposit = (authority: ExecutionAuthority, slot: SlotObservation) => {
  if (slot.status !== 'confirmed') return null;
  const source = authority.chains[0]!;
  const amount = decodeJBatch(slot.entry.batch!.encoded).externalTokenToReserve[0]!.amount;
  requireTokenTransfer(
    { receipts: [receiptFields(slot.entry)] },
    {
      token: source.token,
      from: source.userSigner,
      to: source.depository,
      amount,
    },
  );
  return amount;
};

const verifyPayout = (authority: ExecutionAuthority, cover: SlotObservation, withdrawal: SlotObservation) => {
  if (withdrawal.status !== 'confirmed') return null;
  const target = authority.chains[1]!;
  const amount = decodeJBatch(withdrawal.entry.batch!.encoded).reserveToExternalToken[0]!.amount;
  requireTokenTransfer(
    { receipts: [receiptFields(withdrawal.entry)] },
    {
      token: target.token,
      from: target.depository,
      to: target.userSigner,
      amount,
    },
  );
  const covered =
    cover.status === 'confirmed'
      ? decodeJBatch(cover.entry.batch!.encoded).reserveToCollateral[0]!.pairs[0]!.amount
      : null;
  return {
    amount,
    recipient: target.userSigner,
    token: target.token,
    coverMatches: covered === null ? null : covered === amount,
  };
};

const inspectJourney = (wal: WalState | null, deposit: bigint | null) => {
  const source = wal?.entities[0]?.route;
  const target = wal?.entities[1]?.route;
  const sameRoute = Boolean(source?.routeHash && source.routeHash === target?.routeHash);
  const settled =
    sameRoute &&
    [source, target].every(
      route =>
        route?.status === 'settled' &&
        route.sourceTotal === 1_000_000n &&
        route.sourceRemaining === 0n &&
        route.targetRemaining === 0n,
    );
  const remainingPrincipal =
    sameRoute && source!.sourceRemaining === target!.sourceRemaining
      ? source!.sourceRemaining
      : wal && !source && !target
        ? deposit
        : null;
  return { remainingPrincipal, settled, grossTarget: sameRoute ? source!.targetTotal : null };
};

const observeReceiptInWal = (slot: SlotObservation, wal: WalState | null) => {
  if (!slot.block || slot.step === 'approval' || slot.status !== 'confirmed') return null;
  const entity = wal?.entities.find(candidate => candidate.chainId === slot.chainId);
  if (!entity) return 'unknown';
  if (entity.lastFinalizedJHeight < slot.block.number) return 'watcher-behind';
  if (
    entity.lastFinalizedJHeight === slot.block.number &&
    entity.lastFinalizedJHash &&
    entity.lastFinalizedJHash !== slot.block.hash
  )
    return 'watcher-block-mismatch';
  return 'watcher-at-or-past-block';
};

const inspectProgress = (authority: ExecutionAuthority, slots: SlotObservation[], wal: WalState | null) => {
  const deposit = verifyDeposit(authority, slots[1]!);
  const verifiedPayout = verifyPayout(authority, slots[3]!, slots[4]!);
  const journey = inspectJourney(wal, deposit);
  const evidence = slots.map(slot => {
    const { entry: _, ...summary } = slot;
    return { ...summary, walObservation: observeReceiptInWal(slot, wal) };
  });
  const payoutFitsRoute =
    verifiedPayout && journey.grossTarget !== null ? verifiedPayout.amount <= journey.grossTarget : null;
  const complete =
    evidence.every(
      slot =>
        slot.status === 'confirmed' && (slot.step === 'approval' || slot.walObservation === 'watcher-at-or-past-block'),
    ) &&
    deposit !== null &&
    journey.settled &&
    verifiedPayout?.coverMatches === true &&
    payoutFitsRoute === true;
  const watcherReasons = {
    'watcher-behind': 'USDC_STATUS_WATCHER_BEHIND',
    'watcher-block-mismatch': 'USDC_STATUS_WATCHER_BLOCK_MISMATCH',
  } as const;
  const progressReasons = [
    ...evidence.flatMap(slot => {
      const observation = slot.walObservation;
      const watcherReason =
        observation === 'watcher-behind' || observation === 'watcher-block-mismatch'
          ? watcherReasons[observation]
          : null;
      return [slot.reason, watcherReason].filter(Boolean).map(reason => `${slot.step}:${reason}`);
    }),
    ...(!journey.settled ? ['USDC_STATUS_ROUTE_SETTLEMENT_NOT_VERIFIED'] : []),
    ...(verifiedPayout && !verifiedPayout.coverMatches ? ['USDC_STATUS_PAYOUT_COVER_NOT_VERIFIED'] : []),
    ...(payoutFitsRoute === false ? ['USDC_STATUS_PAYOUT_EXCEEDS_COMMITTED_ROUTE'] : []),
  ].filter(reason => reason !== null);
  return {
    complete,
    slots: evidence,
    remainingPrincipal: journey.remainingPrincipal,
    payout: verifiedPayout,
    lastConfirmedStep: evidence.findLast(slot => slot.status === 'confirmed')?.step ?? null,
    progressReasons,
  };
};

export const observeRun = async (config: StatusConfig, scratch: string) => {
  const observedAt = new Date().toISOString();
  const authority = readAuthority(config.authorityPath);
  const runIndex = requireBindings(config, authority);
  const expected = receiptSlots(authority, runIndex);
  const [wal, hub] = await Promise.all([
    observeWal(config, authority, scratch, expected),
    observeHubCover(config.stand.stores.hub, scratch, authority.chains[0]!.hubSigner, expected[3]),
  ]);
  wal.hashes.set(hub.key, hub.hashes);
  const chains = await Promise.all(
    authority.chains.map(async (chain, index) => {
      const { slots, ...observation } = await observeChain(
        authority,
        chain,
        expected.filter(slot => slot[1] === index),
        wal.hashes,
      );
      return { slots, observation: { ...observation, anchor: { number: chain.anchorNumber, hash: chain.anchorHash } } };
    }),
  );
  const { progressReasons, ...progress } = inspectProgress(
    authority,
    chains.flatMap(chain => chain.slots),
    wal.state,
  );
  const { approved, expiresAt, candidateHead, candidateDigest } = authority;
  const expired = Date.now() >= expiresAt;
  return {
    runId: config.runId,
    observedAt,
    ...progress,
    authority: { digest: authorityDigest(authority), approved, expiresAt, expired, candidateHead, candidateDigest },
    catalogDigest: authority.catalogDigest,
    chains: chains.map(({ observation }) => observation),
    wal: wal.state,
    walHeights: wal.heights,
    reasons: [
      approved ? null : 'USDC_EXECUTION_AUTHORITY_MISSING',
      expired ? 'USDC_EXECUTION_AUTHORITY_EXPIRED' : null,
      wal.error,
      wal.historyError,
      hub.error,
      ...progressReasons,
    ].filter(reason => reason !== null),
  };
};

export const printStatus = (report: Awaited<ReturnType<typeof observeRun>>, json: boolean): void => {
  if (json) console.log(safeStringify(report, 2));
  else {
    console.log(`USDC run ${report.runId} · ${report.complete ? 'complete' : 'incomplete or unresolved'}`);
    console.log(Bun.inspect(report, { colors: false, depth: 8, compact: false }));
  }
};
