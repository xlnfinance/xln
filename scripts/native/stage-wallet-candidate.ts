#!/usr/bin/env bun

import { copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import { verifyCandidateReleaseDirectory } from '../../frontend/scripts/candidate-release-verifier';
import {
  NATIVE_WALLET_CANDIDATE_MANIFEST,
  planNativeWalletCandidate,
  verifyNativeWalletCandidateDirectory,
  type NativeWalletCandidateManifest,
} from './wallet-candidate-manifest';

export type NativeWalletCandidateResult = Readonly<{
  releaseId: `sha256-${string}`;
  stagingDirectory: string;
  status: 'created' | 'reused';
  manifest: NativeWalletCandidateManifest;
}>;

const pathExists = async (pathname: string): Promise<boolean> => {
  try {
    await lstat(pathname);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const isDestinationExistsError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY');

const verifyExpectedStage = async (
  directory: string,
  expected: NativeWalletCandidateManifest,
): Promise<void> => {
  const actual = await verifyNativeWalletCandidateDirectory(directory, expected.releaseId);
  if (safeStringify(actual) !== safeStringify(expected)) throw new Error('NATIVE_WALLET_CANDIDATE_PLAN_MISMATCH');
};

const writeTemporaryStage = async (
  releaseDirectory: string,
  temporaryDirectory: string,
  manifest: NativeWalletCandidateManifest,
): Promise<void> => {
  await mkdir(temporaryDirectory);
  for (const file of manifest.files) {
    const destination = join(temporaryDirectory, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(releaseDirectory, file.sourcePath), destination);
  }
  await writeFile(
    join(temporaryDirectory, NATIVE_WALLET_CANDIDATE_MANIFEST),
    `${safeStringify(manifest, 2)}\n`,
  );
  await verifyExpectedStage(temporaryDirectory, manifest);
};

const publishTemporaryStage = async (
  temporaryDirectory: string,
  stagingDirectory: string,
  manifest: NativeWalletCandidateManifest,
): Promise<'created' | 'reused'> => {
  try {
    await rename(temporaryDirectory, stagingDirectory);
    await verifyExpectedStage(stagingDirectory, manifest);
    return 'created';
  } catch (error: unknown) {
    if (!isDestinationExistsError(error)) throw error;
    await verifyExpectedStage(stagingDirectory, manifest);
    return 'reused';
  }
};

export const materializeNativeWalletCandidate = async (
  releaseDirectory: string,
  stagingRoot: string,
): Promise<NativeWalletCandidateResult> => {
  const release = await verifyCandidateReleaseDirectory(releaseDirectory);
  const manifest = planNativeWalletCandidate(release);
  const stagingDirectory = join(stagingRoot, release.releaseId);
  await mkdir(stagingRoot, { recursive: true });
  if (await pathExists(stagingDirectory)) {
    await verifyExpectedStage(stagingDirectory, manifest);
    return { releaseId: release.releaseId, stagingDirectory, status: 'reused', manifest };
  }
  const temporaryRoot = await mkdtemp(join(stagingRoot, '.native-wallet-candidate-'));
  const temporaryDirectory = join(temporaryRoot, release.releaseId);
  try {
    await writeTemporaryStage(releaseDirectory, temporaryDirectory, manifest);
    const status = await publishTemporaryStage(temporaryDirectory, stagingDirectory, manifest);
    return { releaseId: release.releaseId, stagingDirectory, status, manifest };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2);
  if (args.length < 1 || args.length > 2) throw new Error('NATIVE_WALLET_CANDIDATE_ARGUMENTS_INVALID');
  const releaseDirectory = args[0];
  if (!releaseDirectory) throw new Error('NATIVE_WALLET_CANDIDATE_RELEASE_REQUIRED');
  const stagingRoot = args[1] ?? resolve(import.meta.dir, '../../native/dist/candidates');
  const result = await materializeNativeWalletCandidate(releaseDirectory, stagingRoot);
  console.info(
    `NATIVE_WALLET_CANDIDATE_STAGE_OK release=${result.releaseId} files=${result.manifest.files.length} ` +
    `status=${result.status} path=${result.stagingDirectory}`,
  );
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
