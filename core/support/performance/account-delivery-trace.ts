import type { AccountInput, AccountReplica, AccountTx } from '../../types/account';
import type { RuntimeEntityInputsEnvelope } from '../../runtime/types';
import { safeStringify } from '../../protocol/serialization';

const accountInputAck = (input: AccountInput) =>
  input.kind === 'ack' || input.kind === 'ack_frame' ? input.ack : undefined;

const accountInputProposal = (input: AccountInput) =>
  input.kind === 'ack_frame' ? input.proposal : undefined;

export type AccountDeliveryHop =
  | 'committed-output'
  | 'p2p-route'
  | 'ws-send-start'
  | 'ws-send-flushed'
  | 'direct-decoded'
  | 'direct-admitted'
  | 'runtime-mempool'
  | 'account-apply-start'
  | 'account-apply-done';

const traceEnabled = (): boolean =>
  typeof process !== 'undefined' && process.env?.['XLN_P2P_DELIVERY_TRACE'] === '1';

const ledgerEnabled = (): boolean =>
  typeof process !== 'undefined' && process.env?.['XLN_HLT_OPERATION_LEDGER'] === '1';

type PaymentOperation = Readonly<{
  hashlock: string | null;
  kind: 'lock' | 'resolve';
  leg: string;
  lockId: string;
}>;

type FramedPaymentOperation = Readonly<{
  frameKey: string;
  operation: PaymentOperation;
}>;

type MutablePaymentLedgerStage = {
  firstAtUnixMs: number;
  lastAtUnixMs: number;
  frameAppearances: number;
  frameKeys: Set<string>;
  operationAppearances: number;
  operationKeys: Set<string>;
  lockIds: Set<string>;
  lockLegs: Set<string>;
  resolveIds: Set<string>;
  resolveLegs: Set<string>;
  hashlocks: Set<string>;
  outcomes: Map<string, number>;
};

export type HltPaymentOperationLedgerStage = Readonly<{
  firstAtUnixMs: number;
  lastAtUnixMs: number;
  frameAppearances: number;
  uniqueFrames: number;
  repeatedFrames: number;
  operationAppearances: number;
  uniqueOperationEvents: number;
  repeatedOperationEvents: number;
  lockIds: readonly string[];
  lockLegs: readonly string[];
  resolveIds: readonly string[];
  resolveLegs: readonly string[];
  hashlocks: readonly string[];
  outcomes: Readonly<Record<string, number>>;
}>;

export type HltPaymentOperationLedgerSnapshot = Readonly<{
  stages: Readonly<Partial<Record<AccountDeliveryHop, HltPaymentOperationLedgerStage>>>;
  swapProposals: HltSwapProposalLedgerSnapshot;
}>;

type HltSwapProposalLedgerSnapshot = Readonly<{
  acceptedOfferIds: readonly string[];
  rejectedOfferIds: readonly string[];
  deferredOfferIds: readonly string[];
  rejectionCodes: Readonly<Record<string, number>>;
  repeatedObservations: number;
}>;

const paymentLedgerStages = new Map<AccountDeliveryHop, MutablePaymentLedgerStage>();
const paymentOperationsByFrameHash = new Map<string, readonly PaymentOperation[]>();
const swapProposalOutcomes = new Map<string, Readonly<{
  outcome: 'accepted' | 'rejected' | 'deferred';
  code: string | null;
}>>();
let repeatedSwapProposalObservations = 0;

const accountLeg = (input: AccountInput): string => {
  const left = input.fromEntityId.toLowerCase();
  const right = input.toEntityId.toLowerCase();
  return left < right ? `${left}|${right}` : `${right}|${left}`;
};

const proposalPaymentOperations = (input: AccountInput): PaymentOperation[] => {
  const proposal = accountInputProposal(input);
  if (!proposal) return [];
  const leg = accountLeg(input);
  const operations: PaymentOperation[] = [];
  for (const tx of proposal.frame.accountTxs as AccountTx[]) {
    if (tx.type === 'htlc_lock') {
      operations.push({ kind: 'lock', lockId: tx.data.lockId, hashlock: tx.data.hashlock, leg });
    }
    if (tx.type === 'htlc_resolve') {
      operations.push({ kind: 'resolve', lockId: tx.data.lockId, hashlock: null, leg });
    }
  }
  return operations;
};

