import { ethers } from 'ethers';
import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';
import type {
  TowerAppointmentV1,
  TowerDiscoverResponseV1,
  TowerRestoreRequestV1,
  TowerRestoreResponseV1,
} from '../recovery/types';
import {
  buildTowerAppointmentOwnerMessage,
} from '../recovery/crypto';
import type { WatchtowerStore } from './store';
import { runWatchtowerSweep } from './action';

const DEFAULT_MAX_JSON_BODY_BYTES = 128 * 1024;
const SMALL_MAX_JSON_BODY_BYTES = 8 * 1024;

const parseContentLength = (request: Request): number | null => {
  const header = request.headers.get('content-length');
  if (!header) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

const readCappedRequestBody = async (request: Request, maxBytes: number): Promise<string> => {
  const contentLength = parseContentLength(request);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new Error(`TOWER_BODY_TOO_LARGE: bytes=${contentLength} max=${maxBytes}`);
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`TOWER_BODY_TOO_LARGE: bytes=${total} max=${maxBytes}`);
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
};

const parseJsonBody = async <T>(request: Request, maxBytes = DEFAULT_MAX_JSON_BODY_BYTES): Promise<T> => {
  const raw = await readCappedRequestBody(request, maxBytes);
  if (!raw.trim()) {
    throw new Error('TOWER_BODY_EMPTY');
  }
  return JSON.parse(raw) as T;
};

const normalizeLookupKey = (lookupKey: unknown): string => {
  const value = String(lookupKey || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`TOWER_LOOKUP_KEY_INVALID: ${String(lookupKey)}`);
  }
  return value;
};

const normalizeBytes32 = (value: unknown, label: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`TOWER_${label}_INVALID: ${String(value)}`);
  }
  return normalized;
};

const normalizeHexBytes = (value: unknown, label: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x([0-9a-f]{2})*$/.test(normalized)) {
    throw new Error(`TOWER_${label}_INVALID`);
  }
  return normalized;
};

const normalizeNonNegativeInt = (value: unknown, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`TOWER_${label}_INVALID`);
  }
  return Math.floor(parsed);
};

const quotaExceededStatus = (message: string): number =>
  message.startsWith('TOWER_QUOTA_EXCEEDED') || message.startsWith('TOWER_BODY_TOO_LARGE') ? 413 : 400;

const verifyEncryptedBundleShape = (appointment: TowerAppointmentV1): void => {
  if (!appointment.bundle || appointment.bundle.version !== 1) {
    throw new Error('TOWER_BUNDLE_VERSION_UNSUPPORTED');
  }
  const runtimeId = String(appointment.bundle.runtimeId || '').trim().toLowerCase();
  if (!runtimeId) {
    throw new Error('TOWER_BUNDLE_RUNTIME_ID_REQUIRED');
  }
  normalizeLookupKey(appointment.bundle.lookupKey);
  normalizeNonNegativeInt(appointment.bundle.height, 'BUNDLE_HEIGHT');
  normalizeNonNegativeInt(appointment.bundle.createdAt, 'BUNDLE_CREATED_AT');
  normalizeBytes32(appointment.bundle.bundleHash, 'BUNDLE_HASH');
  normalizeHexBytes(appointment.bundle.iv, 'BUNDLE_IV');
  const ciphertext = normalizeHexBytes(appointment.bundle.ciphertext, 'BUNDLE_CIPHERTEXT');
  if (ciphertext.length <= 2) {
    throw new Error('TOWER_BUNDLE_CIPHERTEXT_EMPTY');
  }
  if (appointment.bundle.compression !== undefined && appointment.bundle.compression !== 'gzip') {
    throw new Error(`TOWER_BUNDLE_COMPRESSION_UNSUPPORTED: ${String(appointment.bundle.compression)}`);
  }
};

const assertEncryptedActivePayload = (activePayload: TowerAppointmentV1['activePayload']): void => {
  const raw = String(activePayload?.encryptedRemedy || '').trim();
  if (!raw) {
    throw new Error('TOWER_ACTIVE_PAYLOAD_REMEDY_MISSING');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = deserializeTaggedJson<Record<string, unknown>>(raw);
  } catch {
    throw new Error('TOWER_ACTIVE_PAYLOAD_REMEDY_NOT_ENCRYPTED');
  }
  if (
    parsed['type'] !== 'tower_encrypted_payload' ||
    parsed['version'] !== 1 ||
    parsed['alg'] !== 'secp256k1-aes-256-gcm' ||
    typeof parsed['epk'] !== 'string' ||
    typeof parsed['iv'] !== 'string' ||
    typeof parsed['ciphertext'] !== 'string' ||
    typeof parsed['plaintextHash'] !== 'string'
  ) {
    throw new Error('TOWER_ACTIVE_PAYLOAD_REMEDY_NOT_ENCRYPTED');
  }
};

