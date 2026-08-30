import type { AccountTx } from '../../types/account';

/** Exact canonical AccountTx catalog shared by codec/parity gates. */
export const ACCOUNT_TX_TYPES = [
  'direct_payment',
  'lending_fund',
  'lending_borrow_request',
  'lending_repay',
  'lending_credit',
  'lending_close_request',
  'lending_close_payout',
  'add_delta',
  'set_credit_limit',
  'reserve_to_collateral',
  'request_collateral',
  'rebalance_refund',
  'rebalance_policy',
  'htlc_lock',
  'htlc_resolve',
  'cross_pull_lock',
  'cross_pull_close',
  'cross_pull_progress',
  'swap_offer',
  'swap_cancel_request',
  'swap_resolve',
  'cross_swap_fill_ack',
  'settle_transition',
  'j_event_claim',
] as const satisfies readonly AccountTx['type'][];

type CatalogType = (typeof ACCOUNT_TX_TYPES)[number];
type Missing = Exclude<AccountTx['type'], CatalogType>;
type Extra = Exclude<CatalogType, AccountTx['type']>;
const ACCOUNT_TX_CATALOG_IS_EXHAUSTIVE: Missing extends never
  ? Extra extends never
    ? true
    : never
  : never = true;
void ACCOUNT_TX_CATALOG_IS_EXHAUSTIVE;