const proposalFrameKey = (input: AccountInput): string | null => {
  const proposal = accountInputProposal(input);
  return proposal
    ? `${accountLeg(input)}|${proposal.frame.height}|${proposal.frame.stateHash}`
    : null;
};

const ackFrameKey = (input: AccountInput): string | null => {
  const ack = accountInputAck(input);
  return ack ? `${accountLeg(input)}|${ack.height}|${ack.frameHash}` : null;
};

/** An ACK carries only the accepted frame hash/height. The HLT correlates it
 * with the proposal already emitted by this same sovereign Runtime. This map
 * is process-RAM telemetry only; it is never part of protocol or storage. */
const framedPaymentOperations = (
  input: AccountInput,
  includeProposalFrame: boolean,
  includeAcknowledgedFrame: boolean,
): FramedPaymentOperation[] => {
  const rows: FramedPaymentOperation[] = [];
  const proposalKey = proposalFrameKey(input);
  if (proposalKey) {
    const operations = proposalPaymentOperations(input);
    const proposal = accountInputProposal(input);
    if (operations.length > 0 && proposal) {
      paymentOperationsByFrameHash.set(proposal.frame.stateHash.toLowerCase(), operations);
    }
    if (includeProposalFrame) {
      rows.push(...operations.map(operation => ({ frameKey: proposalKey, operation })));
    }
  }
  const ackKey = includeAcknowledgedFrame ? ackFrameKey(input) : null;
  if (ackKey) {
    const ack = accountInputAck(input);
    rows.push(...(ack ? paymentOperationsByFrameHash.get(ack.frameHash.toLowerCase()) ?? [] : [])
      .map(operation => ({ frameKey: ackKey, operation })));
  }
  return rows;
};

const mutableLedgerStage = (hop: AccountDeliveryHop): MutablePaymentLedgerStage => {
  const existing = paymentLedgerStages.get(hop);
  if (existing) return existing;
  const created: MutablePaymentLedgerStage = {
    firstAtUnixMs: Date.now(),
    lastAtUnixMs: Date.now(),
    frameAppearances: 0,
    frameKeys: new Set(),
    operationAppearances: 0,
    operationKeys: new Set(),
    lockIds: new Set(),
    lockLegs: new Set(),
    resolveIds: new Set(),
    resolveLegs: new Set(),
    hashlocks: new Set(),
    outcomes: new Map(),
  };
  paymentLedgerStages.set(hop, created);
  return created;
};

const incrementOutcome = (stage: MutablePaymentLedgerStage, key: string, count = 1): void => {
  stage.outcomes.set(key, (stage.outcomes.get(key) ?? 0) + count);
};

const recordPaymentLedger = (
  hop: AccountDeliveryHop,
  inputs: readonly AccountInput[],
  fields: Readonly<Record<string, unknown>>,
): void => {
  if (!ledgerEnabled()) return;
  const stage = mutableLedgerStage(hop);
  stage.lastAtUnixMs = Date.now();
  const outcome = typeof fields['outcome'] === 'string' ? fields['outcome'] : null;
  if (outcome) incrementOutcome(stage, outcome, inputs.length);
  const inboundAckStage = hop === 'direct-decoded' || hop === 'direct-admitted' ||
    hop === 'runtime-mempool' || hop === 'account-apply-start' || hop === 'account-apply-done';
  for (const input of inputs) {
    incrementOutcome(stage, `input:${input.kind}`);
    if (input.kind === 'ack_frame') {
      incrementOutcome(
        stage,
        input.ack === undefined ? 'ack_frame:without-ack' : 'ack_frame:with-ack',
      );
    }
    const ack = accountInputAck(input);
    if (ack) {
      incrementOutcome(
        stage,
        paymentOperationsByFrameHash.has(ack.frameHash.toLowerCase())
          ? 'ack:matched-frame'
          : 'ack:unmatched-frame',
      );
    }
    const frameKeys = [proposalFrameKey(input), ackFrameKey(input)]
      .filter((key): key is string => Boolean(key));
    stage.frameAppearances += frameKeys.length;
    for (const frameKey of frameKeys) stage.frameKeys.add(frameKey);
    for (const { frameKey, operation } of framedPaymentOperations(
      input,
      !inboundAckStage,
      inboundAckStage,
    )) {
      const legKey = `${operation.leg}|${operation.lockId}`;
      stage.operationAppearances += 1;
      stage.operationKeys.add(`${frameKey}|${operation.kind}|${legKey}`);
      if (operation.kind === 'lock') {
        stage.lockIds.add(operation.lockId);
        stage.lockLegs.add(legKey);
        if (operation.hashlock) stage.hashlocks.add(operation.hashlock);
      } else {
        stage.resolveIds.add(operation.lockId);
        stage.resolveLegs.add(legKey);
      }
    }
  }
};

