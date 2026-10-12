import type { RuntimeRecoveryCandidate } from '@xln/core/storage/recovery/discovery/types';
import type { XLNModule, RuntimeReplica } from '@xln/core/api/public/runtime-module';
import { runtimeIdForSeed } from './keys';
import { defaultTowerUrl, normalizeTowerUrl } from './recovery';
import { getXLN } from './xln-loader';
import { recoveryDiscoveryError } from './recovery-failure';
import { hasLocalWalletData } from './local-wallet-data';

export type { RuntimeRecoveryCandidate };

export async function discoverFileRestore(seed: string, file: File): Promise<RuntimeRecoveryCandidate> {
	await requireFreshDevice(runtimeIdForSeed(seed).toLowerCase());
	const xln = await getXLN();
	return xln.parseRuntimeRecoveryCandidateFile(seed, await file.text(), { sourceLabel: file.name, crypto: xln });
}

export async function discoverTowerRestore(seed: string, address: string, signal?: AbortSignal): Promise<RuntimeRecoveryCandidate> {
	signal?.throwIfAborted();
	await requireFreshDevice(runtimeIdForSeed(seed).toLowerCase());
	const url = normalizeTowerUrl(address || defaultTowerUrl());
	if (!url) throw new Error('Enter the address of the tower holding your backup.');
	const xln = await getXLN();
	const result = await xln.discoverRuntimeRecoveryCandidates(seed, {
		towers: [{ url }], crypto: xln, pageUrl: window.location.href, signal,
	});
	const candidate = result.candidates[0];
	if (!candidate) throw recoveryDiscoveryError(result);
	return candidate;
}

/** Any existing record blocks recovery, including incomplete local data. */
async function requireFreshDevice(runtimeId: string): Promise<void> {
	if (await hasLocalWalletData(runtimeId)) {
		throw new Error('This device already has data for this wallet. Unlock it normally; restore on a clean browser profile or device.');
	}
}

export async function restoreFreshRuntime(xln: XLNModule, seed: string, candidate: RuntimeRecoveryCandidate): Promise<RuntimeReplica> {
	const runtimeId = runtimeIdForSeed(seed).toLowerCase();
	if (candidate.runtimeId.toLowerCase() !== runtimeId) throw new Error('Recovery belongs to a different wallet.');
	await requireFreshDevice(runtimeId);
	const recording = xln.buildRuntimeRecording(candidate.bundles);
	if (recording.targetHeight !== candidate.runtimeHeight) throw new Error('Recovery archive does not cover the selected height.');
	const env = await xln.importRuntimeRecoveryRecording(recording, seed);
	xln.resumeRuntimeAfterPersistenceQuiesce(env);
	return env;
}
