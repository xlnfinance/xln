import { expect, test } from 'bun:test';
import { deriveBrainvaultMnemonic, FACTOR_PRESETS } from './brainvault';

// Frozen V1 vectors (brainvault/tests/data/vectors-v1.json): the React wallet must
// recover the exact wallet the CLI and native backend derive.
const VECTORS = (await Bun.file(new URL('../../../brainvault/tests/data/vectors-v1.json', import.meta.url)).json()) as {
	vectors: Array<{ id: string; input: { name: string; passphrase: string; shardCount: number; factor: number }; expected: { mnemonic24: string } }>;
};

// One single-shard and one ten-shard vector cover both shard-collector paths.
for (const shardCount of [1, 10]) {
	const vector = VECTORS.vectors.find(entry => entry.input.shardCount === shardCount)!;
	test(`browser-worker derivation matches frozen vector ${vector.id}`, async () => {
		const work = FACTOR_PRESETS.find(preset => preset.factor === vector.input.factor && preset.shardCount === vector.input.shardCount)!;
		const result = await deriveBrainvaultMnemonic(vector.input.name, vector.input.passphrase, work);
		expect(result.mnemonic).toBe(vector.expected.mnemonic24);
	}, 120_000);
}
