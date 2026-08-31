#!/usr/bin/env bun

/** Replay one immutable production-native V1 fixture with W1 and W4. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { safeParse, safeStringify } from '../../../../../protocol/serialization';
import { authorityEvidenceBinary } from '../evidence/gate-support';

type Manifest = Readonly<{
  format: 'xln-native-replay-v1';
  sourceNativeDb: string;
  genesisFile: string;
  runtimeSeedFile: string;
  runtimeSignerLabel: string;
  entitySignerLabel: string;
  minFrameDelayMs: number;
}>;

const requiredPath = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value || !existsSync(value)) {
    throw new Error(`NATIVE_REPLAY_V1_PATH:${field}`);
  }
  return resolve(value);
};

const readManifest = (path: string): Manifest => {
  const value = safeParse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (value['format'] !== 'xln-native-replay-v1') throw new Error('NATIVE_REPLAY_V1_FORMAT');
  const minFrameDelayMs = Number(value['minFrameDelayMs']);
  if (!Number.isSafeInteger(minFrameDelayMs) || minFrameDelayMs < 0) {
    throw new Error('NATIVE_REPLAY_V1_MIN_FRAME_DELAY');
  }
  return {
    format: value['format'],
    sourceNativeDb: requiredPath(value['sourceNativeDb'], 'sourceNativeDb'),
    genesisFile: requiredPath(value['genesisFile'], 'genesisFile'),
    runtimeSeedFile: requiredPath(value['runtimeSeedFile'], 'runtimeSeedFile'),
    runtimeSignerLabel: String(value['runtimeSignerLabel'] ?? ''),
    entitySignerLabel: String(value['entitySignerLabel'] ?? ''),
    minFrameDelayMs,
  };
};

const replay = (manifest: Manifest, workers: number): Record<string, unknown> => {
  const parent = mkdtempSync(join(dirname(manifest.sourceNativeDb), `.native-replay-w${workers}-`));
  const database = join(parent, 'db');
  try {
    const result = spawnSync(authorityEvidenceBinary(), [
      'native-replay',
      '--source-native-db', manifest.sourceNativeDb,
      '--replay-native-db', database,
      '--genesis-config', manifest.genesisFile,
      '--runtime-seed-file', manifest.runtimeSeedFile,
      '--runtime-signer-label', manifest.runtimeSignerLabel,
      '--entity-signer-label', manifest.entitySignerLabel,
      '--workers', String(workers),
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) {
      throw new Error(`NATIVE_REPLAY_V1_FAILED:w=${workers}:status=${String(result.status)}:${result.stderr.trim()}`);
    }
    const line = result.stdout.split('\n').find(candidate => candidate.includes('xlnrs-native-replay-v1'));
    if (!line) throw new Error(`NATIVE_REPLAY_V1_RESULT_MISSING:w=${workers}`);
    return safeParse(line) as Record<string, unknown>;
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
};

const manifestRaw = String(process.env['XLN_RSCORE_EVIDENCE_RECORDING'] ?? '').trim();
if (!manifestRaw) throw new Error('NATIVE_REPLAY_V1_MANIFEST_MISSING');
const manifestPath = resolve(manifestRaw);
const manifest = readManifest(manifestPath);
const results = [replay(manifest, 1), replay(manifest, 4)];
const exactFields = [
  'frames', 'entityInputs', 'accountInputs', 'directPayments', 'outputs',
  'accountsRoot', 'transcriptDigest',
] as const;
for (const field of exactFields) {
  if (results[0]![field] !== results[1]![field]) {
    throw new Error(`NATIVE_REPLAY_V1_NONDETERMINISTIC:${field}:w1=${String(results[0]![field])}:w4=${String(results[1]![field])}`);
  }
}
const output = resolve(String(
  process.env['XLN_RSCORE_EVIDENCE_REPLAY_REPORT'] ?? `${manifestPath}.replay.json`,
));
writeFileSync(output, `${safeStringify({
  format: 'xln-native-replay-v1-result',
  manifest: manifestPath,
  minFrameDelayMs: manifest.minFrameDelayMs,
  exactFields,
  results,
})}\n`);
console.log(`HLT_NATIVE_REPLAY_V1_OK path=${output}`);
