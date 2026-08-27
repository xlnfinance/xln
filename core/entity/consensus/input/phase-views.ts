import type { EntityTx } from '../../../types/entity-tx';
import type { EntityInput, EntityLeaderTimeoutVote } from '../../types';

export const ENTITY_INPUT_FIELD_PHASE = {
  entityId: 'identity',
  signerId: 'identity',
  runtimeId: 'routing',
  from: 'routing',
  localRuntimeProtocol: 'routing',
  entityTxs: 'transactions',
  proposedFrame: 'proposal',
  hashPrecommitFrame: 'precommit',
  hashPrecommits: 'precommit',
  jPrefixAttestations: 'j_prefix',
  leaderTimeoutVote: 'leader_timeout',
} as const satisfies Record<
  keyof EntityInput,
  'identity' | 'routing' | 'transactions' | 'proposal' | 'precommit' | 'j_prefix' | 'leader_timeout'
>;

export type EntityTransactionsInput = EntityInput & { entityTxs: EntityTx[] };
export type EntityHashPrecommitInput = EntityInput & {
  hashPrecommitFrame: NonNullable<EntityInput['hashPrecommitFrame']>;
  hashPrecommits: Map<string, string[]>;
};
export type EntityLeaderTimeoutInput = EntityInput & {
  leaderTimeoutVote: EntityLeaderTimeoutVote;
  entityTxs?: never;
  proposedFrame?: never;
  hashPrecommitFrame?: never;
  hashPrecommits?: never;
  jPrefixAttestations?: never;
};

export const hasEntityTransactions = (
  input: EntityInput,
): input is EntityTransactionsInput => Array.isArray(input.entityTxs)
  && input.entityTxs.length > 0;

export const hasEntityHashPrecommits = (
  input: EntityInput,
): input is EntityHashPrecommitInput => input.hashPrecommitFrame !== undefined
  && input.hashPrecommits instanceof Map
  && input.hashPrecommits.size > 0;

export const isEntityLeaderTimeoutInput = (
  input: EntityInput,
): input is EntityLeaderTimeoutInput => input.leaderTimeoutVote !== undefined
  && input.entityTxs === undefined
  && input.proposedFrame === undefined
  && input.hashPrecommitFrame === undefined
  && input.hashPrecommits === undefined
  && input.jPrefixAttestations === undefined;

export const getEntityInputPhaseCombinationError = (
  input: EntityInput,
): string | null => {
  if (input.leaderTimeoutVote && !isEntityLeaderTimeoutInput(input)) {
    return 'ENTITY_INPUT_LEADER_TIMEOUT_LANE_MIXED';
  }
  if ((input.hashPrecommitFrame === undefined) !== (input.hashPrecommits === undefined)) {
    return 'ENTITY_INPUT_PRECOMMIT_PAIR_INCOMPLETE';
  }
  return null;
};
