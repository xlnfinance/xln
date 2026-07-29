import { accountInputAck, accountInputProposal } from '../../account/consensus/flush';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output-envelope';
import type { RuntimeState, RoutedEntityInput } from '../types';
import { selectMatchedCrossJAccountInputPairs } from '../entity-routing';
import { recordRuntimeSecurityIncident } from '../security-incidents';

type CrossJPairs = ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'];

export const markCommittedAtomicCrossJAckOutputs = (
  outputs: RoutedEntityInput[],
  pairs: CrossJPairs,
): void => {
  for (const pair of pairs) {
    if (pair.phase !== 'proposal') continue;
    const matched = [pair.sourceAccountFrame, pair.targetAccountFrame].map(expected =>
      outputs.filter(
        output =>
          output.entityId.toLowerCase() === expected.counterpartyEntityId.toLowerCase() &&
          getEffectiveEntityInputTxs(output).some(tx => {
            if (tx.type !== 'accountInput') return false;
            const ack = accountInputAck(tx.data);
            return Boolean(
              ack &&
              tx.data.fromEntityId.toLowerCase() === expected.entityId.toLowerCase() &&
              tx.data.toEntityId.toLowerCase() === expected.counterpartyEntityId.toLowerCase() &&
              ack.height === expected.height &&
              String(ack.frameHash || '').toLowerCase() === expected.stateHash.toLowerCase(),
            );
          }),
      ),
    );
    if (matched.some(candidates => candidates.length !== 1) || matched[0]![0] === matched[1]![0]) {
      throw new Error(`RUNTIME_CROSS_J_ATOMIC_ACK_OUTPUTS_INVALID:${pair.pairKey}`);
    }
    for (const output of [matched[0]![0]!, matched[1]![0]!]) {
      output.atomicCrossJurisdictionPair = { phase: 'ack', pairKey: pair.pairKey };
    }
  }
};

export const summarizeAtomicCrossJAccountInput = (
  input: RoutedEntityInput,
  inputIndex: number,
) => ({
  inputIndex,
  entityId: input.entityId,
  signerId: input.signerId,
  fromRuntimeId: input.from ?? '',
  sourceRuntimeFrame: input.sourceRuntimeFrame ?? null,
  accountInputs: getEffectiveEntityInputTxs(input).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const ack = accountInputAck(tx.data);
    const proposal = accountInputProposal(tx.data);
    const crossPulls =
      proposal?.frame.accountTxs.flatMap(accountTx => {
        if (accountTx.type !== 'pull_lock' || !accountTx.data.crossJurisdiction) return [];
        return [{
          leg: accountTx.data.crossJurisdiction.leg,
          orderId: accountTx.data.crossJurisdiction.orderId,
          routeHash: accountTx.data.crossJurisdiction.routeHash,
        }];
      }) ?? [];
    return [{
      kind: tx.data.kind,
      fromEntityId: tx.data.fromEntityId,
      toEntityId: tx.data.toEntityId,
      ackHeight: ack?.height ?? null,
      proposalHeight: proposal?.frame.height ?? null,
      crossPulls,
    }];
  }),
});

export const recordRejectedAtomicCrossJInputs = (
  env: RuntimeState,
  inputs: readonly RoutedEntityInput[],
  inputIndexes: Iterable<number>,
  code:
    | 'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH'
    | 'CROSS_J_ACCOUNT_PAIR_PROTOCOL_REJECTED'
    | 'CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED',
  summary: string,
): void => {
  for (const inputIndex of inputIndexes) {
    recordRuntimeSecurityIncident(env, {
      domain: 'cross-j',
      code,
      source: 'remote-ingress',
      severity: 'warning',
      summary,
      entityId: inputs[inputIndex]!.entityId,
    });
  }
};
