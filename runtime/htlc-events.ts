import { cloneEntityState } from './state-helpers';
import type { EntityReplica, EntityState, JReplica } from './types';

const PAYMENT_TS_MARKER_RE = /(?:^|\s)tsms:(\d{10,})(?=$|\s)/i;

export const extractStartedAtMs = (description?: string): number | null => {
  const match = String(description || '').match(PAYMENT_TS_MARKER_RE);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const buildHtlcReceivedTimingFields = (description: string | undefined, receivedAtMs: number) => {
  const startedAtMs = extractStartedAtMs(description);
  if (!startedAtMs) {
    return { receivedAtMs };
  }
  const elapsedMs = Math.max(1, receivedAtMs - startedAtMs);
  return {
    startedAtMs,
    receivedAtMs,
    elapsedMs,
    finalizedInMs: elapsedMs,
  };
};

export const buildHtlcFinalizedTimingFields = (description: string | undefined, finalizedAtMs: number) => {
  const startedAtMs = extractStartedAtMs(description);
  if (!startedAtMs) {
    return { finalizedAtMs };
  }
  const elapsedMs = Math.max(1, finalizedAtMs - startedAtMs);
  return {
    startedAtMs,
    finalizedAtMs,
    elapsedMs,
    finalizedInMs: elapsedMs,
  };
};

type CommonHtlcEventArgs = {
  entityId: string;
  fromEntity?: string;
  toEntity?: string;
  hashlock: string;
  lockId?: string;
  amount?: bigint;
  tokenId?: number;
  jurisdictionId?: string;
  description?: string;
};

export const buildHtlcReceivedEventPayload = (
  args: CommonHtlcEventArgs & { receivedAtMs: number },
): Record<string, unknown> => ({
  entityId: args.entityId,
  ...(args.fromEntity ? { fromEntity: args.fromEntity } : {}),
  ...(args.toEntity ? { toEntity: args.toEntity } : {}),
  hashlock: args.hashlock,
  ...(args.lockId ? { lockId: args.lockId } : {}),
  ...(args.amount !== undefined ? { amount: args.amount.toString() } : {}),
  ...(args.tokenId !== undefined ? { tokenId: args.tokenId } : {}),
  ...(args.jurisdictionId ? { jurisdictionId: args.jurisdictionId } : {}),
  ...(args.description ? { description: args.description } : {}),
  ...buildHtlcReceivedTimingFields(args.description, args.receivedAtMs),
});

export const buildHtlcFinalizedEventPayload = (
  args: CommonHtlcEventArgs & { finalizedAtMs: number; secret?: string },
): Record<string, unknown> => ({
  entityId: args.entityId,
  ...(args.fromEntity ? { fromEntity: args.fromEntity } : {}),
  ...(args.toEntity ? { toEntity: args.toEntity } : {}),
  hashlock: args.hashlock,
  ...(args.secret ? { secret: args.secret } : {}),
  ...(args.lockId ? { lockId: args.lockId } : {}),
  ...(args.amount !== undefined ? { amount: args.amount.toString() } : {}),
  ...(args.tokenId !== undefined ? { tokenId: args.tokenId } : {}),
  ...(args.jurisdictionId ? { jurisdictionId: args.jurisdictionId } : {}),
  ...(args.description ? { description: args.description } : {}),
  ...buildHtlcFinalizedTimingFields(args.description, args.finalizedAtMs),
});

const cloneHankoWitness = (
  hankoWitness?: EntityReplica['hankoWitness'],
): EntityReplica['hankoWitness'] | undefined => {
  if (!(hankoWitness instanceof Map) || hankoWitness.size === 0) return undefined;
  return new Map(
    Array.from(hankoWitness.entries()).map(([hash, entry]) => [
      hash,
      {
        hanko: entry.hanko,
        type: entry.type,
        entityHeight: entry.entityHeight,
        createdAt: entry.createdAt,
      },
    ]),
  );
};

export const buildPersistedEntityReplicaSnapshot = (replica: EntityReplica): EntityReplica => ({
  entityId: replica.entityId,
  signerId: replica.signerId,
  state: cloneEntityState(replica.state, true),
  mempool: [],
  isProposer: replica.isProposer,
  ...(replica.position ? { position: { ...replica.position } } : {}),
  ...(cloneHankoWitness(replica.hankoWitness) ? { hankoWitness: cloneHankoWitness(replica.hankoWitness) } : {}),
});

const cloneNestedBigIntMap = <V>(
  value: Map<string, Map<number, V>> | undefined,
  cloneLeaf: (leaf: V) => V,
): Map<string, Map<number, V>> | undefined => {
  if (!(value instanceof Map) || value.size === 0) return undefined;
  return new Map(
    Array.from(value.entries()).map(([outerKey, innerMap]) => [
      outerKey,
      new Map(Array.from(innerMap.entries()).map(([innerKey, leaf]) => [innerKey, cloneLeaf(leaf)])),
    ]),
  );
};

export const buildPersistedJReplicaSnapshot = (jr: JReplica): JReplica => ({
  name: jr.name,
  blockNumber: jr.blockNumber,
  stateRoot: new Uint8Array(jr.stateRoot),
  mempool: [],
  blockDelayMs: jr.blockDelayMs,
  lastBlockTimestamp: jr.lastBlockTimestamp,
  ...(jr.rpcs ? { rpcs: [...jr.rpcs] } : {}),
  ...(jr.chainId !== undefined ? { chainId: jr.chainId } : {}),
  position: { ...jr.position },
  ...(jr.depositoryAddress ? { depositoryAddress: jr.depositoryAddress } : {}),
  ...(jr.entityProviderAddress ? { entityProviderAddress: jr.entityProviderAddress } : {}),
  ...(jr.contracts
    ? {
        contracts: {
          ...(jr.contracts.depository ? { depository: jr.contracts.depository } : {}),
          ...(jr.contracts.entityProvider ? { entityProvider: jr.contracts.entityProvider } : {}),
          ...(jr.contracts.account ? { account: jr.contracts.account } : {}),
          ...(jr.contracts.deltaTransformer ? { deltaTransformer: jr.contracts.deltaTransformer } : {}),
        },
      }
    : {}),
  ...(cloneNestedBigIntMap(jr.reserves, (leaf) => BigInt(leaf as bigint)) ? { reserves: cloneNestedBigIntMap(jr.reserves, (leaf) => BigInt(leaf as bigint)) } : {}),
  ...(cloneNestedBigIntMap(jr.collaterals, (leaf) => ({
      collateral: BigInt((leaf as { collateral: bigint }).collateral),
      ondelta: BigInt((leaf as { ondelta: bigint }).ondelta),
    })) ? { collaterals: cloneNestedBigIntMap(jr.collaterals, (leaf) => ({
      collateral: BigInt((leaf as { collateral: bigint }).collateral),
      ondelta: BigInt((leaf as { ondelta: bigint }).ondelta),
    })) } : {}),
  ...(jr.registeredEntities
    ? {
        registeredEntities: new Map(
          Array.from(jr.registeredEntities.entries()).map(([entityId, value]) => [
            entityId,
            {
              name: value.name,
              quorum: [...value.quorum],
              threshold: value.threshold,
            },
          ]),
        ),
      }
    : {}),
});