const verifyLastResortPayload = (activePayload: TowerAppointmentV1['activePayload']): void => {
  if (!activePayload) {
    throw new Error('TOWER_ACTIVE_PAYLOAD_MISSING');
  }
  if (activePayload.actionKind !== 'counter_dispute_only') {
    throw new Error('TOWER_ACTIVE_PAYLOAD_ACTION_KIND_UNSUPPORTED');
  }
  if (activePayload.responseMode !== 'last_resort') {
    throw new Error('TOWER_ACTIVE_PAYLOAD_RESPONSE_MODE_UNSUPPORTED');
  }
  const triggerHint = String(activePayload.triggerHint || '').trim();
  if (!triggerHint || triggerHint.length > 256) {
    throw new Error('TOWER_ACTIVE_PAYLOAD_TRIGGER_HINT_INVALID');
  }
  if (normalizeNonNegativeInt(activePayload.appointmentSequence, 'ACTIVE_PAYLOAD_APPOINTMENT_SEQUENCE') <= 0) {
    throw new Error('TOWER_ACTIVE_PAYLOAD_APPOINTMENT_SEQUENCE_INVALID');
  }
  if (normalizeNonNegativeInt(activePayload.proofNonce, 'ACTIVE_PAYLOAD_PROOF_NONCE') <= 0) {
    throw new Error('TOWER_ACTIVE_PAYLOAD_PROOF_NONCE_INVALID');
  }
  normalizeBytes32(activePayload.proofBodyHash, 'ACTIVE_PAYLOAD_PROOF_BODY_HASH');
  if (normalizeNonNegativeInt(activePayload.lastResortWindowBlocks, 'ACTIVE_PAYLOAD_LAST_RESORT_WINDOW') <= 0) {
    throw new Error('TOWER_ACTIVE_PAYLOAD_LAST_RESORT_WINDOW_INVALID');
  }
  normalizeNonNegativeInt(activePayload.safetyMarginBlocks, 'ACTIVE_PAYLOAD_SAFETY_MARGIN');
  assertEncryptedActivePayload(activePayload);
};

const verifyTowerAppointment = (appointment: TowerAppointmentV1): TowerAppointmentV1 => {
  if (!appointment || appointment.type !== 'tower_appointment' || appointment.version !== 1) {
    throw new Error('TOWER_APPOINTMENT_INVALID');
  }
  verifyEncryptedBundleShape(appointment);
  const lookupKey = normalizeLookupKey(appointment.lookupKey);
  if (appointment.bundle.lookupKey !== lookupKey) {
    throw new Error('TOWER_APPOINTMENT_LOOKUP_MISMATCH');
  }
  const runtimeId = String(appointment.ownerProof?.runtimeId || '').trim().toLowerCase();
  if (!runtimeId || runtimeId !== String(appointment.bundle.runtimeId || '').trim().toLowerCase()) {
    throw new Error('TOWER_APPOINTMENT_RUNTIME_ID_MISMATCH');
  }
  const signedAt = Math.max(0, Math.floor(Number(appointment.ownerProof?.signedAt || 0)));
  const slot = Math.max(0, Math.floor(Number(appointment.slot ?? 0)));
  if (appointment.towerMode === 'active_watchtower') {
    throw new Error('TOWER_ACTIVE_WATCHTOWER_DISABLED');
  }
  const towerMode = appointment.towerMode === 'delayed_last_resort'
    ? appointment.towerMode
    : 'blind_backup';
  if (towerMode === 'blind_backup' && appointment.activePayload) {
    throw new Error('TOWER_BACKUP_ACTIVE_PAYLOAD_FORBIDDEN');
  }
  if (towerMode === 'delayed_last_resort') {
    verifyLastResortPayload(appointment.activePayload);
  }
  const message = buildTowerAppointmentOwnerMessage(
    runtimeId,
    towerMode,
    lookupKey,
    slot,
    appointment.bundle.bundleHash,
    appointment.bundle.height,
    signedAt,
    appointment.activePayload,
  );
  const recovered = ethers.verifyMessage(message, String(appointment.ownerProof?.signature || '')).toLowerCase();
  if (recovered !== runtimeId) {
    throw new Error(`TOWER_APPOINTMENT_SIGNATURE_INVALID: recovered=${recovered} expected=${runtimeId}`);
  }
  return {
    ...appointment,
    towerMode,
    lookupKey,
    slot,
    ownerProof: {
      ...appointment.ownerProof,
      runtimeId,
      signedAt,
      signature: String(appointment.ownerProof.signature || ''),
    },
    bundle: {
      ...appointment.bundle,
      runtimeId,
      lookupKey,
      height: Math.max(0, Math.floor(Number(appointment.bundle.height || 0))),
      createdAt: Math.max(0, Math.floor(Number(appointment.bundle.createdAt || 0))),
    },
  };
};

