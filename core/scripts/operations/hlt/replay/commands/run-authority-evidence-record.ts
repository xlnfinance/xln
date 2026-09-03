#!/usr/bin/env bun

/** Record the canonical mixed transcript from the production TS H1. */

import { join } from 'node:path';

import { freshAuthorityEvidenceDir, runAuthorityEvidenceGate } from '../evidence/gate-support';
import { writeEvidenceBundleProvenance } from '../evidence/bundle';

// The work directory IS the portable evidence bundle: recording, closed hub
// WAL, mesh seed, smoke reports, and PROVENANCE.json. Default it under
// .logs/hlt-evidence/<utc-stamp> instead of a tmp dir so it survives reboots
// and can be archived as one folder.
if (!process.env['XLN_RSCORE_EVIDENCE_DIR']) {
  process.env['XLN_RSCORE_EVIDENCE_DIR'] = join(
    process.cwd(), '.logs', 'hlt-evidence', new Date().toISOString().replace(/[:.]/g, '-'),
  );
}
const workDir = freshAuthorityEvidenceDir('xln-runtime-replay-v1-');
const output = join(workDir, 'recording-manifest.json');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  XLN_HLT_ENGINE: 'ts',
  XLN_HLT_H1_ONLY: '1',
  XLN_HUB_COUNT: '1',
  XLN_HLT_PROFILE: 'medium',
  XLN_LOCAL_PROD_SMOKE_DIR: workDir,
  XLN_HLT_RECORDING_OUTPUT: output,
  XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE: 'mixed',
  // Parity evidence is the production load itself: the canonical 1,000
  // sovereign Runtimes at the production rate (1 payment + 1 swap action
  // per user per second) with production frame coalescing. Twenty offers per
  // Account stay below the protocol's 32-live-offer bound while still
  // supplying 20,000 payments and 20,000 swap actions to the parity gate. A selective
  // one-input-per-frame transcript would prove parity on a shape the hub
  // never runs; the 110-frame gate is met by real economic frame cadence.
  XLN_HLT_USERS: process.env['XLN_HLT_USERS'] || '1000',
  XLN_HLT_RATE_PER_USER: process.env['XLN_HLT_RATE_PER_USER'] || '1',
  XLN_HLT_DURATION_S: process.env['XLN_HLT_DURATION_S'] || '20',
  XLN_HLT_MIX: '1:1',
  XLN_HLT_HUBS: 'H1',
  XLN_HLT_MARKET_MAKERS: 'MM',
  XLN_HLT_AUTHORITY_EVIDENCE: '1',
  XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES: '100',
  XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES: '1',
  XLN_RUNTIME_MIN_FRAME_DELAY_MS: '0',
  XLN_MM_CROSS_J: '0',
  MARKET_MAKER_STEADY_QUOTES_ENABLED: '0',
  XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS: '0',
  XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO: '0',
};
for (const key of [
  'XLN_HLT_ECONOMIC_GATE_DIR', 'XLN_HLT_ECONOMIC_GATE_READY', 'XLN_HLT_ECONOMIC_GATE_START',
  'XLN_HUB_RSCORE_AUTHORITY_H1', 'XLN_RSCORE_AUTHORITY',
  'XLN_RSCORE_AUTHORITY_IMPORT', 'XLN_RSCORE_AUTHORITY_RECORD',
  'XLN_RSCORE_AUTHORITY_REPLAY', 'XLN_RSCORE_AUTHORITY_RUNTIME_ID',
] as const) delete env[key];

const startedAt = new Date().toISOString();
runAuthorityEvidenceGate({
  label: 'HLT_RUNTIME_REPLAY_V2_RECORD_GATE',
  script: 'core/scripts/operations/hlt/build-chains.ts',
  env,
});
writeEvidenceBundleProvenance({
  bundleDir: workDir,
  recordingPath: output,
  startedAt,
  knobs: {
    users: env['XLN_HLT_USERS'] ?? '',
    ratePerUser: env['XLN_HLT_RATE_PER_USER'] ?? '',
    durationSeconds: env['XLN_HLT_DURATION_S'] ?? '',
    mix: env['XLN_HLT_MIX'] ?? '',
    profile: env['XLN_HLT_PROFILE'] ?? '',
    swapLoadMode: env['XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE'] ?? '',
    materializePeriodFrames: env['XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES'] ?? '',
  },
});
console.log(`HLT_RUNTIME_REPLAY_V2 path=${output}`);
