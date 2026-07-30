import {
  getEntityCertifiedJAnchor,
  getValidatorJExpectedBlockHash,
} from '../jurisdiction/local-history';
import type { EntityReplica } from '../entity/types';
import type { RuntimeReplica } from '../runtime/types';
import type { JReplica } from '../types/jurisdiction-runtime';
import { isEntityReplicaRelevantToWatcher } from './watcher';

export type WatcherLocalFrontier = {
  replicaKey: string;
  replica: EntityReplica;
  height: number;
  hash: string;
};

export type WatcherCanonicalAudit = {
  relevantReplicaEntries: Array<[string, EntityReplica]>;
  relevantReplicas: EntityReplica[];
  finalizedAnchors: Map<number, string>;
  localFrontiers: WatcherLocalFrontier[];
  auditHeights: number[];
};

export type WatcherTargetedRewind = {
  height: number;
  canonicalHash: string;
  replicaKeys: string[];
};

export const collectWatcherCanonicalAudit = (
  state: RuntimeReplica,
  watcherReplica: JReplica,
  lastSyncedBlock: number,
): WatcherCanonicalAudit => {
  const relevantReplicaEntries = [...state.state.eReplicas.entries()].filter(
    ([, replica]) =>
      isEntityReplicaRelevantToWatcher(state, replica, watcherReplica),
  );
  const relevantReplicas = relevantReplicaEntries.map(([, replica]) => replica);
  const finalizedAnchors = new Map<number, string>();
  for (const replica of relevantReplicas) {
    const anchor = getEntityCertifiedJAnchor(replica.state);
    if (!anchor) continue;
    const existing = finalizedAnchors.get(anchor.height);
    if (existing && existing !== anchor.hash) {
      throw new Error(
        `J_HISTORY_FINALIZED_ANCHOR_DIVERGENCE:height=${anchor.height}`,
      );
    }
    finalizedAnchors.set(anchor.height, anchor.hash);
  }
  const localFrontiers = relevantReplicaEntries.flatMap(
    ([replicaKey, replica]) => {
      if (!replica.jHistory) return [];
      const height = Number(replica.jHistory.scannedThroughHeight);
      const hash = getValidatorJExpectedBlockHash(
        replica.state,
        replica.jHistory,
        height,
      );
      if (!hash) {
        throw new Error(`J_HISTORY_LOCAL_TIP_UNKNOWN:${replicaKey}:${height}`);
      }
      return [{ replicaKey, replica, height, hash }];
    },
  );
  return {
    relevantReplicaEntries,
    relevantReplicas,
    finalizedAnchors,
    localFrontiers,
    auditHeights: [
      ...new Set([
        lastSyncedBlock,
        ...finalizedAnchors.keys(),
        ...localFrontiers.map(frontier => frontier.height),
      ]),
    ].sort((left, right) => left - right),
  };
};

export const assertFinalizedWatcherAnchors = (
  audit: WatcherCanonicalAudit,
  canonicalHeaders: ReadonlyMap<number, string>,
  chainId: number,
): void => {
  for (const [height, expectedHash] of audit.finalizedAnchors) {
    const canonicalHash = canonicalHeaders.get(height);
    if (!canonicalHash) {
      throw new Error(`J_HISTORY_HEADER_MISSING:height=${height}`);
    }
    if (expectedHash === canonicalHash) continue;
    const owners = audit.relevantReplicas
      .filter(
        replica =>
          getEntityCertifiedJAnchor(replica.state)?.height === height,
      )
      .map(replica => {
        const entityId = String(
          replica.entityId || replica.state.entityId || '',
        ).slice(0, 10);
        const jurisdiction = replica.state.config.jurisdiction;
        return `${entityId}/${String(jurisdiction?.name || 'unnamed')}/${String(
          jurisdiction?.chainId ?? 'missing',
        )}`;
      })
      .join(',');
    throw new Error(
      `J_HISTORY_FINALIZED_REORG:${height}:chain=${chainId}` +
        `:owners=${owners || 'unknown'}` +
        `:expected=${expectedHash}:canonical=${canonicalHash}`,
    );
  }
};

export const collectTargetedWatcherRewinds = (
  audit: WatcherCanonicalAudit,
  canonicalHeaders: ReadonlyMap<number, string>,
  chainId: number,
): Map<string, WatcherTargetedRewind> => {
  const rewinds = new Map<string, WatcherTargetedRewind>();
  for (const frontier of audit.localFrontiers) {
    const canonicalHash = canonicalHeaders.get(frontier.height);
    if (!canonicalHash) {
      throw new Error(`J_HISTORY_HEADER_MISSING:height=${frontier.height}`);
    }
    if (frontier.hash === canonicalHash) continue;
    const certifiedAnchor = getEntityCertifiedJAnchor(frontier.replica.state);
    if (certifiedAnchor?.height === frontier.height) {
      throw new Error(
        `J_HISTORY_FINALIZED_REORG:${frontier.height}:chain=${chainId}` +
          `:expected=${certifiedAnchor.hash}:canonical=${canonicalHash}`,
      );
    }
    const key = `${frontier.height}:${canonicalHash}`;
    const group = rewinds.get(key) ?? {
      height: frontier.height,
      canonicalHash,
      replicaKeys: [],
    };
    group.replicaKeys.push(frontier.replicaKey);
    rewinds.set(key, group);
  }
  return rewinds;
};
