import {
	BRAINVAULT_V1,
	BRAINVAULT_V1_SPEC_ID,
	combineShards,
	deriveKey,
	entropyToMnemonic,
	factorForShardCount,
	getShardCount,
	validateInputs,
} from '../../../brainvault/src/core/index.ts';
import { shardRequestFingerprint } from '../../../brainvault/src/core/primitives/spec.ts';
import { acceptShard, createShardSlots, finalizeShards } from '../../../brainvault/src/native/shard-collector.ts';

export type BrainvaultWork = {
	factor: number;
	shardCount: number;
	tier: string;
};

export const FACTOR_PRESETS: readonly BrainvaultWork[] = [
	{ factor: 1, shardCount: 1, tier: 'Test' },
	{ factor: 2, shardCount: 10, tier: 'Basic' },
	{ factor: 3, shardCount: 100, tier: 'Standard' },
	{ factor: 4, shardCount: 1000, tier: 'Strong' },
	{ factor: 5, shardCount: 10000, tier: 'Maximum' },
];

/** Custom shard counts (≥6) map to a factor exactly like the canonical CLI. */
export function customWork(shardCount: number): BrainvaultWork {
	if (!Number.isSafeInteger(shardCount) || shardCount < 6) {
		throw new Error('Custom work needs at least 6 shards');
	}
	return { factor: factorForShardCount(shardCount), shardCount, tier: 'Custom' };
}

export type BrainvaultProgress = {
	completed: number;
	total: number;
	elapsedMs: number;
	lastShardMs: number;
	workers: number;
};

export type BrainvaultResult = {
	mnemonic: string;
	factor: number;
	shardCount: number;
	derivationTimeMs: number;
};

type WorkerMessage = {
	type: 'ready' | 'probe_result' | 'shard_complete' | 'error';
	id: number;
	data: Record<string, unknown>;
};

function createBrainvaultWorker(): Worker {
	return new Worker(new URL('../../../brainvault/src/native/workers/browser.ts', import.meta.url), { type: 'module' });
}

/**
 * Derive the canonical BrainVault V1 24-word mnemonic in browser workers.
 *
 * Same shard/combine/`bip39/entropy/v1.0` pipeline the CLI and the native
 * node backend use — identical inputs recover the identical wallet anywhere.
 */
export async function deriveBrainvaultMnemonic(
	name: string,
	passphrase: string,
	work: BrainvaultWork,
	onProgress?: (progress: BrainvaultProgress) => void,
	signal?: AbortSignal,
): Promise<BrainvaultResult> {
	const { factor, shardCount } = work;
	const validation = validateInputs(name, passphrase, factor);
	if (!validation.valid) throw new Error(validation.errors.join('; '));
	if (work.tier !== 'Custom' && shardCount !== getShardCount(factor)) {
		throw new Error(`BRAINVAULT_PRESET_SHARDS_MISMATCH:${factor}:${shardCount}`);
	}
	const workerCount = Math.max(1, Math.min(navigator.hardwareConcurrency ? navigator.hardwareConcurrency - 1 : 2, shardCount, 4));
	const startedAt = performance.now();

	const shards = createShardSlots(shardCount);
	let completed = 0;
	let nextShard = 0;
	let messageSeq = 0;

	const workers: Worker[] = [];
	const terminateAll = (): void => {
		for (const worker of workers) worker.terminate();
	};

	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			const succeed = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};

			if (signal) {
				if (signal.aborted) return fail(new Error('BRAINVAULT_ABORTED'));
				signal.addEventListener('abort', () => fail(new Error('BRAINVAULT_ABORTED')), { once: true });
			}

			const dispatch = (worker: Worker): void => {
				if (nextShard >= shardCount) return;
				const shardIndex = nextShard++;
				worker.postMessage({
					type: 'derive_shard',
					id: ++messageSeq,
					data: { name, passphrase, shardIndex, shardCount },
				});
			};

			for (let i = 0; i < workerCount; i++) {
				const worker = createBrainvaultWorker();
				workers.push(worker);
				worker.onerror = event => fail(new Error(event.message ? `BRAINVAULT_WORKER_ERROR: ${event.message}` : 'BRAINVAULT_WORKER_LOAD_FAILED'));
				worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
					const message = event.data;
					if (message.type === 'error') {
						return fail(new Error(String(message.data['message'] ?? 'BRAINVAULT_WORKER_FAILED')));
					}
					if (message.type === 'ready') {
						// A stale cached worker must fail loudly, never derive a different wallet.
						if (message.data['specId'] !== BRAINVAULT_V1_SPEC_ID) return fail(new Error('BRAINVAULT_WORKER_SPEC_MISMATCH'));
						return dispatch(worker);
					}
					if (message.type === 'shard_complete') {
						try {
							acceptShard(
								shards,
								{ specId: message.data['specId'], shardIndex: message.data['shardIndex'], requestId: message.data['requestId'], result: message.data['resultHex'] },
								BRAINVAULT_V1_SPEC_ID,
								BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
								index => shardRequestFingerprint(index, shardCount, BRAINVAULT_V1.ALG_ID, BRAINVAULT_V1.SHARD_MEMORY_KB),
							);
						} catch (error) {
							return fail(error instanceof Error ? error : new Error(String(error)));
						}
						completed += 1;
						onProgress?.({
							completed,
							total: shardCount,
							elapsedMs: performance.now() - startedAt,
							lastShardMs: Number(message.data['elapsedMs'] ?? 0),
							workers: workerCount,
						});
						if (completed >= shardCount) return succeed();
						return dispatch(worker);
					}
				};
				worker.postMessage({ type: 'init', id: ++messageSeq, data: {} });
			}
		});
		const masterKey = await combineShards(finalizeShards(shards), factor);
		try {
			const entropy = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
			try {
				const mnemonic = await entropyToMnemonic(entropy);
				return { mnemonic, factor, shardCount, derivationTimeMs: performance.now() - startedAt };
			} finally {
				entropy.fill(0);
			}
		} finally {
			masterKey.fill(0);
		}
	} finally {
		terminateAll();
		for (const shard of shards) shard?.fill(0);
	}
}
