#!/usr/bin/env bun

/** Fresh deterministic TS H1 recording for the Rust-only Account replay gate. */

import { join } from 'node:path';

import {
  freshAuthorityEvidenceDir,
  runAuthorityEvidenceGate,
} from './evidence/gate-support';

const workDir = freshAuthorityEvidenceDir('xln-rscore-authority-evidence-');
const output = join(workDir, 'hlt-hub-recording.json');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  XLN_LOCAL_PROD_SMOKE_DIR: workDir,
  XLN_HLT_RECORDING_OUTPUT: output,
  XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE: 'mixed',
  XLN_HLT_USERS: '4',
  XLN_HLT_RATE_PER_USER: '1',
  XLN_HLT_DURATION_S: '2',
  XLN_HLT_MIX: '1:1',
  XLN_HLT_HUBS: 'H1',
  XLN_HLT_MARKET_MAKERS: 'MM',
  XLN_HLT_AUTHORITY_EVIDENCE: '1',
  XLN_HLT_LANE_PERSISTENCE: '1',
  XLN_MM_CROSS_J: '0',
  XLN_STORAGE_CERTIFIED_HISTORY: '1',
  MARKET_MAKER_STEADY_QUOTES_ENABLED: '0',
  XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS: '0',
  XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO: '0',
};
for (const key of [
  'XLN_HUB_RSCORE_AUTHORITY_H1',
  'XLN_RSCORE_AUTHORITY',
  'XLN_RSCORE_AUTHORITY_CUTOVER',
  'XLN_RSCORE_AUTHORITY_IMPORT',
  'XLN_RSCORE_AUTHORITY_REPLAY',
] as const) delete env[key];

runAuthorityEvidenceGate({
  label: 'HLT_AUTHORITY_TS_RECORD_GATE',
  script: 'core/scripts/operations/hlt/build-chains.ts',
  env,
});
console.log(`HLT_AUTHORITY_TS_RECORDING path=${output}`);
