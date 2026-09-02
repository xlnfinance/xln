#!/usr/bin/env bun

/** Record the canonical mixed transcript from the production TS H1. */

import { join } from 'node:path';

import { freshAuthorityEvidenceDir, runAuthorityEvidenceGate } from '../evidence/gate-support';

const workDir = freshAuthorityEvidenceDir('xln-runtime-replay-v1-');
const output = join(workDir, 'hlt-hub-recording.json');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  XLN_HLT_ENGINE: 'ts',
  XLN_HLT_H1_ONLY: '1',
  XLN_HUB_COUNT: '1',
  XLN_HLT_PROFILE: 'smoke',
  XLN_LOCAL_PROD_SMOKE_DIR: workDir,
  XLN_HLT_RECORDING_OUTPUT: output,
  XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE: 'mixed',
  // Pace twenty bounded rounds across 100 real sovereign Runtimes and admit
  // one EntityInput per H1 frame. This prevents mempool coalescing from making
  // a busy economic run too short for the >=1,000-frame parity gate.
  // This is parity evidence only; the workload deliberately emits no TPS.
  XLN_HLT_USERS: process.env['XLN_HLT_USERS'] || '100',
  XLN_HLT_RATE_PER_USER: process.env['XLN_HLT_RATE_PER_USER'] || '1',
  XLN_HLT_DURATION_S: process.env['XLN_HLT_DURATION_S'] || '20',
  XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME:
    process.env['XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '1',
  XLN_HLT_MIX: '1:1',
  XLN_HLT_HUBS: 'H1',
  XLN_HLT_MARKET_MAKERS: 'MM',
  XLN_HLT_AUTHORITY_EVIDENCE: '1',
  XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES: '1',
  XLN_RUNTIME_MIN_FRAME_DELAY_MS: '0',
  XLN_MM_CROSS_J: '0',
  MARKET_MAKER_STEADY_QUOTES_ENABLED: '0',
  XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS: '0',
  XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO: '0',
};
for (const key of [
  'XLN_HLT_ECONOMIC_GATE_DIR', 'XLN_HLT_ECONOMIC_GATE_READY', 'XLN_HLT_ECONOMIC_GATE_START',
  'XLN_HUB_RSCORE_AUTHORITY_H1', 'XLN_RSCORE_AUTHORITY', 'XLN_RSCORE_AUTHORITY_CUTOVER',
  'XLN_RSCORE_AUTHORITY_IMPORT', 'XLN_RSCORE_AUTHORITY_RECORD',
  'XLN_RSCORE_AUTHORITY_REPLAY', 'XLN_RSCORE_AUTHORITY_RUNTIME_ID',
] as const) delete env[key];

runAuthorityEvidenceGate({
  label: 'HLT_RUNTIME_REPLAY_V1_RECORD_GATE',
  script: 'core/scripts/operations/hlt/build-chains.ts',
  env,
});
console.log(`HLT_RUNTIME_REPLAY_V1 path=${output}`);
