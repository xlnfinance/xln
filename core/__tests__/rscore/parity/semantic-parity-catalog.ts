import type { AccountTx } from '../../../types/account';
import type { EntityTx } from '../../../types/entity-tx';

type SemanticEvidence =
  | Readonly<{
      semanticEvidence: 'covered';
      evidence: readonly [string, ...string[]];
    }>
  | Readonly<{
      semanticEvidence: 'missing';
    }>;

export type AccountTxSemanticCatalogEntry<K extends AccountTx['type'] = AccountTx['type']> = Readonly<{
  layer: 'account';
  type: K;
  productionPath: string;
}> & SemanticEvidence;

export type EntityTxSemanticCatalogEntry<K extends EntityTx['type'] = EntityTx['type']> = Readonly<{
  layer: 'entity';
  type: K;
  productionPath: string;
}> & SemanticEvidence;

const covered = <K extends AccountTx['type']>(
  layer: 'account',
  type: K,
  productionPath: string,
  evidence: readonly [string, ...string[]],
): AccountTxSemanticCatalogEntry<K> => ({
  layer,
  type,
  productionPath,
  semanticEvidence: 'covered',
  evidence,
});

const missingEntity = <K extends EntityTx['type']>(
  type: K,
  productionPath: string,
): EntityTxSemanticCatalogEntry<K> => ({
  layer: 'entity', type, productionPath, semanticEvidence: 'missing',
});

const coveredEntity = <K extends EntityTx['type']>(
  type: K,
  productionPath: string,
  evidence: readonly [string, ...string[]],
): EntityTxSemanticCatalogEntry<K> => ({
  layer: 'entity', type, productionPath, semanticEvidence: 'covered', evidence,
});

const ACCOUNT_BALANCE_EVIDENCE = [
  'rscore/crates/engine/tests/balance_parity.rs',
] as const;
const ACCOUNT_HTLC_EVIDENCE = [
  'rscore/crates/engine/tests/htlc_parity.rs',
] as const;
const ACCOUNT_LENDING_EVIDENCE = [
  'core/__tests__/rscore/parity/account-lending-semantic-parity.test.ts',
  'rscore/crates/engine/tests/lending_parity.rs',
  'rscore/fixtures/account-semantics/lending-v1.json',
] as const;
const ACCOUNT_CROSS_J_EVIDENCE = [
  'core/__tests__/rscore/parity/account-cross-j-semantic-parity.test.ts',
  'rscore/crates/runtime/tests/account_cross_j_semantic_parity.rs',
  'rscore/fixtures/account-semantics/cross-j-v1.json',
] as const;
const ACCOUNT_REBALANCE_SETTLEMENT_EVIDENCE = [
  'core/__tests__/rscore/parity/account-rebalance-settlement-semantic-parity.test.ts',
  'rscore/crates/runtime/tests/account_rebalance_settlement_semantic_parity.rs',
  'rscore/fixtures/account-semantics/rebalance-settlement-v1.json',
] as const;
const ACCOUNT_J_EVENT_EVIDENCE = [
  'rscore/crates/engine/tests/j_event_claim_parity.rs',
] as const;
const CROSS_J_OPENING_LIFECYCLE_EVIDENCE = [
  'core/__tests__/rscore/parity/cross-j-opening-lifecycle.test.ts',
  'rscore/crates/runtime/src/machine/tests/cross_j_lifecycle_fixture.rs',
  'rscore/fixtures/cross-j-opening/lifecycle-v1.json',
] as const;
const ENTITY_SAME_J_FINANCIAL_EVIDENCE = [
  'core/__tests__/rscore/parity/entity-same-j-financial-semantic-parity.test.ts',
  'rscore/crates/entity-kernel/src/local_financial/same_j_semantic_parity.rs',
  'rscore/fixtures/entity-kernel/same-j-financial-v1.json',
] as const;
const ENTITY_ROUTING_SEMANTIC_EVIDENCE = [
  'core/__tests__/rscore/parity/entity-routing-semantic-parity.test.ts',
  'rscore/crates/entity-kernel/tests/entity_routing_semantic_parity.rs',
  'rscore/crates/entity-kernel/src/local_financial/routing_semantic_parity.rs',
  'rscore/fixtures/entity-routing-semantics/parity-v1.json',
] as const;
const ENTITY_CONTROL_SEMANTIC_EVIDENCE = [
  'rscore/fixtures/entity-control-semantics/generate.ts',
  'rscore/crates/entity-kernel/tests/entity_control_semantic_parity.rs',
  'rscore/fixtures/entity-control-semantics/group-b-v1.json',
] as const;
const MIXED_REPLAY_EVIDENCE = [
  'core/scripts/operations/hlt/replay/authority-evidence.ts',
  'core/scripts/operations/hlt/replay/commands/run-mixed-ts-rust-parity.ts',
] as const;

