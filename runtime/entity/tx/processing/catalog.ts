import type { EntityTx } from '../../../types/entity-tx';

/**
 * The one catalog of Entity transaction discriminants.
 *
 * Runtime ingress uses it only to reject unknown variants before mutation.
 * Machine-specific admission may still prepare a raw transaction, while the
 * WAL decoder validates the complete committed payload after preparation.
 * Applying the WAL schema at raw ingress would reject legitimate transactions
 * whose deterministic fields are filled by Entity admission.
 */
export const ENTITY_TX_TYPES = [
  'accountInput', 'admitCrossJurisdictionBookOrder', 'applyCrossJurisdictionBookProgress',
  'certifyProfile', 'chat', 'chatMessage',
  'consensusOutput', 'crossJurisdictionBookOrderRemoved', 'crossJurisdictionFillNotice',
  'crossJurisdictionForceSiblingDispute',
  'crossJurisdictionSalvage',
  'crossPullClose', 'directPayment', 'disputeFinalize', 'disputeStart', 'e2r',
  'entityCommand', 'entityProviderCancelAction', 'entityProviderReleaseControlShares',
  'entityProviderTransfer', 'extendCredit', 'htlcOnionAdvance', 'htlcPayment',
  'initOrderbookExt', 'j_abort_sent_batch', 'j_broadcast', 'j_clear_batch', 'j_event',
  'j_rebroadcast', 'lendingBorrow', 'lendingClosePosition',
  'lendingOffer', 'lendingRepay', 'mintReserves', 'openAccount',
  'orderbookSweepCrossJurisdiction', 'placeSwapOffer',
  'prepareCrossJurisdictionSwap', 'prepareDispute', 'processHtlcTimeouts', 'profile-update',
  'propose', 'proposeCancelSwap', 'r2c', 'r2e', 'r2r',
  'registerCrossJurisdictionSwap', 'reissueCertifiedOutput', 'removeCrossJurisdictionBookOrder',
  'requestCollateral', 'requestCrossJurisdictionClear',
  'materializeCrossJurisdictionClear', 'materializeCrossJurisdictionSwap',
  'resolveHtlcLock',
  'runtimeOutput', 'scheduledWake', 'setHubConfig', 'setRebalancePolicy',
  'settle_approve', 'settle_execute', 'settle_propose', 'settle_reject', 'settle_update', 'vote',
] as const satisfies readonly EntityTx['type'][];

type MissingEntityTxType = Exclude<
  EntityTx['type'],
  (typeof ENTITY_TX_TYPES)[number]
>;
const ENTITY_TX_TYPES_ARE_EXHAUSTIVE: MissingEntityTxType extends never
  ? true
  : never = true;
void ENTITY_TX_TYPES_ARE_EXHAUSTIVE;

const KNOWN_ENTITY_TX_TYPES: ReadonlySet<string> = new Set(ENTITY_TX_TYPES);

export const requireKnownEntityTxType = (
  value: unknown,
  code: string,
): EntityTx['type'] => {
  if (!value || typeof value !== 'object') throw new Error(`${code}_INVALID`);
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !KNOWN_ENTITY_TX_TYPES.has(type)) {
    throw new Error(`${code}_TYPE_UNKNOWN:${String(type)}`);
  }
  return type as EntityTx['type'];
};
