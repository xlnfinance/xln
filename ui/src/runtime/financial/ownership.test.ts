import { describe, expect, test } from 'bun:test';
import { takeoverActivationReady, type TakeoverStatus } from './ownership-activation';

const pending: TakeoverStatus = {
	targetEntityId: `0x${'3'.repeat(64)}`,
	currentBoardHash: `0x${'1'.repeat(64)}`,
	proposedBoardHash: `0x${'2'.repeat(64)}`,
	currentUnix: 1_800_000_000n,
	activateAt: 1_800_000_001n,
};

describe('CONTROL activation deadline in chain seconds', () => {
	test('waits before the deadline and permits activation at the deadline', () => {
		expect(takeoverActivationReady(pending)).toBe(false);
		expect(takeoverActivationReady({ ...pending, currentUnix: pending.activateAt })).toBe(true);
	});
	test('requires a pending proposal even after a deadline has elapsed', () => {
		expect(takeoverActivationReady(null)).toBe(false);
		expect(takeoverActivationReady({ ...pending, currentUnix: pending.activateAt, proposedBoardHash: `0x${'0'.repeat(64)}` })).toBe(false);
		expect(takeoverActivationReady({ ...pending, activateAt: 0n })).toBe(false);
	});
});
