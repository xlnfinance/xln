#!/usr/bin/env bun

/** Live H1 Rust Account authority bootstrap, optionally with crash/restart proof. */

import {
  authorityEvidenceBinary,
  freshAuthorityEvidenceDir,
  runAuthorityEvidenceGate,
} from '../evidence/gate-support';

const unknownArgs = process.argv.slice(2).filter(value => value !== '--restart');
if (unknownArgs.length > 0) throw new Error(`RSCORE_BOOTSTRAP_ARGUMENT_UNKNOWN:${unknownArgs[0]}`);
const restart = process.argv.includes('--restart');
const workDir = freshAuthorityEvidenceDir(
  restart ? 'xln-rscore-authority-restart-' : 'xln-rscore-authority-bootstrap-',
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  XLN_LOCAL_PROD_SMOKE_DIR: workDir,
  XLN_HUB_RSCORE_AUTHORITY_H1: '1',
  XLN_RSCORE_AUTHORITY_CUTOVER: '1',
  XLN_RSCORE_AUTHORITY_RECORD: '1',
  XLN_RSCORE_AUTHORITY_WORKERS: '1',
  XLN_RSCORE_BINARY: authorityEvidenceBinary(),
  XLN_MM_CROSS_J: '0',
  MARKET_MAKER_STEADY_QUOTES_ENABLED: '0',
  XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS: '0',
  XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO: '0',
  XLN_LOCAL_PROD_SMOKE_ENFORCE_STAGE_BUDGETS: '1',
  XLN_LOCAL_PROD_SMOKE_HUB_MESH_BUDGET_MS: '18000',
  XLN_LOCAL_PROD_SMOKE_SAME_CHAIN_BUDGET_MS: '18000',
  XLN_LOCAL_PROD_SMOKE_CROSS_BUDGET_MS: '18000',
  XLN_LOCAL_PROD_SMOKE_NO_PROGRESS_FATAL_MS: '18000',
  ...(restart ? { XLN_LOCAL_PROD_SMOKE_AUTHORITY_RESTART: '1' } : {}),
};
delete env['XLN_RSCORE_AUTHORITY_IMPORT'];
delete env['XLN_RSCORE_AUTHORITY_REPLAY'];

runAuthorityEvidenceGate({
  label: restart
    ? 'HLT_AUTHORITY_RESTART_GATE'
    : 'HLT_AUTHORITY_LIVE_BOOTSTRAP_GATE',
  script: 'core/scripts/operations/production/local-prod-smoke.ts',
  env,
});
console.log(`HLT_AUTHORITY_LIVE_EVIDENCE workDir=${workDir} restart=${String(restart)}`);
