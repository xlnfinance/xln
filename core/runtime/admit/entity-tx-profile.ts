import { entityTxAdmissionError } from '../../entity/tx/processing/admission-policy';
import { createStructuredLogger } from '../../support/logger';
import type { RoutedEntityInput } from '../types';
import type { RejectedEntityIngressEvidence } from '../frame/intake/discard';

const admissionLog = createStructuredLogger('runtime.entity_inputs');

/**
 * Filter unavailable raw commands before merge/signing joins a signer's queue
 * into a command. Otherwise one deferred action can discard unrelated work.
 * Signed commands and proposals retain their exact bytes and atomicity; the
 * Entity reducer rejects their unavailable actions after authentication.
 */
export const admitEntityTxProfiles = (
  inputs: readonly RoutedEntityInput[],
): {
  inputs: RoutedEntityInput[];
  rejected: RejectedEntityIngressEvidence[];
} => {
  const rejected: RejectedEntityIngressEvidence[] = [];
  const admitted = inputs.map(input => {
    if (!input.entityTxs) return input;
    const entityTxs = input.entityTxs.filter(tx => {
      const error = entityTxAdmissionError(tx);
      if (!error) return true;
      const evidence: RejectedEntityIngressEvidence = {
        origin: input.from ? 'remote' : 'local',
        entityId: input.entityId,
        signerId: input.signerId,
        sourceRuntimeId: input.from,
        rejectionCode: error.message,
        txType: tx.type,
      };
      rejected.push(evidence);
      admissionLog.error('entity_input.rejected', evidence);
      return false;
    });
    return entityTxs.length === input.entityTxs.length ? input : { ...input, entityTxs };
  });
  return { inputs: admitted, rejected };
};
