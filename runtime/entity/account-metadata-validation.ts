import { LIMITS } from '../constants';
import {
  FinancialDataCorruptionError,
  validateMapInstance,
} from '../protocol/validation-primitives';

const validateHtlcNotes = (value: unknown, context: string): void => {
  if (value === undefined) return;
  const notes = validateMapInstance(value, `${context}.htlcNotes`);
  if (notes.size > LIMITS.MAX_ENTITY_HTLC_NOTES) {
    throw new FinancialDataCorruptionError(
      `ENTITY_HTLC_NOTE_LIMIT_EXCEEDED:${context}:size=${notes.size}:max=${LIMITS.MAX_ENTITY_HTLC_NOTES}`,
    );
  }
  for (const [key, note] of notes) {
    if (
      typeof key !== 'string' ||
      key.length > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH ||
      (!key.startsWith('hashlock:') && !key.startsWith('lock:')) ||
      key.endsWith(':')
    ) {
      throw new FinancialDataCorruptionError(
        `${context}.htlcNotes contains invalid key`,
      );
    }
    if (
      typeof note !== 'string' ||
      note.length === 0 ||
      note.length > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH
    ) {
      throw new FinancialDataCorruptionError(
        `${context}.htlcNotes contains invalid note`,
      );
    }
  }
};

export const validateEntityAccountMetadata = (
  entity: Record<string, unknown>,
  context: string,
): void => {
  validateHtlcNotes(entity['htlcNotes'], context);
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
