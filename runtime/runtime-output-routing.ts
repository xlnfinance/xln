import type { RoutedEntityInput } from './types';
import { signatureMapSize } from './consensus-signatures';
import { txFingerprint } from './state-helpers';

export const buildRouteOutputKey = (output: RoutedEntityInput): string => {
  const txPart = (output.entityTxs || [])
    .map(tx => txFingerprint(tx))
    .join('|');
  return `${output.entityId}:${output.signerId || ''}:${txPart}`;
};

export const carriesEntityCommitNotification = (output: RoutedEntityInput): boolean =>
  signatureMapSize(output.proposedFrame?.collectedSigs) > 0;

export const mergeRoutedEntityOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T => {
  if (incoming.entityTxs?.length) {
    existing.entityTxs = [...(existing.entityTxs || []), ...incoming.entityTxs];
  }
  if (incoming.hashPrecommits) {
    const mergedPrecommits = existing.hashPrecommits || new Map<string, string[]>();
    incoming.hashPrecommits.forEach((sigs, signerId) => {
      mergedPrecommits.set(signerId, sigs);
    });
    existing.hashPrecommits = mergedPrecommits;
  }
  if (incoming.proposedFrame) {
    const existingIsCommit = carriesEntityCommitNotification(existing);
    const incomingIsCommit = carriesEntityCommitNotification(incoming);
    if (!existing.proposedFrame || incomingIsCommit || !existingIsCommit) {
      existing.proposedFrame = incoming.proposedFrame;
    }
  }
  return existing;
};
