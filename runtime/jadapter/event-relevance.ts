import {
  CANONICAL_J_EVENTS,
  type CanonicalJEvent,
} from '../jurisdiction/event-catalog';
import type { RuntimeReplica } from '../runtime/types';
import type { JEventIngress } from './types';

export type CanonicalJEventIngress = JEventIngress & {
  name: CanonicalJEvent;
};

const canonicalEventNames = new Set<string>(CANONICAL_J_EVENTS);

export const isCanonicalEvent = (
  event: JEventIngress,
): event is CanonicalJEventIngress => canonicalEventNames.has(event.name);

const normalizedId = (value: unknown): string => String(value).toLowerCase();

const accountSettlementNamesEntity = (
  event: CanonicalJEventIngress,
  entityId: string,
): boolean => {
  const settledRaw = event.args['settled'] ?? event.args[''] ?? event.args[0] ?? [];
  const settlements = Array.isArray(settledRaw) ? settledRaw : [];
  return settlements.some(rawSettlement => {
    const settlement = rawSettlement as Record<string, unknown> & unknown[];
    return (
      normalizedId(settlement[0] ?? settlement['left']) === entityId ||
      normalizedId(settlement[1] ?? settlement['right']) === entityId
    );
  });
};

/**
 * One exhaustive fan-out policy for every canonical Jurisdiction event.
 *
 * Unknown transport logs are ignored before this boundary. Adding a canonical
 * event without deciding its Entity audience is a compile-time error here.
 */
export const isEventRelevantToEntity = (
  event: JEventIngress,
  entityId: string,
): boolean => {
  if (!isCanonicalEvent(event)) return false;

  const normalizedEntity = normalizedId(entityId);
  const args = event.args;
  switch (event.name) {
    case 'FoundationBootstrapped':
    case 'EntityRegistered':
    case 'BoardActivated':
    case 'SecretRevealed':
      return true;
    case 'ReserveUpdated':
      return normalizedId(args['entity']) === normalizedEntity;
    case 'ExternalWalletSnapshot':
    case 'ExternalWalletDelta':
    case 'HankoBatchProcessed':
    case 'BatchOperationSkipped':
    case 'EntityProviderActionExecuted':
    case 'EntityProviderActionCancelled':
      return normalizedId(args['entityId']) === normalizedEntity;
    case 'AccountSettled':
      return accountSettlementNamesEntity(event, normalizedEntity);
    case 'DisputeStarted':
    case 'DisputeFinalized':
      return (
        normalizedId(args['sender']) === normalizedEntity ||
        normalizedId(args['counterentity']) === normalizedEntity
      );
    case 'DebtCreated':
    case 'DebtEnforced':
    case 'DebtForgiven':
      return (
        normalizedId(args['debtor']) === normalizedEntity ||
        normalizedId(args['creditor']) === normalizedEntity
      );
    default: {
      const unhandledEvent: never = event.name;
      throw new Error(`J_EVENT_RELEVANCE_UNHANDLED:${String(unhandledEvent)}`);
    }
  }
};

export const collectRelevantJEventReplicaKeys = (
  env: RuntimeReplica,
  events: JEventIngress[],
): string[] => {
  const canonicalEvents = events.filter(isCanonicalEvent);
  if (canonicalEvents.length === 0) return [];

  const replicaKeys = new Set<string>();
  for (const [replicaKey, replica] of env.state.eReplicas?.entries?.() || []) {
    const [entityIdFromKey] = replicaKey.split(':');
    const entityId = String(
      replica?.state?.entityId || replica?.entityId || entityIdFromKey || '',
    ).toLowerCase();
    if (
      entityId &&
      canonicalEvents.some(event => isEventRelevantToEntity(event, entityId))
    ) {
      replicaKeys.add(replicaKey);
    }
  }
  return [...replicaKeys].sort();
};
