/** Exact accounting of the work one payment recording makes H1 perform. */

import type { EntityInput } from '../../../../entity/types';
import type { PersistedFrameJournal } from '../../../../storage/types';

type Direction = 'ingress' | 'egress';

type DirectionLedger = Readonly<{
  entityInputs: number;
  entityTxs: number;
  accountInputs: number;
  accountInputKinds: Readonly<Record<string, number>>;
  proposalFrames: number;
  uniqueProposalFrames: number;
  repeatedProposalFrames: number;
  accountTxAppearances: Readonly<Record<string, number>>;
}>;

export type PaymentWorkLedger = Readonly<{
  economicPayments: number;
  expectedAccountSubpayments: number;
  hubEntityId: string;
  bilateralAccounts: number;
  nonHubEntities: number;
  uniqueLockLegs: number;
  uniqueResolveLegs: number;
  ingress: DirectionLedger;
  egress: DirectionLedger;
}>;

type MutableDirectionLedger = {
  entityInputs: number;
  entityTxs: number;
  accountInputs: number;
  accountInputKinds: Record<string, number>;
  proposalFrames: number;
  proposalFrameKeys: Set<string>;
  accountTxAppearances: Record<string, number>;
};

const emptyDirectionLedger = (): MutableDirectionLedger => ({
  entityInputs: 0,
  entityTxs: 0,
  accountInputs: 0,
  accountInputKinds: {},
  proposalFrames: 0,
  proposalFrameKeys: new Set(),
  accountTxAppearances: {},
});

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const accountLeg = (left: string, right: string): string =>
  left < right ? `${left}|${right}` : `${right}|${left}`;

const inspectInputs = (
  direction: Direction,
  inputs: readonly EntityInput[],
  ledger: MutableDirectionLedger,
  accountLegs: Map<string, readonly [string, string]>,
  lockLegs: Set<string>,
  resolveLegs: Set<string>,
): void => {
  ledger.entityInputs += inputs.length;
  for (const input of inputs) {
    ledger.entityTxs += input.entityTxs?.length ?? 0;
    for (const tx of input.entityTxs ?? []) {
      if (tx.type !== 'accountInput') continue;
      ledger.accountInputs += 1;
      bump(ledger.accountInputKinds, tx.data.kind);
      if (tx.data.kind !== 'ack_frame') continue;
      const from = tx.data.fromEntityId.toLowerCase();
      const to = tx.data.toEntityId.toLowerCase();
      const leg = accountLeg(from, to);
      accountLegs.set(leg, from < to ? [from, to] : [to, from]);
      const frame = tx.data.proposal.frame;
      ledger.proposalFrames += 1;
      ledger.proposalFrameKeys.add(`${direction}|${leg}|${frame.height}|${frame.stateHash}`);
      for (const accountTx of frame.accountTxs) {
        bump(ledger.accountTxAppearances, accountTx.type);
        if (accountTx.type !== 'htlc_lock' && accountTx.type !== 'htlc_resolve') continue;
        const operation = `${leg}|${accountTx.data.lockId}`;
        (accountTx.type === 'htlc_lock' ? lockLegs : resolveLegs).add(operation);
      }
    }
  }
};

const finalizeDirection = (ledger: MutableDirectionLedger): DirectionLedger => ({
  entityInputs: ledger.entityInputs,
  entityTxs: ledger.entityTxs,
  accountInputs: ledger.accountInputs,
  accountInputKinds: ledger.accountInputKinds,
  proposalFrames: ledger.proposalFrames,
  uniqueProposalFrames: ledger.proposalFrameKeys.size,
  repeatedProposalFrames: ledger.proposalFrames - ledger.proposalFrameKeys.size,
  accountTxAppearances: ledger.accountTxAppearances,
});

const commonHubEntity = (legs: readonly (readonly [string, string])[]): string => {
  const first = legs[0];
  if (!first) throw new Error('HLT_PAYMENT_LEDGER_ACCOUNT_LEGS_MISSING');
  const candidates = first.filter(candidate => legs.every(leg => leg.includes(candidate)));
  if (candidates.length !== 1) {
    throw new Error(`HLT_PAYMENT_LEDGER_SINGLE_HUB_INVALID:candidates=${candidates.length}`);
  }
  return candidates[0]!;
};

/**
 * Counts a subpayment by `(bilateral Account, lockId)`. The same lock material
 * on sender→H1 and H1→receiver is therefore two required legs, never a duplicate.
 */
const summarizePaymentWorkInternal = (
  frames: readonly PersistedFrameJournal[],
  suppliedEconomicPayments: number | null,
): PaymentWorkLedger => {
  if (
    suppliedEconomicPayments !== null &&
    (!Number.isSafeInteger(suppliedEconomicPayments) || suppliedEconomicPayments < 1)
  ) {
    throw new Error('HLT_PAYMENT_LEDGER_ECONOMIC_COUNT_INVALID');
  }
  const ingress = emptyDirectionLedger();
  const egress = emptyDirectionLedger();
  const accountLegs = new Map<string, readonly [string, string]>();
  const lockLegs = new Set<string>();
  const resolveLegs = new Set<string>();
  for (const frame of frames) {
    inspectInputs('ingress', frame.runtimeInput.entityInputs, ingress, accountLegs, lockLegs, resolveLegs);
    inspectInputs('egress', frame.runtimeOutputs ?? [], egress, accountLegs, lockLegs, resolveLegs);
  }
  if (
    suppliedEconomicPayments === null &&
    (lockLegs.size < 2 || lockLegs.size % 2 !== 0)
  ) {
    throw new Error(`HLT_PAYMENT_LEDGER_SUBPAYMENTS_ODD:locks=${lockLegs.size}`);
  }
  const economicPayments = suppliedEconomicPayments ?? lockLegs.size / 2;
  const expectedAccountSubpayments = economicPayments * 2;
  if (lockLegs.size !== expectedAccountSubpayments || resolveLegs.size !== expectedAccountSubpayments) {
    throw new Error(
      `HLT_PAYMENT_LEDGER_SUBPAYMENTS_INVALID:` +
      `expected=${expectedAccountSubpayments}:locks=${lockLegs.size}:resolves=${resolveLegs.size}`,
    );
  }
  const legs = [...accountLegs.values()];
  const hubEntityId = commonHubEntity(legs);
  const nonHubEntities = new Set(legs.flatMap(leg => leg.filter(entityId => entityId !== hubEntityId)));
  return {
    economicPayments,
    expectedAccountSubpayments,
    hubEntityId,
    bilateralAccounts: accountLegs.size,
    nonHubEntities: nonHubEntities.size,
    uniqueLockLegs: lockLegs.size,
    uniqueResolveLegs: resolveLegs.size,
    ingress: finalizeDirection(ingress),
    egress: finalizeDirection(egress),
  };
};

/** Validate a workload against an independently supplied economic count. */
export const summarizePaymentWork = (
  frames: readonly PersistedFrameJournal[],
  economicPayments: number,
): PaymentWorkLedger => summarizePaymentWorkInternal(frames, economicPayments);

/**
 * Infer real routed payments from the canonical per-operation ledger itself.
 * One payment has exactly two unique bilateral `(Account, lockId)` legs; the
 * faucet's directPayment tx is setup and therefore cannot inflate this count.
 */
export const summarizeRecordedPaymentWork = (
  frames: readonly PersistedFrameJournal[],
): PaymentWorkLedger => summarizePaymentWorkInternal(frames, null);
