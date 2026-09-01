import { replaceState } from '$app/navigation';

import {
  parseRemoteRuntimeImportSourcePayload,
  type RemoteRuntimeImportEntry,
} from '../onboarding/remoteRuntimeImport';
import { readJsonUnknown, requireUnknownRecord } from '../boundary';

export const LOCAL_RUNTIME_PAIR_HASH_PARAM = 'xlnPair';
export const LOCAL_RUNTIME_ONBOARDING_HASH_PARAM = 'xlnOnboarding';
export const LOCAL_RUNTIME_ENTITY_HASH_PARAM = 'xlnEntity';

export type LocalRuntimeLaunchRequest = Readonly<{
  stage: 'create' | 'formation' | null;
  entityId: string;
}>;

const hashParams = (): URLSearchParams => {
  if (typeof window === 'undefined') return new URLSearchParams();
  const raw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
};

export const readLocalRuntimePairingToken = (): string =>
  String(hashParams().get(LOCAL_RUNTIME_PAIR_HASH_PARAM) || '').trim();

export const readLocalRuntimeLaunchRequest = (): LocalRuntimeLaunchRequest => {
  const params = hashParams();
  const rawStage = String(params.get(LOCAL_RUNTIME_ONBOARDING_HASH_PARAM) || '').trim();
  if (rawStage && rawStage !== 'create' && rawStage !== 'formation') {
    throw new Error(`LOCAL_LAUNCHER_ONBOARDING_STAGE_INVALID:${rawStage}`);
  }
  const entityId = String(params.get(LOCAL_RUNTIME_ENTITY_HASH_PARAM) || '').trim().toLowerCase();
  if (entityId && !/^0x[0-9a-f]{64}$/.test(entityId)) {
    throw new Error('LOCAL_LAUNCHER_ENTITY_ID_INVALID');
  }
  if (rawStage === 'formation' && !entityId) {
    throw new Error('LOCAL_LAUNCHER_ENTITY_ID_MISSING');
  }
  if (rawStage !== 'formation' && entityId) {
    throw new Error('LOCAL_LAUNCHER_ENTITY_WITHOUT_FORMATION');
  }
  return {
    stage: rawStage === 'create' || rawStage === 'formation' ? rawStage : null,
    entityId,
  };
};

export const stripLocalRuntimeLaunchParams = (): void => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const params = hashParams();
  const launcherParams = [
    LOCAL_RUNTIME_PAIR_HASH_PARAM,
    LOCAL_RUNTIME_ONBOARDING_HASH_PARAM,
    LOCAL_RUNTIME_ENTITY_HASH_PARAM,
  ];
  if (!launcherParams.some((name) => params.has(name))) return;
  params.delete(LOCAL_RUNTIME_PAIR_HASH_PARAM);
  params.delete(LOCAL_RUNTIME_ONBOARDING_HASH_PARAM);
  params.delete(LOCAL_RUNTIME_ENTITY_HASH_PARAM);
  url.hash = params.toString() ? `#${params.toString()}` : '';
  const next = `${url.pathname}${url.search}${url.hash}`;
  try {
    replaceState(next, {});
  } catch {
    window.history.replaceState(window.history.state, '', next);
  }
};

export const consumeLocalRuntimePairing = async (
  pairingToken: string,
): Promise<RemoteRuntimeImportEntry[]> => {
  const token = String(pairingToken || '').trim();
  if (!token) throw new Error('LOCAL_PAIRING_TOKEN_MISSING');
  const response = await fetch('/api/local-pairing/consume', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingToken: token }),
  });
  const payload = await readJsonUnknown(response).catch((): Record<string, unknown> => ({}));
  if (!response.ok) {
    const errorPayload = requireUnknownRecord(payload, 'LOCAL_PAIRING_ERROR_PAYLOAD_INVALID');
    throw new Error(typeof errorPayload['error'] === 'string' ? errorPayload['error'] : `LOCAL_PAIRING_FAILED:${response.status}`);
  }
  return parseRemoteRuntimeImportSourcePayload(payload);
};
