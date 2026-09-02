#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import {
  CAPACITOR_SHELL_CANDIDATE_MANIFEST,
  CAPACITOR_SHELL_CANDIDATE_ROOT,
  CAPACITOR_SHELL_CANDIDATE_SCHEMA_VERSION,
  createCapacitorShellCandidatePlan,
  snapshotRegularTree,
  verifyCapacitorShellCandidateDirectory,
  type CapacitorShellCandidateManifest,
  type CapacitorShellCandidatePlan,
} from './capacitor-shell-candidate-manifest';

export type CapacitorShellCandidateResult = Readonly<{
  releaseId: `sha256-${string}`;
  workspaceId: `sha256-${string}`;
  workspaceDirectory: string;
  status: 'created' | 'reused';
  manifest: CapacitorShellCandidateManifest;
}>;

const FRONTEND_ROOT = resolve(import.meta.dir, '../../frontend');
const CAPACITOR_EXECUTABLE = join(FRONTEND_ROOT, 'node_modules/.bin/cap');
const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

const pathExists = async (pathname: string): Promise<boolean> => {
  try {
    await lstat(pathname);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const assertPlainDirectory = async (directory: string): Promise<void> => {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('CAPACITOR_SHELL_OUTPUT_ROOT_INVALID');
};

const capacitorPackage = async (): Promise<Record<string, unknown>> => {
  const value = JSON.parse(await readFile(join(FRONTEND_ROOT, 'package.json'), 'utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CAPACITOR_SHELL_FRONTEND_PACKAGE_INVALID');
  }
  const record = value as Record<string, unknown>;
  const dependencyEntries = ['dependencies', 'devDependencies'].flatMap((field) => {
    const dependencies = record[field];
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return [];
    return Object.entries(dependencies as Record<string, unknown>)
      .filter(([name, version]) => name.startsWith('@capacitor/') && typeof version === 'string');
  });
  return {
    name: 'xln-capacitor-shell-candidate',
    private: true,
    version: typeof record['version'] === 'string' ? record['version'] : '0.0.0',
    dependencies: Object.fromEntries(dependencyEntries),
  };
};

const runCapacitorCopy = (workspaceDirectory: string, platform: 'ios' | 'android'): void => {
  const result = spawnSync(CAPACITOR_EXECUTABLE, ['copy', platform], {
    cwd: workspaceDirectory,
    encoding: 'utf8',
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `CAPACITOR_SHELL_COPY_FAILED:${platform}:${result.status ?? 'unknown'}\n${result.stdout}${result.stderr}`,
    );
  }
};

const writeCandidateManifest = async (
  workspaceDirectory: string,
  plan: CapacitorShellCandidatePlan,
): Promise<void> => {
  const files = (await snapshotRegularTree(workspaceDirectory))
    .filter(({ path }) => path !== CAPACITOR_SHELL_CANDIDATE_MANIFEST);
  const manifest: CapacitorShellCandidateManifest = {
    schemaVersion: CAPACITOR_SHELL_CANDIDATE_SCHEMA_VERSION,
    releaseId: plan.releaseId,
    workspaceId: plan.workspaceId,
    sourceShells: plan.sourceShells,
    configSha256: hashText(plan.configText),
    files,
  };
  await writeFile(
    join(workspaceDirectory, CAPACITOR_SHELL_CANDIDATE_MANIFEST),
    `${safeStringify(manifest, 2)}\n`,
  );
};

const materializeWorkspace = async (
  workspaceDirectory: string,
  plan: CapacitorShellCandidatePlan,
): Promise<void> => {
  await Promise.all([
    cp(join(FRONTEND_ROOT, 'ios'), join(workspaceDirectory, 'ios'), { recursive: true }),
    cp(join(FRONTEND_ROOT, 'android'), join(workspaceDirectory, 'android'), { recursive: true }),
    writeFile(join(workspaceDirectory, 'capacitor.config.json'), plan.configText),
    capacitorPackage().then((value) => writeFile(
      join(workspaceDirectory, 'package.json'),
      `${safeStringify(value, 2)}\n`,
    )),
  ]);
  runCapacitorCopy(workspaceDirectory, 'ios');
  runCapacitorCopy(workspaceDirectory, 'android');
  await writeCandidateManifest(workspaceDirectory, plan);
};

const isDestinationExistsError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY');

export const copyCapacitorShellCandidate = async (
  stagingDirectory: string,
): Promise<CapacitorShellCandidateResult> => {
  const plan = await createCapacitorShellCandidatePlan(stagingDirectory);
  const releaseRoot = dirname(plan.workspaceDirectory);
  await mkdir(releaseRoot, { recursive: true });
  await assertPlainDirectory(releaseRoot);
  if (await pathExists(plan.workspaceDirectory)) {
    const manifest = await verifyCapacitorShellCandidateDirectory(plan.workspaceDirectory, stagingDirectory);
    return { ...plan, status: 'reused', manifest };
  }
  const temporaryDirectory = await mkdtemp(join(releaseRoot, '.capacitor-shell-candidate-'));
  try {
    await materializeWorkspace(temporaryDirectory, plan);
    await verifyCapacitorShellCandidateDirectory(
      temporaryDirectory,
      stagingDirectory,
      CAPACITOR_SHELL_CANDIDATE_ROOT,
      false,
    );
    try {
      await rename(temporaryDirectory, plan.workspaceDirectory);
    } catch (error: unknown) {
      if (!isDestinationExistsError(error)) throw error;
    }
    const manifest = await verifyCapacitorShellCandidateDirectory(plan.workspaceDirectory, stagingDirectory);
    const status = await pathExists(temporaryDirectory) ? 'reused' : 'created';
    return { ...plan, status, manifest };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2);
  if (args.length !== 1 || !args[0]) throw new Error('CAPACITOR_SHELL_COPY_ARGUMENTS_INVALID');
  const result = await copyCapacitorShellCandidate(resolve(args[0]));
  console.info(
    `CAPACITOR_SHELL_CANDIDATE_OK release=${result.releaseId} workspace=${result.workspaceId} ` +
    `files=${result.manifest.files.length} status=${result.status} path=${result.workspaceDirectory}`,
  );
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
