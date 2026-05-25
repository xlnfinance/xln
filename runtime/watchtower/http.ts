import { ethers } from 'ethers';
import { serializeTaggedJson } from '../serialization-utils';
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

const parseJsonBody = async <T>(request: Request): Promise<T> => {
  return await request.json() as T;
};

const normalizeLookupKey = (lookupKey: unknown): string => {
  const value = String(lookupKey || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`TOWER_LOOKUP_KEY_INVALID: ${String(lookupKey)}`);
  }
  return value;
};

const quotaExceededStatus = (message: string): number => message.startsWith('TOWER_QUOTA_EXCEEDED') ? 413 : 400;

const verifyTowerAppointment = (appointment: TowerAppointmentV1): TowerAppointmentV1 => {
  if (!appointment || appointment.type !== 'tower_appointment' || appointment.version !== 1) {
    throw new Error('TOWER_APPOINTMENT_INVALID');
  }
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
  const towerMode =
    appointment.towerMode === 'active_watchtower' || appointment.towerMode === 'delayed_last_resort'
      ? appointment.towerMode
      : 'blind_backup';
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
    const body = await parseJsonBody<Record<string, unknown>>(req);
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

export const handleWatchtowerSweep = async (req: Request, store: WatchtowerStore): Promise<Response> => {
  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const lookupKey = typeof body['lookupKey'] === 'string' ? normalizeLookupKey(body['lookupKey']) : undefined;
    const result = await runWatchtowerSweep(store, lookupKey ? { lookupKey } : undefined);
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