const errorResponse = (error: unknown): Response => {
  const message = error instanceof Error ? error.message : String(error);
  return new Response(
    serializeTaggedJson({ ok: false, error: message }),
    {
      status: quotaExceededStatus(message),
      headers: { 'content-type': 'application/json' },
    },
  );
};

export const handleTowerAppointment = async (req: Request, store: WatchtowerStore): Promise<Response> => {
  try {
    const appointment = verifyTowerAppointment(await parseJsonBody<TowerAppointmentV1>(req));
    const receipt = await store.upsertAppointment(appointment);
    return new Response(serializeTaggedJson({ ok: true, receipt }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return errorResponse(error);
  }
};

export const handleTowerRestore = async (req: Request, store: WatchtowerStore): Promise<Response> => {
  try {
    const body = await parseJsonBody<TowerRestoreRequestV1>(req);
    const lookupKey = normalizeLookupKey(body.lookupKey);
    const restored = await store.getLatest(lookupKey);
    if (!restored) {
      return new Response(serializeTaggedJson({ ok: false, error: 'TOWER_BUNDLE_NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const response: TowerRestoreResponseV1 = { ok: true, receipt: restored.receipt, bundle: restored.bundle };
    return new Response(serializeTaggedJson(response), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return errorResponse(error);
  }
};

export const handleTowerReceipt = async (lookupKey: string, store: WatchtowerStore): Promise<Response> => {
  try {
    const normalized = normalizeLookupKey(lookupKey);
    const receipt = await store.getLatestReceipt(normalized);
    if (!receipt) {
      return new Response(serializeTaggedJson({ ok: false, error: 'TOWER_RECEIPT_NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(serializeTaggedJson({ ok: true, receipt }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return errorResponse(error);
  }
};

export const handleRecoveryDiscover = async (req: Request, store: WatchtowerStore): Promise<Response> => {
  try {
    const body = await parseJsonBody<TowerRestoreRequestV1>(req);
    const lookupKey = normalizeLookupKey(body.lookupKey);
    const latestReceipt = await store.getLatestReceipt(lookupKey);
    const response: TowerDiscoverResponseV1 = {
      ok: true,
      lookupKey,
      available: !!latestReceipt,
      latestReceipt,
    };
    return new Response(serializeTaggedJson(response), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return errorResponse(error);
  }
};

export const handleRecoveryState = async (req: Request, store: WatchtowerStore): Promise<Response> =>
  handleTowerRestore(req, store);

export const handleRecoveryComplaint = async (req: Request, store: WatchtowerStore): Promise<Response> => {
  try {
    if (process.env['XLN_WATCHTOWER_ACCEPT_COMPLAINTS'] !== '1') {
      return new Response(serializeTaggedJson({ ok: false, error: 'TOWER_COMPLAINTS_DISABLED' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = await parseJsonBody<Record<string, unknown>>(req, SMALL_MAX_JSON_BODY_BYTES);
    await store.appendComplaint({
      type: 'recovery_complaint',
      lookupKey: typeof body['lookupKey'] === 'string' ? body['lookupKey'] : undefined,
      reason: typeof body['reason'] === 'string' ? body['reason'] : 'unspecified',
      details: body['details'] && typeof body['details'] === 'object' ? body['details'] as Record<string, unknown> : undefined,
    });
    return new Response(serializeTaggedJson({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return errorResponse(error);
  }
};

export const handleWatchtowerSweep = async (
  req: Request,
  store: WatchtowerStore,
  options?: { towerPrivateKey?: string },
): Promise<Response> => {
  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const lookupKey = typeof body['lookupKey'] === 'string' ? normalizeLookupKey(body['lookupKey']) : undefined;
    const result = await runWatchtowerSweep(store, {
      ...(lookupKey ? { lookupKey } : {}),
      ...(options?.towerPrivateKey ? { towerPrivateKey: options.towerPrivateKey } : {}),
    });
    return new Response(serializeTaggedJson({ ok: true, ...result }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return errorResponse(error);
  }
};

export const handleWatchtowerActions = async (lookupKey: string, store: WatchtowerStore): Promise<Response> => {
  try {
    const normalized = normalizeLookupKey(lookupKey);
    const receipts = await store.listActionReceipts(normalized);
    return new Response(serializeTaggedJson({ ok: true, receipts }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return errorResponse(error);
  }
};
