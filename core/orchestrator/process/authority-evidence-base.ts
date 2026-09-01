import { existsSync } from 'node:fs';

import { deriveRuntimeAdapterCapabilityToken } from '../../api/runtime-adapter/security/auth';
import { createStructuredLogger } from '../../support/logger';
import { DaemonControlClient } from '../daemon-control';
import type { HubChild } from '../orchestrator-types';

const meshLog = createStructuredLogger('mesh.orchestrator');

export const captureAuthorityEvidenceBase = async (
  h1: HubChild,
  host: string,
): Promise<void> => {
  if (process.env['XLN_HLT_AUTHORITY_EVIDENCE'] !== '1') return;
  if (h1.engine !== 'typescript') throw new Error('HLT_PARITY_CHECKPOINT_TS_ENGINE_REQUIRED');
  const outputPath = String(process.env['XLN_RUNTIME_SNAPSHOT_EXPORT_PATH'] ?? '').trim();
  if (!outputPath) throw new Error('HLT_PARITY_CHECKPOINT_OUTPUT_REQUIRED');
  const runtimeId = String(h1.lastInfo?.runtimeId ?? h1.lastHealth?.runtimeId ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId)) {
    throw new Error(`HLT_PARITY_CHECKPOINT_RUNTIME_ID_INVALID:${runtimeId}`);
  }
  const expiresAt = Date.now() + 60_000;
  const authKey = deriveRuntimeAdapterCapabilityToken(h1.authSeed, 'full', expiresAt, {
    audience: runtimeId,
    keyId: h1.name.toLowerCase(),
    tokenId: `authority-base-${expiresAt}`,
  });
  const snapshot = await new DaemonControlClient({
    baseUrl: `http://${host}:${String(h1.apiPort)}`,
    authKey,
    timeoutMs: 10_000,
  }).exportRuntimeSnapshot();
  if (snapshot.runtimeId !== runtimeId) {
    throw new Error(`HLT_PARITY_CHECKPOINT_RUNTIME_ID:${snapshot.runtimeId}:${runtimeId}`);
  }
  if (!existsSync(outputPath) || !existsSync(`${outputPath}.concrete-checkpoint.json`)) {
    throw new Error(`HLT_PARITY_CHECKPOINT_FILES_MISSING:${outputPath}`);
  }
  meshLog.info('authority_evidence.base_captured', {
    height: snapshot.height,
    runtimeId,
  });
};
