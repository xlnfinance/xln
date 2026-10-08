import { expect, test } from 'bun:test';
import vector from '../../../../rscore/fixtures/native-tron-receipts-v1.json';
import { isSolidifiedRegistrationReceipt, parseTronRegistrationBlockHeader } from '../../../runtime/registration/numbered/numbered-registration-intent';

// Captured from a real native TVM deployment, not an EVM stand. Mutations model
// a receipt disappearing or belonging to a different branch before solidity.
const firstReceipt = vector.receipts.result[0];
if (!firstReceipt) throw new Error('TRON_REGISTRATION_FINALITY_FIXTURE_RECEIPT_MISSING');
const receipt = {
  blockNumber: Number(firstReceipt.blockNumber),
  blockHash: firstReceipt.blockHash,
};
const block = { number: Number(vector.block.result.number), hash: vector.block.result.hash };

test('TRON registration outcome requires the current receipt on the solid canonical block', () => {
  expect(isSolidifiedRegistrationReceipt(receipt, block, block.number)).toBe(true);
  expect(isSolidifiedRegistrationReceipt(receipt, block, block.number - 1)).toBe(false);
  expect(isSolidifiedRegistrationReceipt(null, block, block.number + 1)).toBe(false);
  expect(isSolidifiedRegistrationReceipt(receipt, null, block.number + 1)).toBe(false);
  expect(isSolidifiedRegistrationReceipt(receipt, { ...block, hash: `0x${'ab'.repeat(32)}` }, block.number + 1)).toBe(false);
  expect(isSolidifiedRegistrationReceipt(receipt, { ...block, number: block.number + 1 }, block.number + 1)).toBe(false);
});

test('native TVM registration reads canonical hash without requiring an EVM state root', () => {
  expect(parseTronRegistrationBlockHeader({ ...vector.block.result, stateRoot: '0x' })).toEqual(block);
  expect(parseTronRegistrationBlockHeader(null)).toBeNull();
  expect(() => parseTronRegistrationBlockHeader({ ...vector.block.result, hash: '0x' })).toThrow('TRON_REGISTRATION_BLOCK_HEADER_INVALID');
});
