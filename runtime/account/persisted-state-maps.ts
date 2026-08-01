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
  persistedUint16,
  persistedUint256,
} from './persisted-value-primitives';

const validateLock = (key: unknown, value: unknown, context: string): void => {
  const lock = persistedRecord(value, [
    'lockId', 'hashlock', 'timelock', 'revealBeforeHeight', 'amount', 'tokenId',
    'senderIsLeft', 'createdHeight', 'createdTimestamp',
  ], ['envelopeHash', 'secretOffer'], context);
  const lockId = persistedString(lock['lockId'], `${context}.lockId`, 256);
  if (key !== lockId) throw new Error(`${context}.lockId must match its Map key`);
  persistedBytes32(lock['hashlock'], `${context}.hashlock`);
  persistedUint256(lock['timelock'], `${context}.timelock`);
  persistedUint(lock['revealBeforeHeight'], `${context}.revealBeforeHeight`);
  persistedBigInt(lock['amount'], `${context}.amount`, 1n, FINANCIAL.MAX_PAYMENT_AMOUNT);
  persistedTokenId(lock['tokenId'], `${context}.tokenId`);
  persistedBoolean(lock['senderIsLeft'], `${context}.senderIsLeft`);
  persistedUint(lock['createdHeight'], `${context}.createdHeight`);
  persistedUint(lock['createdTimestamp'], `${context}.createdTimestamp`);
  persistedOptional(lock['envelopeHash'], item => persistedBytes32(item, `${context}.envelopeHash`));
  persistedOptional(lock['secretOffer'], item => assertExactMultiRecipientCiphertextSchema(item));
};

const validatePull = (key: unknown, value: unknown, context: string): void => {
  const pull = persistedRecord(value, [
    'pullId', 'tokenId', 'amount', 'revealedUntilTimestamp', 'fullHash',
    'partialRoot', 'createdHeight', 'createdTimestamp',
  ], ['claimedRatio', 'claimedAmount', 'crossJurisdiction'], context);
  const pullId = persistedString(pull['pullId'], `${context}.pullId`, 256);
  if (key !== pullId || pullId.includes(':')) throw new Error(`${context}.pullId must match its bounded Map key`);
  persistedTokenId(pull['tokenId'], `${context}.tokenId`);
  persistedBigInt(
    pull['amount'],
    `${context}.amount`,
    -FINANCIAL.MAX_PAYMENT_AMOUNT,
    FINANCIAL.MAX_PAYMENT_AMOUNT,
  );
  if (pull['amount'] === 0n) throw new Error(`${context}.amount must be non-zero`);
  persistedUint(pull['revealedUntilTimestamp'], `${context}.revealedUntilTimestamp`);
  persistedBytes32(pull['fullHash'], `${context}.fullHash`);
  persistedBytes32(pull['partialRoot'], `${context}.partialRoot`);
  persistedUint(pull['createdHeight'], `${context}.createdHeight`);
  persistedUint(pull['createdTimestamp'], `${context}.createdTimestamp`);
  persistedOptional(pull['claimedRatio'], item => persistedUint16(item, `${context}.claimedRatio`));
  persistedOptional(
    pull['claimedAmount'],
    item => persistedBigInt(item, `${context}.claimedAmount`, 0n, FINANCIAL.MAX_PAYMENT_AMOUNT),
  );
  if (pull['crossJurisdiction'] !== undefined) {
    const binding = persistedRecord(pull['crossJurisdiction'], [
      'orderId', 'routeHash', 'leg',
    ], [
      'sourceCloseProof', 'status', 'cumulativeFillRatio', 'fillNumerator',
      'fillDenominator', 'claimedRatio', 'filledSourceAmount', 'filledTargetAmount',
      'sourceClaimed', 'targetClaimed', 'clearingPolicy',
    ], `${context}.crossJurisdiction`);
    persistedString(binding['orderId'], `${context}.crossJurisdiction.orderId`, 256);
    persistedBytes32(binding['routeHash'], `${context}.crossJurisdiction.routeHash`);
    if (binding['leg'] !== 'source' && binding['leg'] !== 'target') {
      throw new Error(`${context}.crossJurisdiction.leg is invalid`);
    }
  }
};