export const resetHltPaymentOperationLedger = (): void => {
  paymentLedgerStages.clear();
  paymentOperationsByFrameHash.clear();
  swapProposalOutcomes.clear();
  repeatedSwapProposalObservations = 0;
};

export const snapshotHltPaymentOperationLedger = (): HltPaymentOperationLedgerSnapshot => ({
  stages: Object.fromEntries([...paymentLedgerStages].map(([hop, stage]) => [hop, {
    firstAtUnixMs: stage.firstAtUnixMs,
    lastAtUnixMs: stage.lastAtUnixMs,
    frameAppearances: stage.frameAppearances,
    uniqueFrames: stage.frameKeys.size,
    repeatedFrames: stage.frameAppearances - stage.frameKeys.size,
    operationAppearances: stage.operationAppearances,
    uniqueOperationEvents: stage.operationKeys.size,
    repeatedOperationEvents: stage.operationAppearances - stage.operationKeys.size,
    lockIds: [...stage.lockIds].sort(),
    lockLegs: [...stage.lockLegs].sort(),
    resolveIds: [...stage.resolveIds].sort(),
    resolveLegs: [...stage.resolveLegs].sort(),
    hashlocks: [...stage.hashlocks].sort(),
    outcomes: Object.fromEntries([...stage.outcomes].sort(([left], [right]) => left.localeCompare(right))),
  }])) as Partial<Record<AccountDeliveryHop, HltPaymentOperationLedgerStage>>,
  swapProposals: {
    acceptedOfferIds: [...swapProposalOutcomes]
      .filter(([, value]) => value.outcome === 'accepted').map(([offerId]) => offerId).sort(),
    rejectedOfferIds: [...swapProposalOutcomes]
      .filter(([, value]) => value.outcome === 'rejected').map(([offerId]) => offerId).sort(),
    deferredOfferIds: [...swapProposalOutcomes]
      .filter(([, value]) => value.outcome === 'deferred').map(([offerId]) => offerId).sort(),
    rejectionCodes: Object.fromEntries([...swapProposalOutcomes.values()]
      .reduce((counts, value) => {
        if (value.outcome !== 'rejected' || value.code === null) return counts;
        counts.set(value.code, (counts.get(value.code) ?? 0) + 1);
        return counts;
      }, new Map<string, number>())),
    repeatedObservations: repeatedSwapProposalObservations,
  },
});

/** HLT-only terminal ledger for locally proposed swap commands. Account
 * quiescence later proves every accepted proposal was ACKed; rejected rows are
 * terminal by construction because proposal validation removes them. */
export const traceHltSwapProposalOutcomes = (
  proposalWindow: readonly AccountTx[],
  dropped: readonly Readonly<{
    index: number;
    code: string;
    disposition: 'deferred' | 'removed';
  }>[],
): void => {
  if (!ledgerEnabled()) return;
  const droppedByIndex = new Map(dropped.map(row => [row.index, row]));
  proposalWindow.forEach((tx, index) => {
    if (tx.type !== 'swap_offer') return;
    const failure = droppedByIndex.get(index);
    const value = failure === undefined
      ? { outcome: 'accepted' as const, code: null }
      : failure.disposition === 'deferred'
        ? { outcome: 'deferred' as const, code: failure.code }
        : { outcome: 'rejected' as const, code: failure.code };
    const existing = swapProposalOutcomes.get(tx.data.offerId);
    if (existing !== undefined) {
      if (existing.outcome !== value.outcome || existing.code !== value.code) {
        throw new Error(
          `HLT_SWAP_PROPOSAL_OUTCOME_CONFLICT:${tx.data.offerId}:` +
          `${existing.outcome}/${String(existing.code)}:${value.outcome}/${String(value.code)}`,
        );
      }
      repeatedSwapProposalObservations += 1;
      return;
    }
    swapProposalOutcomes.set(tx.data.offerId, value);
  });
};

