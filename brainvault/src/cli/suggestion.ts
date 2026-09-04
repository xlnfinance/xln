import { randomInt } from 'node:crypto';

export const SUGGESTED_PASSWORD_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const SUGGESTED_PASSWORD_CHARACTERS = 10;
export const SUGGESTED_PASSWORD_BITS = Math.log2(SUGGESTED_PASSWORD_ALPHABET.length)
  * SUGGESTED_PASSWORD_CHARACTERS;

export function passwordFromIndexes(indexes: readonly number[]): string {
  if (indexes.length !== SUGGESTED_PASSWORD_CHARACTERS) {
    throw new Error('BRAINVAULT_SUGGESTION_LENGTH_INVALID');
  }
  return indexes.map(index => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= SUGGESTED_PASSWORD_ALPHABET.length) {
      throw new Error(`BRAINVAULT_SUGGESTION_INDEX_INVALID:${index}`);
    }
    return SUGGESTED_PASSWORD_ALPHABET[index]!;
  }).join('');
}

export function generateSuggestedPassword(): string {
  return passwordFromIndexes(Array.from(
    { length: SUGGESTED_PASSWORD_CHARACTERS },
    () => randomInt(SUGGESTED_PASSWORD_ALPHABET.length),
  ));
}