const validateOffer = (key: unknown, value: unknown, context: string): void => {
  const offer = persistedRecord(value, [
    'offerId', 'giveTokenId', 'giveAmount', 'wantTokenId', 'wantAmount',
    'makerIsLeft', 'createdHeight',
  ], [
    'priceTicks', 'timeInForce', 'quantizedGive', 'quantizedWant',
    'crossJurisdiction',
  ], context);
  const offerId = persistedString(offer['offerId'], `${context}.offerId`, 256);
  if (key !== offerId || offerId.includes(':')) throw new Error(`${context}.offerId must match its bounded Map key`);
  persistedTokenId(offer['giveTokenId'], `${context}.giveTokenId`);
  persistedTokenId(offer['wantTokenId'], `${context}.wantTokenId`);
  persistedBigInt(offer['giveAmount'], `${context}.giveAmount`, 1n, FINANCIAL.MAX_PAYMENT_AMOUNT);
  persistedBigInt(offer['wantAmount'], `${context}.wantAmount`, 1n, FINANCIAL.MAX_PAYMENT_AMOUNT);
  persistedBoolean(offer['makerIsLeft'], `${context}.makerIsLeft`);
  persistedUint(offer['createdHeight'], `${context}.createdHeight`);
  persistedOptional(offer['priceTicks'], item => persistedUint256(item, `${context}.priceTicks`));
  persistedOptional(offer['timeInForce'], item => {
    if (item !== 0 && item !== 1 && item !== 2) throw new Error(`${context}.timeInForce is invalid`);
  });
  for (const field of ['quantizedGive', 'quantizedWant'] as const) {
    persistedOptional(offer[field], item => persistedBigInt(item, `${context}.${field}`, 1n, FINANCIAL.MAX_PAYMENT_AMOUNT));
  }
  if (offer['crossJurisdiction'] !== undefined) {
    const route = persistedRecord(offer['crossJurisdiction'], [
      'orderId', 'makerEntityId', 'hubEntityId', 'source', 'target', 'status',
      'createdAt', 'updatedAt',
    ], [
      'routeHash', 'bookOwnerEntityId', 'venueId', 'sourceSignerId',
      'sourceHubSignerId', 'targetHubSignerId', 'targetSignerId', 'bookHubSignerId',
      'sourcePull', 'targetPull', 'sourceCloseProof', 'targetCloseProof', 'priceTicks',
      'fillSeq', 'cumulativeFillRatio', 'fillNumerator', 'fillDenominator',
      'filledSourceAmount', 'filledTargetAmount', 'priceImprovementSourceAmount',
      'pendingClearRequestedAt', 'domain', 'settlementPolicy', 'timePolicy',
      'clearingPolicy', 'priceImprovementMode', 'riskMode', 'claimedRatio',
      'sourceClaimed', 'targetClaimed', 'expiresAt', 'settledAt', 'error', 'memo',
    ], `${context}.crossJurisdiction`);
    if (route['orderId'] !== offerId) throw new Error(`${context}.crossJurisdiction.orderId mismatch`);
    persistedOptional(route['routeHash'], item => persistedBytes32(item, `${context}.crossJurisdiction.routeHash`));
  }
};

const validateSubcontract = (key: unknown, value: unknown, context: string, deltaCount: number): void => {
  persistedString(key, `${context}.key`, 256);
  const subcontract = persistedRecord(value, [
    'transformerAddress', 'encodedBatch', 'allowances',
  ], ['leftArgumentsHash', 'rightArgumentsHash'], context);
  persistedAddress(subcontract['transformerAddress'], `${context}.transformerAddress`);
  persistedHex(subcontract['encodedBatch'], `${context}.encodedBatch`);
  const allowances = persistedArray(subcontract['allowances'], `${context}.allowances`, deltaCount);
  let previousIndex = -1;
  allowances.forEach((raw, index) => {
    const allowance = persistedRecord(raw, [
      'deltaIndex', 'rightAllowance', 'leftAllowance',
    ], [], `${context}.allowances[${index}]`);
    const deltaIndex = persistedUint(allowance['deltaIndex'], `${context}.allowances[${index}].deltaIndex`);
    if (deltaIndex >= deltaCount || deltaIndex <= previousIndex) {
      throw new Error(`${context}.allowances must use sorted unique in-range deltaIndex values`);
    }
    previousIndex = deltaIndex;
    persistedUint256(allowance['rightAllowance'], `${context}.allowances[${index}].rightAllowance`);
    persistedUint256(allowance['leftAllowance'], `${context}.allowances[${index}].leftAllowance`);
  });
  for (const field of ['leftArgumentsHash', 'rightArgumentsHash'] as const) {
    persistedOptional(subcontract[field], item => persistedBytes32(item, `${context}.${field}`));
  }
};

export const validatePersistedAccountStateMaps = (
  state: Record<string, unknown>,
  context: string,
): void => {
  const locks = persistedMap(state['locks'], `${context}.locks`, LIMITS.MAX_ACCOUNT_HTLC_LOCKS);
  for (const [key, value] of locks) validateLock(key, value, `${context}.locks[${String(key)}]`);
  if (state['pulls'] !== undefined) {
    const pulls = persistedMap(state['pulls'], `${context}.pulls`, LIMITS.MAX_ACCOUNT_SWAP_OFFERS);
    for (const [key, value] of pulls) validatePull(key, value, `${context}.pulls[${String(key)}]`);
  }
  const offers = persistedMap(state['swapOffers'], `${context}.swapOffers`, LIMITS.MAX_ACCOUNT_SWAP_OFFERS);
  for (const [key, value] of offers) validateOffer(key, value, `${context}.swapOffers[${String(key)}]`);
  if (state['subcontracts'] !== undefined) {
    const deltas = state['deltas'] as AccountState['deltas'];
    const subcontracts = persistedMap(state['subcontracts'], `${context}.subcontracts`, 32);
    for (const [key, value] of subcontracts) {
      validateSubcontract(key, value, `${context}.subcontracts[${String(key)}]`, deltas.size);
    }
  }
};