const accountInputRow = (input: AccountInput): Record<string, unknown> => {
  const proposal = accountInputProposal(input);
  const ack = accountInputAck(input);
  return {
    kind: input.kind,
    fromEntityId: input.fromEntityId,
    toEntityId: input.toEntityId,
    proposalHeight: proposal?.frame.height ?? null,
    proposalHash: proposal?.frame.stateHash ?? null,
    ackHeight: ack?.height ?? null,
    ackHash: ack?.frameHash ?? null,
  };
};

const envelopeAccountInputs = (envelope: RuntimeEntityInputsEnvelope): AccountInput[] =>
  envelope.entityInputs.flatMap(entityInput =>
    (entityInput.entityTxs ?? []).flatMap(tx => tx.type === 'accountInput' ? [tx.data] : []));

export const traceAccountDeliveryHop = (
  hop: AccountDeliveryHop,
  envelope: RuntimeEntityInputsEnvelope,
  fields: Record<string, unknown> = {},
): void => {
  const accountInputs = envelopeAccountInputs(envelope);
  if (accountInputs.length === 0) return;
  recordPaymentLedger(hop, accountInputs, fields);
  if (!traceEnabled()) return;
  console.log(safeStringify({
    type: 'XLN_ACCOUNT_DELIVERY_TRACE',
    atMs: Date.now(),
    hop,
    // The Runtime envelope signature binds source, target and exact canonical
    // inputs, so it is the zero-copy correlation id shared by every wire hop.
    deliveryId: envelope.sourceSignature,
    sourceRuntimeId: envelope.sourceRuntimeId,
    sourceRuntimeHeight: envelope.sourceRuntimeHeight,
    sourceRuntimeTimestamp: envelope.sourceRuntimeTimestamp,
    accountInputs: accountInputs.map(accountInputRow),
    ...fields,
  }));
};

export const traceAccountApplyHop = (
  hop: 'account-apply-start' | 'account-apply-done',
  input: AccountInput,
  fields: Record<string, unknown> = {},
): void => {
  recordPaymentLedger(hop, [input], fields);
  if (!traceEnabled()) return;
  console.log(safeStringify({
    type: 'XLN_ACCOUNT_DELIVERY_TRACE',
    atMs: Date.now(),
    hop,
    accountInput: accountInputRow(input),
    ...fields,
  }));
};

export const traceAccountFlushHop = (
  hop: 'entity-response-required' | 'entity-flush-start' | 'entity-flush-done',
  entityId: string,
  accountKey: string,
  account: AccountReplica,
  requiredResponse: AccountInput | undefined,
  fields: Record<string, unknown> = {},
): void => {
  if (!traceEnabled()) return;
  console.log(safeStringify({
    type: 'XLN_ACCOUNT_DELIVERY_TRACE',
    atMs: Date.now(),
    hop,
    entityId,
    accountKey,
    currentHeight: account.currentHeight,
    currentHash: account.currentFrame.stateHash,
    pendingHeight: account.pendingFrame?.height ?? null,
    pendingHash: account.pendingFrame?.stateHash ?? null,
    pendingInput: account.pendingAccountInput ? accountInputRow(account.pendingAccountInput) : null,
    requiredResponse: requiredResponse ? accountInputRow(requiredResponse) : null,
    lastOutboundAckHeight: account.lastOutboundAckFrame?.height ?? null,
    rollbackCount: account.rollbackCount,
    lastRollbackFrameHash: account.lastRollbackFrameHash ?? null,
    mempoolTxTypes: account.mempool.map(tx => tx.type),
    ...fields,
  }));
};
