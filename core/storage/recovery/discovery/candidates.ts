import { decryptRuntimeRecoveryBundle } from '../bundle/crypto';
import { deriveRuntimeSignerAddress, normalizeRuntimeId } from '../bundle/seed-identity';
import { isRecord } from '../../../support/boundary-guards';
import type { EncryptedRuntimeRecoveryBundleV1, RuntimeRecoveryBundleV1, TowerReceiptV1 } from '../bundle/types';
import type {
  RuntimeRecoveryCandidate,
  RuntimeRecoveryCandidateSource,
  RuntimeRecoveryCryptoPort,
} from './types';

/**
 * Turning ciphertext back into a restorable candidate.
 *
 * Every bundle is opened with the seed and then checked against the Runtime id
 * the seed itself derives. A tower or peer that hands back somebody else's
 * bundle is a contradiction: it is rejected loudly instead of being restored
 * into this identity.
 */

const isEncryptedRuntimeRecoveryBundle = (value: unknown): value is EncryptedRuntimeRecoveryBundleV1 => {
  if (!isRecord(value)) return false;
  return (
    value['version'] === 1 &&
    typeof value['runtimeId'] === 'string' &&
    typeof value['lookupKey'] === 'string' &&
    typeof value['bundleHash'] === 'string' &&
    typeof value['iv'] === 'string' &&
    typeof value['ciphertext'] === 'string'
  );
};

export const extractEncryptedRecoveryBundles = (payload: unknown): EncryptedRuntimeRecoveryBundleV1[] => {
  if (isEncryptedRuntimeRecoveryBundle(payload)) return [payload];
  if (!isRecord(payload)) return [];
  const rawBundles = Array.isArray(payload['bundles'])
    ? payload['bundles']
    : payload['bundle']
      ? [payload['bundle']]
      : [];
  return rawBundles.filter(isEncryptedRuntimeRecoveryBundle);
};

const getBundleReferenceHash = (bundle: RuntimeRecoveryBundleV1): string =>
  String(bundle.checkpointHash || bundle.baseCheckpointHash || '')
    .trim()
    .toLowerCase();

const sortRecoveryBundlesByTip = (left: RuntimeRecoveryBundleV1, right: RuntimeRecoveryBundleV1): number => {
  if (right.runtimeHeight !== left.runtimeHeight) return right.runtimeHeight - left.runtimeHeight;
  return right.createdAt - left.createdAt;
};

export const sortRecoveryCandidatesByTip = (
  left: RuntimeRecoveryCandidate,
  right: RuntimeRecoveryCandidate,
): number => {
  if (right.runtimeHeight !== left.runtimeHeight) return right.runtimeHeight - left.runtimeHeight;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return (right.receipt?.sequence || 0) - (left.receipt?.sequence || 0);
};

export const requireRuntimeIdForSeed = (seed: string): string => {
  const runtimeId = normalizeRuntimeId(deriveRuntimeSignerAddress(seed, 0));
  if (!runtimeId) throw new Error('RECOVERY_RUNTIME_ID_INVALID');
  return runtimeId;
};

type RuntimeRecoveryCandidateInput = {
  source: RuntimeRecoveryCandidateSource;
  sourceLabel: string;
  seed: string;
  expectedRuntimeId: string;
  encryptedBundles: EncryptedRuntimeRecoveryBundleV1[];
  crypto?: RuntimeRecoveryCryptoPort | undefined;
  towerUrl?: string | undefined;
  peerId?: string | undefined;
  receipt?: TowerReceiptV1 | undefined;
};

export const buildRuntimeRecoveryCandidate = async (
  input: RuntimeRecoveryCandidateInput,
): Promise<RuntimeRecoveryCandidate> => {
  if (input.encryptedBundles.length === 0) {
    throw new Error('RECOVERY_CANDIDATE_EMPTY');
  }
  const decrypt = input.crypto?.decryptRuntimeRecoveryBundle ?? decryptRuntimeRecoveryBundle;
  const bundles: RuntimeRecoveryBundleV1[] = [];
  for (const encryptedBundle of input.encryptedBundles) {
    bundles.push(await decrypt(encryptedBundle, input.seed));
  }
  for (const bundle of bundles) {
    const runtimeId = normalizeRuntimeId(bundle.runtimeId);
    if (!runtimeId || runtimeId !== input.expectedRuntimeId) {
      throw new Error(
        `RECOVERY_CANDIDATE_RUNTIME_ID_MISMATCH: expected=${input.expectedRuntimeId} ` +
          `actual=${String(bundle.runtimeId || 'none')}`,
      );
    }
  }

  const tipBundle = bundles.reduce((best, bundle) => (sortRecoveryBundlesByTip(best, bundle) > 0 ? bundle : best));
  const metadataBundle = bundles.find(bundle => (bundle.kind ?? 'snapshot') === 'snapshot') ?? tipBundle;
  const checkpointHash = getBundleReferenceHash(metadataBundle) || getBundleReferenceHash(tipBundle);
  const sourceKey = input.towerUrl || input.sourceLabel;
  const id = [
    input.source,
    sourceKey,
    tipBundle.runtimeHeight,
    tipBundle.createdAt,
    checkpointHash || input.encryptedBundles[0]?.bundleHash || 'no-hash',
  ].join(':');

  return {
    id,
    source: input.source,
    sourceLabel: input.sourceLabel,
    ...(input.towerUrl ? { towerUrl: input.towerUrl } : {}),
    ...(input.peerId ? { peerId: input.peerId } : {}),
    ...(input.receipt ? { receipt: input.receipt } : {}),
    encryptedBundles: input.encryptedBundles,
    bundles,
    tipBundle,
    metadataBundle,
    runtimeId: input.expectedRuntimeId,
    runtimeHeight: tipBundle.runtimeHeight,
    createdAt: Math.max(tipBundle.createdAt, metadataBundle.createdAt),
    signerCount: metadataBundle.signers.length,
    checkpointHash,
    bundleCount: bundles.length,
  };
};

/**
 * A backup file the person kept themselves. Same authentication as a tower
 * bundle: the file is only a transport, the seed is still the only key.
 */
export async function parseRuntimeRecoveryCandidateFile(
  seed: string,
  fileContents: string,
  options: { sourceLabel?: string | undefined; crypto?: RuntimeRecoveryCryptoPort | undefined } = {},
): Promise<RuntimeRecoveryCandidate> {
  const runtimeId = requireRuntimeIdForSeed(seed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents) as unknown;
  } catch {
    throw new Error('RECOVERY_BACKUP_FILE_JSON_INVALID');
  }
  const encryptedBundles = extractEncryptedRecoveryBundles(parsed);
  if (encryptedBundles.length === 0) {
    throw new Error('RECOVERY_BACKUP_FILE_EMPTY');
  }
  return buildRuntimeRecoveryCandidate({
    source: 'file',
    sourceLabel: options.sourceLabel || 'Local backup file',
    seed,
    expectedRuntimeId: runtimeId,
    encryptedBundles,
    crypto: options.crypto,
  });
}
