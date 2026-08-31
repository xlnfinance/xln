#!/usr/bin/env bun

/** Generate the sole V1 replay fixture from one production Rust H1 run. */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeParse, safeStringify } from '../../../../../protocol/serialization';
import { freshAuthorityEvidenceDir, runAuthorityEvidenceGate } from '../evidence/gate-support';

const workDir = freshAuthorityEvidenceDir('xln-native-replay-v1-');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  XLN_HLT_ENGINE: 'rust',
  XLN_HLT_PROFILE: 'smoke',
  XLN_LOCAL_PROD_SMOKE_DIR: workDir,
  XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE: 'payments',
  XLN_HLT_USERS: process.env['XLN_HLT_USERS'] ?? '100',
  XLN_HLT_RATE_PER_USER: process.env['XLN_HLT_RATE_PER_USER'] ?? '1',
  XLN_HLT_DURATION_S: process.env['XLN_HLT_DURATION_S'] ?? '2',
  XLN_HLT_HUBS: 'H1',
  XLN_MM_CROSS_J: '0',
  MARKET_MAKER_STEADY_QUOTES_ENABLED: '0',
  XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS: '0',
  XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO: '0',
};

runAuthorityEvidenceGate({
  label: 'HLT_NATIVE_REPLAY_V1_RECORD_GATE',
  script: 'core/scripts/operations/hlt/build-chains.ts',
  env,
});

const reportPath = join(workDir, 'hlt-rust-h1-live.json');
const report = safeParse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
const metrics = report['metrics'] as Record<string, unknown> | undefined;
if (report['engine'] !== 'rust' || !metrics) throw new Error('NATIVE_REPLAY_V1_REPORT_INVALID');
const manifestPath = join(workDir, 'native-replay-v1.json');
writeFileSync(manifestPath, `${safeStringify({
  format: 'xln-native-replay-v1',
  sourceNativeDb: join(workDir, 'prod-mesh', 'h1', 'rscore-native'),
  genesisFile: join(workDir, 'prod-mesh', 'h1', 'rscore-genesis.json'),
  runtimeSeedFile: join(workDir, 'prod-mesh', 'h1', 'runtime.seed'),
  runtimeSignerLabel: '1',
  entitySignerLabel: 'h1-hub',
  users: report['users'],
  payments: report['submittedPayments'],
  minFrameDelayMs: report['minFrameDelayMs'],
  sourceRuntimeFrames: metrics['totalFrames'],
  sourceEntityInputs: metrics['totalRuntimeEntityInputs'],
  sourceAccountInputs: metrics['totalAccountInputs'],
})}\n`);
console.log(`HLT_NATIVE_REPLAY_V1 path=${manifestPath}`);
