import { deserializeTaggedJson } from '../runtime/protocol/serialization';
import type { DaemonFrameLog } from './daemon-client';
import type { CustodyStore } from './store';

const ENTITY_ID_PATTERN = /^0x[0-9a-f]{64}$/;
const HASHLOCK_PATTERN = /^0x[0-9a-f]{64}$/;
const WITHDRAWAL_DESCRIPTION_PREFIX = 'custody-withdrawal:';

const logData = (log: DaemonFrameLog): Record<string, unknown> =>
  log.data && typeof log.data === 'object' && !Array.isArray(log.data) ? log.data : {};

const requiredString = (value: unknown, label: string): string => {
  const parsed = String(value ?? '').trim();
  if (!parsed) throw new Error(`CUSTODY_WITHDRAWAL_INITIATION_${label}_MISSING`);
  return parsed;
};

const parseWithdrawalId = (description: string): string | null => {
  if (!description.startsWith(WITHDRAWAL_DESCRIPTION_PREFIX)) return null;
  const firstSpace = description.indexOf(' ', WITHDRAWAL_DESCRIPTION_PREFIX.length);
  const id = description.slice(
    WITHDRAWAL_DESCRIPTION_PREFIX.length,
    firstSpace < 0 ? description.length : firstSpace,
  );
  if (!/^wd_[a-z0-9_]{8,64}$/i.test(id)) {
    throw new Error('CUSTODY_WITHDRAWAL_INITIATION_ID_INVALID');
  }
  return id;
};

const parseRoute = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('CUSTODY_WITHDRAWAL_INITIATION_ROUTE_INVALID');
  }
  const route = value.map(entry => String(entry).trim().toLowerCase());
  if (route.some(entityId => !ENTITY_ID_PATTERN.test(entityId))) {
    throw new Error('CUSTODY_WITHDRAWAL_INITIATION_ROUTE_INVALID');
  }
  return route;
};

/**
 * Binds a durable locally-emitted HtlcInitiated event to its reserved custody
 * withdrawal. The journal must do this before terminal events are consumed:
 * the payment can finalize before the HTTP submit call receives its response.
 */
export const bindCustodyWithdrawalInitiation = (
  store: CustodyStore,
  custodyEntityId: string,
  log: DaemonFrameLog,
): boolean => {
  if (log.message !== 'HtlcInitiated') return false;
  const data = logData(log);
  const entityId = requiredString(data['entityId'] ?? data['fromEntity'], 'ENTITY').toLowerCase();
  if (entityId !== custodyEntityId.toLowerCase()) return false;

  const description = requiredString(data['description'], 'DESCRIPTION');
  const withdrawalId = parseWithdrawalId(description);
  if (!withdrawalId) return false;

  const withdrawal = store.getWithdrawalById(withdrawalId);
  if (!withdrawal) throw new Error(`CUSTODY_WITHDRAWAL_INITIATION_UNKNOWN:${withdrawalId}`);
  const targetEntityId = requiredString(data['toEntity'], 'TARGET').toLowerCase();
  const tokenId = Number(data['tokenId']);
  const amountMinor = BigInt(requiredString(data['amount'], 'AMOUNT'));
  const hashlock = requiredString(data['hashlock'], 'HASHLOCK').toLowerCase();
  const route = parseRoute(data['route']);
  const storedRoute = deserializeTaggedJson<unknown>(withdrawal.routeJson ?? 'null');

  if (
    description !== withdrawal.description
    || targetEntityId !== withdrawal.targetEntityId.toLowerCase()
    || tokenId !== withdrawal.tokenId
    || amountMinor !== withdrawal.requestedAmountMinor
    || !HASHLOCK_PATTERN.test(hashlock)
    || !Array.isArray(storedRoute)
    || storedRoute.length !== route.length
    || storedRoute.some((entry, index) => String(entry).toLowerCase() !== route[index])
  ) {
    throw new Error(`CUSTODY_WITHDRAWAL_INITIATION_MISMATCH:${withdrawalId}`);
  }

  const updated = store.markWithdrawalSent({
    id: withdrawalId,
    hashlock,
    routeJson: withdrawal.routeJson!,
    updatedAt: log.timestamp || Date.now(),
  });
  if (!updated || (updated.status !== 'sent' && updated.status !== 'finalized')) {
    throw new Error(`CUSTODY_WITHDRAWAL_INITIATION_BIND_FAILED:${withdrawalId}`);
  }
  return true;
};
