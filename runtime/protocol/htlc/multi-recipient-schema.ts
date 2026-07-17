import type { MultiRecipientCiphertext } from './multi-recipient';

const schemaError = (path: string): Error =>
  new Error(`HTLC_MULTI_RECIPIENT_SCHEMA_INVALID: path=${path}`);

const assertRecord: (
  value: unknown,
  keys: readonly string[],
  path: string,
) => asserts value is Record<string, unknown> = (value, keys, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw schemaError(path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw schemaError(path);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw schemaError(path);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw schemaError(path);
  }
};

const assertStrings = (value: Record<string, unknown>, keys: readonly string[], path: string): void => {
  if (keys.some((key) => typeof value[key] !== 'string')) throw schemaError(path);
};

const assertArray: (value: unknown, path: string) => asserts value is unknown[] = (value, path) => {
  if (!Array.isArray(value)) throw schemaError(path);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== value.length + 1
    || !ownKeys.includes('length')
  ) {
    throw schemaError(path);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) throw schemaError(path);
  }
};

export const assertExactMultiRecipientCiphertextSchema: (
  value: unknown,
) => asserts value is MultiRecipientCiphertext = (value) => {
  assertRecord(
    value,
    ['version', 'manifest', 'profileCertification', 'contextHash', 'nonce', 'ciphertext', 'recipients'],
    'ciphertext',
  );
  assertStrings(value, ['version', 'contextHash', 'nonce', 'ciphertext'], 'ciphertext');

  const manifest = value['manifest'];
  assertRecord(manifest, ['entityId', 'threshold', 'attestations', 'hash'], 'manifest');
  assertStrings(manifest, ['entityId', 'hash'], 'manifest');
  if (typeof manifest['threshold'] !== 'number') throw schemaError('manifest');
  assertArray(manifest['attestations'], 'manifest.attestations');
  manifest['attestations'].forEach((attestation, index) => {
    const path = `manifest.attestations[${index}]`;
    assertRecord(
      attestation,
      ['version', 'entityId', 'signerId', 'signer', 'publicKey', 'weight', 'encryptionPublicKey', 'signature'],
      path,
    );
    assertStrings(
      attestation,
      ['version', 'entityId', 'signerId', 'signer', 'publicKey', 'encryptionPublicKey', 'signature'],
      path,
    );
    if (typeof attestation['weight'] !== 'number') throw schemaError(path);
  });

  const certification = value['profileCertification'];
  assertRecord(certification, ['profileHash', 'routingStateHash', 'hanko'], 'profileCertification');
  assertStrings(certification, ['profileHash', 'routingStateHash', 'hanko'], 'profileCertification');

  const recipients = value['recipients'];
  assertArray(recipients, 'recipients');
  recipients.forEach((recipient, index) => {
    const path = `recipients[${index}]`;
    assertRecord(recipient, ['signerId', 'encryptionPublicKey', 'wrappedKey'], path);
    assertStrings(recipient, ['signerId', 'encryptionPublicKey', 'wrappedKey'], path);
  });
};
