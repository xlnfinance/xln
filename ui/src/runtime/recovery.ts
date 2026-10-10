/**
 * Watchtower recovery: the wallet's side of the promise the tour makes.
 *
 * A tower keeps an encrypted copy of this runtime's latest signed pages. It
 * only ever sees a lookup key derived from the seed, the ciphertext and its
 * size; the key that opens the bundle never leaves this device. Every
 * cryptographic step comes from the canonical runtime module (bundle build,
 * bundle encryption, the owner message a tower verifies); this file only holds
 * the wallet-local parts: which towers the person picked and the HTTP call.
 *
 */
import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeReplica,
  TowerAppointmentV1,
  TowerReceiptV1,
  XLNModule,
} from '@xln/core/api/public/runtime-module';
import type { RuntimeRecoverySignerV1 } from '@xln/core/storage/recovery/bundle/types';
import { withRuntimeCommittedRead } from '@xln/core/runtime/frame/lifecycle/writer-lock';
import { deriveJurisdictionSignerIndex } from '@xln/core/jurisdiction/machine/config/signer-derivation';
import { Wallet } from 'ethers';
import { deriveAddress, derivePrivateKey } from './keys';
import { requireBackupCapacity, requireBackupTransportCapacity } from './backup-size';

/** `tower`: an encrypted copy leaves this device. `local`: nothing does. */
export type RecoveryMode = 'tower' | 'local';
export type RecoveryConfig = { mode: RecoveryMode; towers: string[] };

/** What the tower says about itself before we trust it with anything. */
export type TowerHealth = { towerId: string; signerAddress: string; maxStoredBytesPerLookupKey: number; maxAppointmentBytes: number; lookupKeys: number; sweepEnabled: boolean; pushEnabled: boolean; pushSender: string };

/** What the tower says it actually holds for us, read back from the tower, not from our own hopes. */
export type TowerCoverage = {
  url: string;
  protecting: boolean;
  height: number;
  storedBytes: number;
  storedAt: number;
  error: string | null;
};

const STORAGE_KEY = 'xln-ui-recovery';
const EMPTY: RecoveryConfig = { mode: 'local', towers: [] };

const readAll = (): Record<string, RecoveryConfig> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, RecoveryConfig>)
      : {};
  } catch {
    return {};
  }
};

/** The towers this vault picked. Per vault, because the seed is what a tower stores for. */
export function readRecovery(vaultId: string | null): RecoveryConfig {
  if (!vaultId) return EMPTY;
  const stored = readAll()[vaultId];
  if (!stored) return EMPTY;
  const towers = Array.isArray(stored.towers)
    ? stored.towers
        .map(url =>
          String(url || '')
            .trim()
            .replace(/\/+$/, ''),
        )
        .filter(Boolean)
    : [];
  return { mode: stored.mode === 'tower' && towers.length > 0 ? 'tower' : 'local', towers };
}

export function saveRecovery(vaultId: string, config: RecoveryConfig): RecoveryConfig {
  const next: RecoveryConfig = {
    mode: config.mode === 'tower' && config.towers.length > 0 ? 'tower' : 'local',
    towers: config.towers,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [vaultId]: next }));
  return next;
}

export function normalizeTowerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Type the address of a tower first.');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('A tower address starts with https://');
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * The tower this network offers by default. A public host has the xln tower;
 * on a local stack there is no always-on tower to assume, so the person names
 * one (the dev stand runs its own on 127.0.0.1:9100).
 */
export function defaultTowerUrl(): string {
  const hostname = window.location.hostname.toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? '' : 'https://xln.finance';
}

/**
 * A local http tower cannot be called from the page directly: it is another
 * origin, and on a TLS page it is mixed content. The stack's own API proxies it
 * on a fixed allowlist of paths, so every local tower call goes through there.
 */
