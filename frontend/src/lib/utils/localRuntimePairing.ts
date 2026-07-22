import { replaceState } from '$app/navigation';

import {
  parseRemoteRuntimeImportSourcePayload,
  type RemoteRuntimeImportEntry,
} from './remoteRuntimeImport';

export const LOCAL_RUNTIME_PAIR_HASH_PARAM = 'xlnPair';

const hashParams = (): URLSearchParams => {
  if (typeof window === 'undefined') return new URLSearchParams();
  const raw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
};

export const readLocalRuntimePairingToken = (): string =>
  String(hashParams().get(LOCAL_RUNTIME_PAIR_HASH_PARAM) || '').trim();

export const stripLocalRuntimePairingToken = (): void => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const params = hashParams();
  if (!params.has(LOCAL_RUNTIME_PAIR_HASH_PARAM)) return;
  params.delete(LOCAL_RUNTIME_PAIR_HASH_PARAM);
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
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload['error'] || `LOCAL_PAIRING_FAILED:${response.status}`));
  }
  return parseRemoteRuntimeImportSourcePayload(payload);
};
