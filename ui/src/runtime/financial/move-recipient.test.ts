import { expect, test } from 'bun:test';
import { buildMoveTxs, normalizeMoveRecipient, validateMove, type MoveIntent } from './move';

const tron = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';
const hex = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const self = `0x${'11'.repeat(32)}`;

const intent = (externalRecipient: string): MoveIntent => ({
	from: 'reserve',
	to: 'external',
	tokenId: 1,
	amount: 5n,
	sourceAccountId: '',
	targetEntityId: '',
	targetHubId: '',
	reserveRecipientId: '',
	externalRecipient,
	tokenAddress: '',
});
const check = (externalRecipient: string): string | null =>
	validateMove({ intent: intent(externalRecipient), mode: 'now', self, selfSigner: hex, available: 10n, awaiting: false, sentBatch: false, allowance: null });

test('a TRON Base58 recipient normalized at the canonical boundary pays the same 20-byte EOA as its hex form', () => {
	const recipient = normalizeMoveRecipient(tron, 'tron');
	expect(check(recipient)).toBeNull();
	expect(buildMoveTxs(self, intent(recipient), 'now')).toEqual(buildMoveTxs(self, intent(hex), 'now'));
});

test('without a TRON J-adapter, Base58 is rejected rather than reinterpreted', () => {
	expect(normalizeMoveRecipient(` ${tron} `, 'rpc')).toBe(tron);
	expect(check(normalizeMoveRecipient(tron, undefined))).toBe('That is not a valid wallet address');
	expect(normalizeMoveRecipient(hex.toUpperCase().replace('0X', '0x'), undefined)).toBe(hex);
});
