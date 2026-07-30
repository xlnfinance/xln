import { LIMITS } from '../../config/constants';
import {
  FinancialDataCorruptionError,
  validateMapInstance,
} from '../../protocol/validation-primitives';

/**
 * Replica notes are uncommitted presentation metadata, but they still cross a
 * durable storage boundary. Validate them as strictly as consensus data so a
 * corrupt local index can never make restore behavior ambiguous.
 */
export const validateHtlcNotes = (value: unknown, context: string): void => {
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
