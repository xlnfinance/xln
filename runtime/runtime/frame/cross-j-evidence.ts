import { accountInputAck, accountInputProposal } from '../../account/consensus/flush';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output-envelope';
import { safeStringify } from '../../protocol/serialization';
import type { RuntimeReplica, RoutedEntityInput } from '../types';
import { selectMatchedCrossJAccountInputPairs } from '../entity-routing';
import { recordRuntimeSecurityIncident } from '../security-incidents';

type CrossJPairs = ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'];
type CrossJPair = CrossJPairs[number];

const accountInputMatchesAtomicAck = (
  input: Parameters<typeof accountInputAck>[0],
  expected: CrossJPair['sourceAccountFrame'],
): boolean => {
  const ack = accountInputAck(input);
  return Boolean(
    ack &&
    input.fromEntityId.toLowerCase() === expected.entityId.toLowerCase() &&
    input.toEntityId.toLowerCase() === expected.counterpartyEntityId.toLowerCase() &&
    ack.height === expected.height &&
    String(ack.frameHash || '').toLowerCase() === expected.stateHash.toLowerCase(),
  );
};

const outputMatchesAtomicAck = (
  output: RoutedEntityInput,
  expected: CrossJPair['sourceAccountFrame'],
): boolean =>
  output.entityId.toLowerCase() === expected.counterpartyEntityId.toLowerCase() &&
  getEffectiveEntityInputTxs(output).some(tx =>
    tx.type === 'accountInput' && accountInputMatchesAtomicAck(tx.data, expected));

const outputMatchesPlainAtomicAck = (
  output: RoutedEntityInput,
  expected: CrossJPair['sourceAccountFrame'],
): boolean =>
  getEffectiveEntityInputTxs(output).some(tx =>
    tx.type === 'accountInput' &&
    tx.data.kind === 'ack' &&
    accountInputMatchesAtomicAck(tx.data, expected));

const selectAtomicAckOutputIndexes = (
  outputs: RoutedEntityInput[],
  expected: CrossJPair['sourceAccountFrame'],
): number[] => {
  const matched = outputs.flatMap((output, outputIndex) =>
    outputMatchesAtomicAck(output, expected) ? [outputIndex] : []);
  const plain = matched.filter(outputIndex =>
    outputMatchesPlainAtomicAck(outputs[outputIndex]!, expected));
  return plain.length > 0 ? plain : matched;
};

const summarizeAckOutput = (output: RoutedEntityInput, outputIndex: number) => {
  const acks = getEffectiveEntityInputTxs(output).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const ack = accountInputAck(tx.data);
    return ack ? [{
      fromEntityId: tx.data.fromEntityId,
      toEntityId: tx.data.toEntityId,
      height: ack.height,
      frameHash: ack.frameHash,
    }] : [];
  });
  const origins = (output.entityTxs ?? []).flatMap(tx =>
    tx.type === 'consensusOutput'
      ? [{
          sourceEntityId: tx.data.origin.sourceEntityId,
          entityFrameHeight: tx.data.origin.height,
          entityFrameHash: tx.data.origin.frameHash,
          outputIndex: tx.data.origin.outputIndex,
          lane: tx.data.origin.lane,
          sequence: tx.data.origin.sequence,
          semanticHash: tx.data.origin.semanticHash,
        }]
      : []);
  return acks.length > 0
    ? { outputIndex, entityId: output.entityId, signerId: output.signerId, origins, acks }
    : null;
};

const invalidAtomicAckOutputsError = (
  outputs: RoutedEntityInput[],
  pair: CrossJPair,
  matchedIndexes: number[][],
  pairIndex: number,
  pairCount: number,
): Error => {
  const relevantEntityIds = new Set([
    pair.sourceAccountFrame.counterpartyEntityId.toLowerCase(),
    pair.targetAccountFrame.counterpartyEntityId.toLowerCase(),
  ]);
  const ackOutputs = outputs.flatMap((output, outputIndex) => {
    const summary = summarizeAckOutput(output, outputIndex);
    return summary ? [summary] : [];
  });
  return new Error(`RUNTIME_CROSS_J_ATOMIC_ACK_OUTPUTS_INVALID:${safeStringify({
    pairKeyPrefix: pair.pairKey.slice(0, 160),
    pairKeyLength: pair.pairKey.length,
    pairIndex,
    pairCount,
    inputIndexes: [pair.sourceInputIndex, pair.targetInputIndex],
    expected: [pair.sourceAccountFrame, pair.targetAccountFrame],
    matchedIndexes,
    outputCount: outputs.length,
    ackOutputCount: ackOutputs.length,
    relevantAckOutputs: ackOutputs
      .filter(output => relevantEntityIds.has(output.entityId.toLowerCase()))
      .slice(0, 16),
  })}`);
};

export const markCommittedAtomicCrossJAckOutputs = (
  outputs: RoutedEntityInput[],
  pairs: CrossJPairs,
): void => {
  for (const [pairIndex, pair] of pairs.entries()) {
    if (pair.phase !== 'proposal') continue;
    const matchedIndexes = [pair.sourceAccountFrame, pair.targetAccountFrame].map(expected =>
      selectAtomicAckOutputIndexes(outputs, expected),
    );
    if (
      matchedIndexes.some(indexes => indexes.length !== 1) ||
      matchedIndexes[0]![0] === matchedIndexes[1]![0]
    ) {
      throw invalidAtomicAckOutputsError(
        outputs,
        pair,
        matchedIndexes,
        pairIndex,
        pairs.length,
      );
    }
    for (const outputIndex of [matchedIndexes[0]![0]!, matchedIndexes[1]![0]!]) {
      outputs[outputIndex]!.atomicCrossJurisdictionPair = { phase: 'ack', pairKey: pair.pairKey };
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
        if (accountTx.type !== 'cross_pull_lock' || !accountTx.data.crossJurisdiction) return [];
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
  env: RuntimeReplica,
  code:
    | 'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH'
    | 'CROSS_J_ACCOUNT_PAIR_PROTOCOL_REJECTED'
    | 'CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED'
    | 'CROSS_J_INCOMPLETE_COHORT_DROPPED',
  summary: string,
  severity: 'warning' | 'critical' = 'warning',
): void => {
  // A malformed cohort is one incident. Per-leg incidents let one admitted
  // envelope amplify into thousands of durable records and log lines.
  recordRuntimeSecurityIncident(env, {
    domain: 'cross-j',
    code,
    source: 'remote-ingress',
    severity,
    summary,
    entityId: '',
  });
};
