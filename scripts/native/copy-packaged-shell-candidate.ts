#!/usr/bin/env bun

import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import {
  PACKAGED_SHELL_CANDIDATE_MANIFEST,
  PACKAGED_SHELL_CANDIDATE_ROOT,
  PACKAGED_SHELL_CANDIDATE_SCHEMA_VERSION,
  createPackagedShellCandidatePlan,
  verifyPackagedShellCandidateDirectory,
  type PackagedShellCandidateManifest,
  type PackagedShellCandidatePlan,
} from './packaged-shell-candidate-manifest';

export type PackagedShellCandidateResult = Readonly<{
  releaseId: `sha256-${string}`;
  workspaceId: `sha256-${string}`;
  workspaceDirectory: string;
  status: 'created' | 'reused';
  manifest: PackagedShellCandidateManifest;
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

const assertPlainDirectory = async (pathname: string): Promise<void> => {
  const stats = await lstat(pathname);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('PACKAGED_CANDIDATE_OUTPUT_ROOT_INVALID');
};

const writeManifest = async (workspaceDirectory: string, plan: PackagedShellCandidatePlan): Promise<void> => {
  const manifest: PackagedShellCandidateManifest = {
    schemaVersion: PACKAGED_SHELL_CANDIDATE_SCHEMA_VERSION,
    releaseId: plan.releaseId,
    workspaceId: plan.workspaceId,
    sourceShells: plan.sourceShells,
    desktopPackageSha256: plan.desktopPackageSha256,
    layoutSha256: plan.layoutSha256,
    files: plan.expectedFiles,
  };
  const pathname = join(workspaceDirectory, PACKAGED_SHELL_CANDIDATE_MANIFEST);
  await writeFile(pathname, `${safeStringify(manifest, 2)}\n`, { mode: 0o644 });
  await chmod(pathname, 0o644);
};

const materialize = async (workspaceDirectory: string, plan: PackagedShellCandidatePlan): Promise<void> => {
  for (const entry of plan.copyFiles) {
    const destination = join(workspaceDirectory, entry.destinationPath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(entry.sourcePath, destination);
    await chmod(destination, entry.file.mode);
  }
  const packagePath = join(workspaceDirectory, 'desktop/package.json');
  await mkdir(dirname(packagePath), { recursive: true });
  await writeFile(packagePath, plan.desktopPackageText, { mode: 0o644 });
  await chmod(packagePath, 0o644);
  await writeManifest(workspaceDirectory, plan);
};

const isDestinationExistsError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY');

export const copyPackagedShellCandidate = async (
  stagingDirectory: string,
  outputRoot = PACKAGED_SHELL_CANDIDATE_ROOT,
): Promise<PackagedShellCandidateResult> => {
  const plan = await createPackagedShellCandidatePlan(stagingDirectory, outputRoot);
  const releaseRoot = dirname(plan.workspaceDirectory);
  await mkdir(releaseRoot, { recursive: true });
  await assertPlainDirectory(releaseRoot);
  if (await pathExists(plan.workspaceDirectory)) {
    const manifest = await verifyPackagedShellCandidateDirectory(
      plan.workspaceDirectory,
      stagingDirectory,
      outputRoot,
    );
    return { ...plan, status: 'reused', manifest };
  }
  const temporaryDirectory = await mkdtemp(join(releaseRoot, '.packaged-shell-candidate-'));
  try {
    await materialize(temporaryDirectory, plan);
    await verifyPackagedShellCandidateDirectory(temporaryDirectory, stagingDirectory, outputRoot, false);
    try {
      await rename(temporaryDirectory, plan.workspaceDirectory);
    } catch (error: unknown) {
      if (!isDestinationExistsError(error)) throw error;
    }
    const manifest = await verifyPackagedShellCandidateDirectory(
      plan.workspaceDirectory,
      stagingDirectory,
      outputRoot,
    );
    const status = await pathExists(temporaryDirectory) ? 'reused' : 'created';
    return { ...plan, status, manifest };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2);
  if (args.length !== 1 || !args[0]) throw new Error('PACKAGED_CANDIDATE_COPY_ARGUMENTS_INVALID');
  const result = await copyPackagedShellCandidate(resolve(args[0]));
  console.info(
    `PACKAGED_SHELL_CANDIDATE_OK release=${result.releaseId} workspace=${result.workspaceId} ` +
    `files=${result.manifest.files.length} status=${result.status} path=${result.workspaceDirectory}`,
  );
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
