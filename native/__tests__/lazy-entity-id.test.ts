import { describe, expect, test } from 'bun:test';
import { generateLazyEntityIdPreview } from '../../frontend/src/lib/utils/lazyEntityId';
import { generateLazyEntityId } from '../../runtime/entity-factory';

describe('frontend lazy entity id preview', () => {
	test('matches runtime board-hash generation for address validators', () => {
		const alice = '0x1111111111111111111111111111111111111111';
		const bob = '0x2222222222222222222222222222222222222222';

		expect(generateLazyEntityIdPreview([alice], 1n)).toBe(generateLazyEntityId([alice], 1n));
		expect(generateLazyEntityIdPreview([
			{ name: bob, weight: 2 },
			{ name: alice, weight: 1 },
		], 2n)).toBe(generateLazyEntityId([
			{ name: bob, weight: 2 },
			{ name: alice, weight: 1 },
		], 2n));
	});
});
