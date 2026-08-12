import type { EntityState } from '../../entity/types';
import {
  cloneCrossJurisdictionBookAdmission,
  cloneCrossJurisdictionAccountTxRoute,
  cloneCrossJurisdictionRoute,
} from '../../extensions/cross-j/index';

export const withDefinedProperty = <K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> => value === undefined ? {} : ({ [key]: value } as Record<K, V>);

export const cloneStoredCrossJurisdictionRoutes = (
  routes: EntityState['crossJurisdictionSwaps'],
): EntityState['crossJurisdictionSwaps'] | undefined =>
  routes ? new Map(Array.from(routes.entries()).map(([id, route]) => [id, cloneCrossJurisdictionRoute(route)])) : undefined;

export const cloneStoredCrossJurisdictionBookAdmissions = (
  admissions: EntityState['crossJurisdictionBookAdmissions'],
): EntityState['crossJurisdictionBookAdmissions'] | undefined =>
  admissions ? new Map(Array.from(admissions.entries()).map(([id, admission]) => [
    id,
    cloneCrossJurisdictionBookAdmission(admission),
  ])) : undefined;

export const cloneStoredPendingCrossJurisdictionFillAcks = (
  pendingAcks: EntityState['pendingCrossJurisdictionFillAcks'],
): EntityState['pendingCrossJurisdictionFillAcks'] | undefined =>
  pendingAcks ? new Map(Array.from(pendingAcks.entries()).map(([id, pending]) => [
    id,
    {
      ...pending,
      tx: cloneCrossJurisdictionAccountTxRoute(pending.tx) as typeof pending.tx,
    },
  ])) : undefined;