export function towerRequestUrl(towerUrl: string, towerPath: string): string {
  const base = towerUrl.trim().replace(/\/+$/, '');
  const path = towerPath.startsWith('/') ? towerPath : `/${towerPath}`;
  const target = new URL(`${base}/`);
  if (target.protocol === 'http:' && (target.hostname === '127.0.0.1' || target.hostname === 'localhost')) {
    const proxy = new URL('/api/watchtower-proxy', window.location.href);
    proxy.searchParams.set('target', base);
    proxy.searchParams.set('path', path);
    return proxy.toString();
  }
  return new URL(path, `${base}/`).toString();
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export async function towerHealth(towerUrl: string): Promise<TowerHealth> {
  const response = await fetch(towerRequestUrl(towerUrl, '/api/tower/healthz'), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const payload = asRecord(await response.json());
  if (!response.ok || payload['ok'] !== true)
    throw new Error(`This address did not answer as a tower (HTTP ${response.status}).`);
  return {
    towerId: String(payload['towerId'] || 'tower'),
    maxStoredBytesPerLookupKey: Number(payload['maxStoredBytesPerLookupKey']),
    maxAppointmentBytes: Number(payload['maxAppointmentBytes']),
    signerAddress: String(payload['signerAddress'] || ''),
    lookupKeys: Number(asRecord(payload['stats'])['lookupCount'] || 0),
    sweepEnabled: asRecord(payload['sweep'])['enabled'] === true,
    pushEnabled: asRecord(payload['pushWake'])['enabled'] === true,
    pushSender: String(asRecord(payload['pushWake'])['sender'] || 'unknown'),
  };
}

/** The blind name our backups live under at every tower: keccak(runtimeId, seed). The tower learns nothing else. */
export function recoveryLookupKey(xln: XLNModule, runtimeId: string, seed: string): string {
  return xln.deriveRuntimeRecoveryLookupKey(runtimeId, seed);
}

/** Ask the tower what it holds for us. `protecting` is the tower's own answer, never our optimism. */
export async function readTowerCoverage(towerUrl: string, lookupKey: string): Promise<TowerCoverage> {
  const empty = { url: towerUrl, protecting: false, height: 0, storedBytes: 0, storedAt: 0 };
  try {
    const response = await fetch(towerRequestUrl(towerUrl, '/api/recovery/discover'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lookupKey }),
    });
    const payload = asRecord(await response.json());
    if (!response.ok || payload['ok'] !== true) {
      if (payload['error'] === 'TOWER_BUNDLE_NOT_FOUND') return { ...empty, error: null };
      throw new Error(String(payload['error'] || `HTTP_${response.status}`));
    }
    const receipt = asRecord(payload['latestReceipt']);
    return {
      ...empty,
      protecting: payload['available'] === true,
      height: Number(receipt['height'] || 0),
      storedBytes: Number(receipt['storedBytes'] || 0),
      storedAt: Number(receipt['storedAt'] || 0),
      error: null,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Who this runtime signs as, with the HD account index each address actually
 * came from. The wallet uses account 0 for the home jurisdiction and the
 * jurisdiction-derived index elsewhere (`hosted.ts`), so the index is proved by
 * re-deriving the address rather than assumed: a wrong index would restore into
 * a different identity.
 */
export function recoverySigners(env: RuntimeReplica, seed: string): RuntimeRecoverySignerV1[] {
  const signers: RuntimeRecoverySignerV1[] = [];
  for (const replica of env.state.eReplicas.values()) {
    const address = String(replica.signerId).toLowerCase();
    if (signers.some(signer => signer.address === address)) continue;
    const jurisdiction = String(replica.state?.config?.jurisdiction?.name || '').trim();
    const candidate = jurisdiction ? deriveJurisdictionSignerIndex(jurisdiction) : 0;
    const derivationIndex =
      deriveAddress(seed, 0) === address ? 0 : deriveAddress(seed, candidate) === address ? candidate : -1;
    if (derivationIndex < 0) throw new Error(`RECOVERY_SIGNER_DERIVATION_UNKNOWN:${address}`);
    signers.push({
      index: signers.length,
      derivationIndex,
      address,
      name: jurisdiction ? `Signer on ${jurisdiction}` : `Signer ${signers.length + 1}`,
      entityId: String(replica.entityId).toLowerCase(),
      ...(jurisdiction ? { jurisdiction } : {}),
    });
  }
  return signers;
}

/**
 * One encrypted snapshot of the runtime at its committed tip, taken under the
 * Runtime's own committed-read lease so the checkpoint and its journal frame
 * belong to the same height.
 */
export async function encryptTip(
  xln: XLNModule,
  env: RuntimeReplica,
  seed: string,
): Promise<EncryptedRuntimeRecoveryBundleV1 | null> {
  const bundle = await withRuntimeCommittedRead(env, async () => {
    const height = Math.max(0, Math.floor(Number(env.state.height || 0)));
    if (height <= 0 || env.state.eReplicas.size === 0) return null;
    const frame = await xln.readPersistedFrameJournal(env, height);
    if (!frame) throw new Error(`RECOVERY_TIP_JOURNAL_MISSING:${height}`);
    return xln.buildRuntimeRecoveryBundle(env, {
      signers: recoverySigners(env, seed),
      meta: { label: 'xln wallet', activeSignerIndex: 0, loginType: 'manual', createdAt: Date.now() },
      kind: 'snapshot',
      frames: [frame],
    });
  });
  return bundle ? await xln.encryptRuntimeRecoveryBundle(bundle, seed) : null;
}

/** The appointment a tower verifies: the ciphertext plus the owner's signature over its envelope. */
async function buildBackupAppointment(
  xln: XLNModule,
  runtimeId: string,
  seed: string,
  encrypted: EncryptedRuntimeRecoveryBundleV1,
  signedAt: number,
): Promise<TowerAppointmentV1> {
  const message = xln.buildTowerAppointmentOwnerMessage(
    runtimeId,
    'blind_backup',
    encrypted.lookupKey,
    0,
    encrypted,
    signedAt,
    undefined,
  );
  const signature = await new Wallet(derivePrivateKey(seed, 0)).signMessage(message);
  return {
    type: 'tower_appointment',
    version: 1,
    towerMode: 'blind_backup',
    lookupKey: encrypted.lookupKey,
    slot: 0,
    bundle: encrypted,
    ownerProof: { runtimeId, signedAt, signature },
  };
}

export type BackupResult = { url: string; receipt: TowerReceiptV1 | null; error: string | null };

/**
 * Send the latest committed recovery snapshot to each tower. Returns one row per
 * tower so the screen can show exactly which of them accepted it; a tower that
 * refuses is reported, never swallowed.
 */
export async function backupToTowers(
  xln: XLNModule,
  env: RuntimeReplica,
  seed: string,
  towers: string[],
): Promise<BackupResult[]> {
  if (towers.length === 0) return [];
  const encrypted = await encryptTip(xln, env, seed);
  if (!encrypted) return [];
  const signedAt = Date.now();
  const appointment = await buildBackupAppointment(xln, encrypted.runtimeId, seed, encrypted, signedAt);
  const body = JSON.stringify(appointment);
  const bundleBytes = new TextEncoder().encode(JSON.stringify(encrypted)).byteLength;
  return Promise.all(
    towers.map(async url => {
      try {
        const health = await towerHealth(url);
        requireBackupCapacity(bundleBytes, health.maxStoredBytesPerLookupKey);
        requireBackupTransportCapacity(new TextEncoder().encode(body).byteLength, health.maxAppointmentBytes);
        const response = await fetch(towerRequestUrl(url, '/api/tower/appointment'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body,
        });
        const payload = asRecord(await response.json().catch(() => {
          throw new Error(`Recovery service returned an invalid response (HTTP ${response.status}).`);
        }));
        if (!response.ok || payload['ok'] !== true)
          throw new Error(String(payload['error'] || `HTTP_${response.status}`));
        const receipt = payload['receipt'];
        if (!receipt) throw new Error('TOWER_RECEIPT_MISSING');
        return { url, receipt: receipt as TowerReceiptV1, error: null };
      } catch (error) {
        return { url, receipt: null, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
