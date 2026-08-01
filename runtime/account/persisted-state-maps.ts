import { FINANCIAL, LIMITS } from '../config/constants';
import { assertExactMultiRecipientCiphertextSchema } from '../protocol/htlc/multi-recipient-schema';
import type { AccountState } from '../types/account';
import {
  persistedAddress,
  persistedArray,
  persistedBigInt,
  persistedBoolean,
  persistedBytes32,
  persistedHex,
  persistedMap,
  persistedOptional,
  persistedRecord,
  persistedString,
  persistedTokenId,
  persistedUint,
  persistedUint256,
} from './persisted-value-primitives';

const validateLock = (key: unknown, value: unknown, context: string): void => {
  const lock = persistedRecord(value, context);
  if (key !== persistedString(lock['lockId'], `${context}.lockId`, 256)) {
    throw new Error(`${context}.lockId must match its Map key`);
  }
  persistedBytes32(lock['hashlock'], `${context}.hashlock`);
  persistedUint256(lock['timelock'], `${context}.timelock`);
  persistedUint(lock['revealBeforeHeight'], `${context}.revealBeforeHeight`);
  persistedBigInt(lock['amount'], `${context}.amount`, 1n, FINANCIAL.MAX_PAYMENT_AMOUNT);
  persistedTokenId(lock['tokenId'], `${context}.tokenId`);
  persistedBoolean(lock['senderIsLeft'], `${context}.senderIsLeft`);
  persistedUint(lock['createdHeight'], `${context}.createdHeight`);
  persistedUint(lock['createdTimestamp'], `${context}.createdTimestamp`);
  persistedOptional(lock['envelopeHash'], item => persistedBytes32(item, `${context}.envelopeHash`));
  persistedOptional(lock['secretOffer'], assertExactMultiRecipientCiphertextSchema);
};

const validatePull = (key: unknown, value: unknown, context: string): void => {
  const pull = persistedRecord(value, context);
  const pullId = persistedString(pull['pullId'], `${context}.pullId`, 256);
  if (key !== pullId || pullId.includes(':')) throw new Error(`${context}.pullId does not match its bounded key`);
  persistedTokenId(pull['tokenId'], `${context}.tokenId`);
  const amount = persistedBigInt(
    pull['amount'], `${context}.amount`, -FINANCIAL.MAX_PAYMENT_AMOUNT, FINANCIAL.MAX_PAYMENT_AMOUNT,
  );
  if (amount === 0n) throw new Error(`${context}.amount must be non-zero`);
  persistedUint(pull['revealedUntilTimestamp'], `${context}.revealedUntilTimestamp`);
  persistedBytes32(pull['fullHash'], `${context}.fullHash`);
  persistedBytes32(pull['partialRoot'], `${context}.partialRoot`);
  persistedUint(pull['createdHeight'], `${context}.createdHeight`);
  persistedUint(pull['createdTimestamp'], `${context}.createdTimestamp`);
};

const validateOffer = (key: unknown, value: unknown, context: string): void => {
  const offer = persistedRecord(value, context);
  const offerId = persistedString(offer['offerId'], `${context}.offerId`, 256);
  if (key !== offerId || offerId.includes(':')) throw new Error(`${context}.offerId does not match its bounded key`);
  persistedTokenId(offer['giveTokenId'], `${context}.giveTokenId`);
  persistedTokenId(offer['wantTokenId'], `${context}.wantTokenId`);
  persistedBigInt(offer['giveAmount'], `${context}.giveAmount`, 1n, FINANCIAL.MAX_PAYMENT_AMOUNT);
  persistedBigInt(offer['wantAmount'], `${context}.wantAmount`, 1n, FINANCIAL.MAX_PAYMENT_AMOUNT);
  persistedBoolean(offer['makerIsLeft'], `${context}.makerIsLeft`);
  persistedUint(offer['createdHeight'], `${context}.createdHeight`);
};

const validateSubcontract = (
  key: unknown,
  value: unknown,
  deltaCount: number,
  context: string,
): void => {
  persistedString(key, `${context}.key`, 256);
  const subcontract = persistedRecord(value, context);
  persistedAddress(subcontract['transformerAddress'], `${context}.transformerAddress`);
  persistedHex(subcontract['encodedBatch'], `${context}.encodedBatch`);
  const allowances = persistedArray(subcontract['allowances'], `${context}.allowances`, deltaCount);
  let previous = -1;
  allowances.forEach((raw, index) => {
    const allowance = persistedRecord(raw, `${context}.allowances[${index}]`);
    const deltaIndex = persistedUint(allowance['deltaIndex'], `${context}.allowances[${index}].deltaIndex`);
    if (deltaIndex >= deltaCount || deltaIndex <= previous) {
      throw new Error(`${context}.allowances require sorted unique in-range indices`);
    }
    previous = deltaIndex;
    persistedUint256(allowance['rightAllowance'], `${context}.allowances[${index}].rightAllowance`);
    persistedUint256(allowance['leftAllowance'], `${context}.allowances[${index}].leftAllowance`);
  });
};

export const validatePersistedAccountStateMaps = (
  state: Record<string, unknown>,
  context: string,
): void => {
  const locks = persistedMap(state['locks'], `${context}.locks`, LIMITS.MAX_ACCOUNT_HTLC_LOCKS);
  for (const [key, value] of locks) validateLock(key, value, `${context}.locks[${String(key)}]`);
  const pulls = persistedMap(state['pulls'] ?? new Map(), `${context}.pulls`, LIMITS.MAX_ACCOUNT_SWAP_OFFERS);
  for (const [key, value] of pulls) validatePull(key, value, `${context}.pulls[${String(key)}]`);
  const offers = persistedMap(state['swapOffers'], `${context}.swapOffers`, LIMITS.MAX_ACCOUNT_SWAP_OFFERS);
  for (const [key, value] of offers) validateOffer(key, value, `${context}.swapOffers[${String(key)}]`);
  const subcontracts = persistedMap(state['subcontracts'] ?? new Map(), `${context}.subcontracts`, 32);
  const deltaCount = (state['deltas'] as AccountState['deltas']).size;
  for (const [key, value] of subcontracts) {
    validateSubcontract(key, value, deltaCount, `${context}.subcontracts[${String(key)}]`);
  }
};