/**
 * Semantic parity inventory, in exact canonical AccountTx catalog order.
 * `covered` is deliberately narrower than codec support: it requires an
 * existing Rust execution assertion against an explicit TypeScript semantic
 * result. Wire vectors alone never advance this status.
 */
export const ACCOUNT_TX_SEMANTIC_CATALOG = [
  covered('account', 'direct_payment', 'core/account/tx/handlers/balance/direct-payment.ts', ACCOUNT_BALANCE_EVIDENCE),
  covered('account', 'lending_fund', 'core/account/tx/handlers/balance/lending.ts', ACCOUNT_LENDING_EVIDENCE),
  covered('account', 'lending_borrow_request', 'core/account/tx/handlers/balance/lending.ts', ACCOUNT_LENDING_EVIDENCE),
  covered('account', 'lending_repay', 'core/account/tx/handlers/balance/lending.ts', ACCOUNT_LENDING_EVIDENCE),
  covered('account', 'lending_credit', 'core/account/tx/handlers/balance/lending.ts', ACCOUNT_LENDING_EVIDENCE),
  covered('account', 'lending_close_request', 'core/account/tx/handlers/balance/lending.ts', ACCOUNT_LENDING_EVIDENCE),
  covered('account', 'lending_close_payout', 'core/account/tx/handlers/balance/lending.ts', ACCOUNT_LENDING_EVIDENCE),
  covered('account', 'add_delta', 'core/account/tx/handlers/balance/add-delta.ts', ACCOUNT_BALANCE_EVIDENCE),
  covered('account', 'set_credit_limit', 'core/account/tx/handlers/balance/set-credit-limit.ts', ACCOUNT_BALANCE_EVIDENCE),
  covered(
    'account',
    'request_collateral',
    'core/account/tx/handlers/rebalance/request-collateral.ts',
    ACCOUNT_REBALANCE_SETTLEMENT_EVIDENCE,
  ),
  covered('account', 'rebalance_refund', 'core/account/tx/handlers/rebalance/refund.ts', ACCOUNT_REBALANCE_SETTLEMENT_EVIDENCE),
  covered('account', 'rebalance_policy', 'core/account/tx/handlers/rebalance/policy.ts', MIXED_REPLAY_EVIDENCE),
  covered('account', 'htlc_lock', 'core/account/tx/handlers/htlc/lock.ts', ACCOUNT_HTLC_EVIDENCE),
  covered('account', 'htlc_resolve', 'core/account/tx/handlers/htlc/resolve.ts', ACCOUNT_HTLC_EVIDENCE),
  covered('account', 'cross_pull_lock', 'core/account/tx/handlers/settlement/pull.ts', ACCOUNT_CROSS_J_EVIDENCE),
  covered('account', 'cross_pull_close', 'core/account/tx/handlers/settlement/pull.ts', ACCOUNT_CROSS_J_EVIDENCE),
  covered('account', 'swap_offer', 'core/account/tx/handlers/swap/offer/index.ts', MIXED_REPLAY_EVIDENCE),
  covered('account', 'swap_cancel_request', 'core/account/tx/handlers/swap/lifecycle/cancel.ts', MIXED_REPLAY_EVIDENCE),
  covered('account', 'swap_resolve', 'core/account/tx/handlers/swap/resolve/index.ts', MIXED_REPLAY_EVIDENCE),
  covered('account', 'settle_transition', 'core/account/tx/handlers/settlement/transition.ts', ACCOUNT_REBALANCE_SETTLEMENT_EVIDENCE),
  covered('account', 'j_event_claim', 'core/account/tx/handlers/j-events/claim.ts', ACCOUNT_J_EVENT_EVIDENCE),
] as const satisfies readonly AccountTxSemanticCatalogEntry[];

