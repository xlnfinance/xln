import type { JurisdictionEvent } from '../../types/jurisdiction-events';
import { normalizeJurisdictionEvent } from '../machine/event-normalization';
import { CANONICAL_J_EVENTS } from '../machine/event-catalog';
import type { JEventIngress } from './types';

const CANONICAL_EVENT_NAMES = new Set<string>(CANONICAL_J_EVENTS);

const isCanonicalEventName = (
  value: string,
): value is JurisdictionEvent['type'] => CANONICAL_EVENT_NAMES.has(value);

type RawEventPayload = {
  type: JurisdictionEvent['type'];
  data: Record<string, unknown>;
};

/**
 * AccountSettled is the only transport log that expands into several xln
 * events. Every other Solidity log maps to exactly one canonical event and
 * therefore enters the shared normalizer without an adapter-owned DTO.
 */
const expandAccountSettled = (
  event: JEventIngress,
  entityId: string,
): RawEventPayload[] => {
  const rawSettlements =
    event.args['settled'] ?? event.args[''] ?? event.args[0] ?? [];
  const events: RawEventPayload[] = [];
  for (const rawSettlement of Array.isArray(rawSettlements) ? rawSettlements : []) {
    const settlement = rawSettlement as Record<string, unknown> & unknown[];
    const leftEntity = settlement[0] ?? settlement['left'];
    const rightEntity = settlement[1] ?? settlement['right'];
    if (
      String(leftEntity).toLowerCase() !== entityId.toLowerCase() &&
      String(rightEntity).toLowerCase() !== entityId.toLowerCase()
    ) {
      continue;
    }
    const rawTokens = settlement[2] ?? settlement['tokens'] ?? [];
    const nonce = settlement[3] ?? settlement['nonce'];
    for (const rawToken of Array.isArray(rawTokens) ? rawTokens : []) {
      const token = rawToken as Record<string, unknown> & unknown[];
      events.push({
        type: 'AccountSettled',
        data: {
          leftEntity,
          rightEntity,
          tokenId: token[0] ?? token['tokenId'],
          leftReserve: token[1] ?? token['leftReserve'],
          rightReserve: token[2] ?? token['rightReserve'],
          collateral: token[3] ?? token['collateral'],
          ondelta: token[4] ?? token['ondelta'],
          nonce,
        },
      });
    }
  }
  return events;
};

const assertRawEventSpecificFields = (event: JEventIngress): void => {
  if (event.name === 'DisputeStarted') {
    const timeout = Number(event.args['disputeTimeout']);
    const startTs = Number(event.args['disputeStartTimestamp']);
    const leftResponseSeconds = Number(event.args['leftResponseSeconds']);
    const rightResponseSeconds = Number(event.args['rightResponseSeconds']);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new Error(
        `J_EVENT_DISPUTE_TIMEOUT_INVALID:block=${String(event.blockNumber)}` +
          `:timeout=${String(event.args['disputeTimeout'])}`,
      );
    }
    if (!Number.isSafeInteger(startTs) || startTs <= 0 || timeout < startTs) {
      throw new Error(
        `J_EVENT_DISPUTE_START_TIMESTAMP_INVALID:block=${String(event.blockNumber)}` +
          `:start=${String(event.args['disputeStartTimestamp'])}` +
          `:timeout=${String(event.args['disputeTimeout'])}`,
      );
    }
    if (
      !Number.isSafeInteger(leftResponseSeconds) ||
      !Number.isSafeInteger(rightResponseSeconds) ||
      leftResponseSeconds < 0 ||
      rightResponseSeconds < 0 ||
      leftResponseSeconds > 0xffff_ffff ||
      rightResponseSeconds > 0xffff_ffff ||
      timeout !== startTs + leftResponseSeconds + rightResponseSeconds
    ) {
      throw new Error(
        `J_EVENT_DISPUTE_CLOCK_INVALID:block=${String(event.blockNumber)}` +
          `:start=${String(event.args['disputeStartTimestamp'])}` +
          `:timeout=${String(event.args['disputeTimeout'])}` +
          `:left=${String(event.args['leftResponseSeconds'])}` +
          `:right=${String(event.args['rightResponseSeconds'])}`,
      );
    }
  }
  if (event.name !== 'ExternalWalletSnapshot') return;
  for (const entry of Array.isArray(event.args['tokenBalances'])
    ? event.args['tokenBalances']
    : []) {
    if (!entry || typeof entry !== 'object' || !('balance' in entry)) {
      throw new Error('EXTERNAL_WALLET_SNAPSHOT_BALANCE_MISSING');
    }
  }
  for (const entry of Array.isArray(event.args['allowances'])
    ? event.args['allowances']
    : []) {
    if (!entry || typeof entry !== 'object' || !('allowance' in entry)) {
      throw new Error('EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_MISSING');
    }
  }
};

const withTransportMetadata = (
  event: JEventIngress,
  payload: RawEventPayload,
  eventIndex: number | undefined,
): unknown => ({
  ...payload,
  ...(event.blockNumber !== undefined ? { blockNumber: event.blockNumber } : {}),
  ...(event.blockHash ? { blockHash: event.blockHash } : {}),
  ...(event.transactionHash ? { transactionHash: event.transactionHash } : {}),
  ...(event.logIndex !== undefined ? { logIndex: event.logIndex } : {}),
  ...(eventIndex !== undefined ? { eventIndex } : {}),
});

export const rawEventToJEvents = (
  event: JEventIngress,
  entityId: string,
): JurisdictionEvent[] => {
  if (!isCanonicalEventName(event.name)) {
    throw new Error(`J_EVENT_CANONICAL_PAYLOAD_EMPTY:${event.name}`);
  }
  assertRawEventSpecificFields(event);
  const payloads = event.name === 'AccountSettled'
    ? expandAccountSettled(event, entityId)
    : [{ type: event.name, data: event.args }];
  if (payloads.length === 0) {
    throw new Error(`J_EVENT_CANONICAL_PAYLOAD_EMPTY:${event.name}`);
  }
  return payloads.map((payload, index) => {
    const normalized = normalizeJurisdictionEvent(
      withTransportMetadata(
        event,
        payload,
        payloads.length > 1 ? index : undefined,
      ),
    );
    if (!normalized) {
      throw new Error(
        `J_EVENT_CANONICAL_PAYLOAD_INVALID:${event.name}` +
          `:block=${String(event.blockNumber ?? 'unknown')}` +
          `:tx=${String(event.transactionHash ?? 'unknown')}`,
      );
    }
    return normalized;
  });
};
