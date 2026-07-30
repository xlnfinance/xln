import { LIMITS } from '../config/constants';
import {
  FinancialDataCorruptionError,
  validateMapInstance,
} from '../protocol/validation-primitives';

export const validateEntityAccountMetadata = (
  entity: Record<string, unknown>,
  context: string,
): void => {
  if (entity['deferredAccountProposals'] === undefined) return;
  const deferred = validateMapInstance(
    entity['deferredAccountProposals'],
    `${context}.deferredAccountProposals`,
  );
  if (deferred.size > LIMITS.MAX_ACCOUNTS_PER_ENTITY) {
    throw new FinancialDataCorruptionError(
      `${context}.deferredAccountProposals exceeds ${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
    );
  }
  const accounts = validateMapInstance(entity['accounts'], `${context}.accounts`);
  for (const [rawAccountId, rawWorkspaceHash] of deferred) {
    const accountId = String(rawAccountId ?? '');
    const workspaceHash = String(rawWorkspaceHash ?? '');
    if (!/^0x[0-9a-f]{64}$/.test(accountId) || accountId !== rawAccountId) {
      throw new FinancialDataCorruptionError(
        `${context}.deferredAccountProposals account invalid`,
      );
    }
    if (!accounts.has(accountId)) {
      throw new FinancialDataCorruptionError(
        `${context}.deferredAccountProposals account missing`,
      );
    }
    if (
      !/^0x[0-9a-f]{64}$/.test(workspaceHash) ||
      workspaceHash !== rawWorkspaceHash
    ) {
      throw new FinancialDataCorruptionError(
        `${context}.deferredAccountProposals workspace hash invalid`,
      );
    }
  }
};