/** Semantic parity inventory, in exact canonical EntityTx catalog order. */
export const ENTITY_TX_SEMANTIC_CATALOG = [
  coveredEntity('accountInput', 'core/entity/tx/handlers/account/index.ts', MIXED_REPLAY_EVIDENCE),
  coveredEntity('admitCrossJurisdictionBookOrder', 'core/entity/tx/handlers/cross-j/book-order.ts', CROSS_J_OPENING_LIFECYCLE_EVIDENCE),
  coveredEntity('boardHandover', 'core/entity/tx/handlers/board-handover.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('chat', 'core/entity/tx/handlers/system/basic.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('chatMessage', 'core/entity/tx/handlers/system/basic.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  missingEntity('crossJurisdictionBookOrderRemoved', 'core/entity/tx/handlers/cross-j/book-order.ts'),
  missingEntity('crossJurisdictionFillNotice', 'core/entity/tx/handlers/cross-j/fill.ts'),
  missingEntity('crossJurisdictionForceSiblingDispute', 'core/entity/tx/handlers/cross-j/force-sibling-dispute.ts'),
  missingEntity('crossJurisdictionSalvage', 'core/entity/tx/handlers/cross-j/salvage.ts'),
  missingEntity('crossPullClose', 'core/entity/tx/handlers/payments/pull.ts'),
  coveredEntity('directPayment', 'core/entity/tx/handlers/payments/direct-payment.ts', MIXED_REPLAY_EVIDENCE),
  coveredEntity('disputeFinalize', 'core/entity/tx/handlers/dispute/index.ts', MIXED_REPLAY_EVIDENCE),
  missingEntity('disputeStart', 'core/entity/tx/handlers/dispute/index.ts'),
  coveredEntity('e2r', 'core/entity/tx/handlers/j-batch/e2r.ts', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('entityCommand', 'core/entity/consensus/frame/application.ts#applyNestedEntityTx', CROSS_J_OPENING_LIFECYCLE_EVIDENCE),
  coveredEntity('entityProviderActivateBoard', 'core/entity/tx/handlers/control-board-proposal.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('entityProviderCancelAction', 'core/entity/tx/handlers/entity-provider-action.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('entityProviderProposeControlBoard', 'core/entity/tx/handlers/control-board-proposal.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('entityProviderReleaseControlShares', 'core/entity/tx/handlers/entity-provider-action.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('entityProviderTransfer', 'core/entity/tx/handlers/entity-provider-action.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('extendCredit', 'core/entity/tx/handlers/account/lifecycle/admin.ts', MIXED_REPLAY_EVIDENCE),
  coveredEntity('htlcPayment', 'core/entity/tx/handlers/htlc/payment.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  coveredEntity('initOrderbookExt', 'core/entity/tx/handlers/system/basic.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('j_abort_sent_batch', 'core/entity/tx/handlers/j-batch/j-abort-sent-batch.ts', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('j_broadcast', 'core/entity/tx/handlers/j-batch/j-broadcast.ts', MIXED_REPLAY_EVIDENCE),
  coveredEntity('j_clear_batch', 'core/entity/tx/handlers/j-batch/j-clear-batch.ts', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('j_event', 'core/entity/tx/apply.ts#handleJEventEntityTx', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('j_rebroadcast', 'core/entity/tx/handlers/j-batch/j-rebroadcast.ts', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('lendingBorrow', 'core/entity/tx/handlers/payments/lending.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  coveredEntity('lendingClosePosition', 'core/entity/tx/handlers/payments/lending.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  coveredEntity('lendingOffer', 'core/entity/tx/handlers/payments/lending.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  coveredEntity('lendingRepay', 'core/entity/tx/handlers/payments/lending.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  coveredEntity('mintReserves', 'core/entity/tx/handlers/j-batch/mint-reserves.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('openAccount', 'core/entity/tx/handlers/account/lifecycle/open-account.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  missingEntity('orderbookSweepCrossJurisdiction', 'core/entity/tx/handlers/cross-j/sweep.ts'),
  coveredEntity('placeSwapOffer', 'core/entity/tx/handlers/payments/swap-requests.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  missingEntity('prepareCrossJurisdictionSwap', 'core/entity/tx/handlers/cross-j/setup.ts'),
  coveredEntity('prepareDispute', 'core/entity/tx/handlers/dispute/index.ts', MIXED_REPLAY_EVIDENCE),
  coveredEntity('processHtlcTimeouts', 'core/entity/tx/handlers/htlc/direct.ts', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('profile-update', 'core/entity/tx/handlers/system/basic.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('propose', 'core/entity/tx/handlers/system/basic.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('proposeCancelSwap', 'core/entity/tx/handlers/payments/swap-requests.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  coveredEntity('r2c', 'core/entity/tx/handlers/j-batch/r2c.ts', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('r2e', 'core/entity/tx/handlers/j-batch/r2e.ts', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('r2r', 'core/entity/tx/handlers/j-batch/r2r.ts', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('registerCrossJurisdictionSwap', 'core/entity/tx/handlers/cross-j/setup.ts', CROSS_J_OPENING_LIFECYCLE_EVIDENCE),
  missingEntity('removeCrossJurisdictionBookOrder', 'core/entity/tx/handlers/cross-j/book-order.ts'),
  coveredEntity('requestCollateral', 'core/entity/tx/handlers/account/lifecycle/admin.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  missingEntity('requestCrossJurisdictionClear', 'core/entity/tx/handlers/cross-j/clear.ts'),
  missingEntity('materializeCrossJurisdictionClear', 'core/entity/tx/handlers/cross-j/clear.ts'),
  coveredEntity('materializeCrossJurisdictionSwap', 'core/entity/tx/handlers/cross-j/setup.ts', CROSS_J_OPENING_LIFECYCLE_EVIDENCE),
  coveredEntity('resolveHtlcLock', 'core/entity/tx/handlers/htlc/direct.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  coveredEntity('runtimeOutput', 'core/entity/consensus/frame/application.ts#applyRuntimeOutput', ENTITY_ROUTING_SEMANTIC_EVIDENCE),
  coveredEntity('scheduledWake', 'core/entity/tx/handlers/system/scheduled-wake.ts', MIXED_REPLAY_EVIDENCE),
  coveredEntity('setHubConfig', 'core/entity/tx/handlers/account/lifecycle/admin.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
  coveredEntity('setRebalancePolicy', 'core/entity/tx/handlers/account/lifecycle/admin.ts', ENTITY_SAME_J_FINANCIAL_EVIDENCE),
  missingEntity('settle_approve', 'core/entity/tx/handlers/payments/settle.ts'),
  missingEntity('settle_execute', 'core/entity/tx/handlers/payments/settle.ts'),
  missingEntity('settle_propose', 'core/entity/tx/handlers/payments/settle.ts'),
  missingEntity('settle_reject', 'core/entity/tx/handlers/payments/settle.ts'),
  missingEntity('settle_update', 'core/entity/tx/handlers/payments/settle.ts'),
  coveredEntity('vote', 'core/entity/tx/handlers/system/basic.ts', ENTITY_CONTROL_SEMANTIC_EVIDENCE),
] as const satisfies readonly EntityTxSemanticCatalogEntry[];

type AccountCatalogType = (typeof ACCOUNT_TX_SEMANTIC_CATALOG)[number]['type'];
type EntityCatalogType = (typeof ENTITY_TX_SEMANTIC_CATALOG)[number]['type'];
type MissingAccountType = Exclude<AccountTx['type'], AccountCatalogType>;
type ExtraAccountType = Exclude<AccountCatalogType, AccountTx['type']>;
type MissingEntityType = Exclude<EntityTx['type'], EntityCatalogType>;
type ExtraEntityType = Exclude<EntityCatalogType, EntityTx['type']>;
const SEMANTIC_CATALOG_TYPES_ARE_EXHAUSTIVE:
  MissingAccountType extends never
    ? ExtraAccountType extends never
      ? MissingEntityType extends never
        ? ExtraEntityType extends never
          ? true
          : never
        : never
      : never
    : never = true;
void SEMANTIC_CATALOG_TYPES_ARE_EXHAUSTIVE;

export const TX_SEMANTIC_CATALOG = [
  ...ACCOUNT_TX_SEMANTIC_CATALOG,
  ...ENTITY_TX_SEMANTIC_CATALOG,
] as const;

export const missingSemanticEvidence = (): readonly string[] =>
  TX_SEMANTIC_CATALOG
    .filter(entry => entry.semanticEvidence === 'missing')
    .map(entry => `${entry.layer}:${entry.type}`);
