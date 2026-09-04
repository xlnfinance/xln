import type { AccountTx } from '../account';
import type { AllKeys } from './coverage';

type AccountTxData<K extends AccountTx['type']> = Extract<AccountTx, { type: K }>['data'];

export const HASHABLE_ACCOUNT_TX_DATA_FIELDS = {
  direct_payment: [
    'tokenId', 'amount', 'route', 'description', 'fromEntityId', 'toEntityId',
    'deliveryMode', 'trustedGatewayEntityId',
  ],
  lending_fund: [
    'positionId', 'hubEntityId', 'lenderEntityId', 'tokenId', 'amount', 'termId', 'interestBps',
  ],
  lending_borrow_request: [
    'requestId', 'hubEntityId', 'borrowerEntityId', 'tokenId', 'amount', 'termId', 'maxInterestBps',
  ],
  lending_repay: ['loanId', 'hubEntityId', 'borrowerEntityId', 'tokenId', 'amount'],
  lending_credit: [
    'action', 'loanId', 'hubEntityId', 'borrowerEntityId', 'tokenId', 'creditLimit',
  ],
  lending_close_request: ['positionId', 'hubEntityId', 'lenderEntityId'],
  lending_close_payout: ['positionId', 'hubEntityId', 'lenderEntityId', 'tokenId', 'amount'],
  add_delta: ['tokenId'],
  set_credit_limit: ['tokenId', 'amount'],
  request_collateral: ['tokenId', 'amount', 'feeTokenId', 'feeAmount', 'policyVersion'],
  rebalance_refund: ['requestId', 'requestTokenId', 'amount', 'reason'],
  rebalance_policy: ['tokenId', 'policyVersion', 'baseFee', 'liquidityFeeBps', 'gasFee'],
  htlc_lock: [
    'lockId', 'hashlock', 'timelock', 'revealBeforeHeight', 'amount', 'tokenId',
    'deliveryMode', 'envelope',
  ],
  htlc_resolve: ['lockId', 'outcome', 'secret', 'reason'],
  cross_pull_lock: [
    'pullId', 'tokenId', 'amount', 'fullHash', 'partialRoot',
    'crossJurisdiction', 'crossJurisdictionRoute',
  ],
  cross_pull_close: ['pullId', 'binary', 'proof'],
  swap_offer: [
    'offerId', 'giveTokenId', 'giveTokenDecimals', 'giveAmount',
    'wantTokenId', 'wantTokenDecimals', 'wantAmount', 'maxFee',
    'minNetReceive', 'priceTicks', 'timeInForce', 'crossJurisdiction',
  ],
  swap_cancel_request: ['offerId'],
  swap_resolve: [
    'offerId', 'fillRatio', 'fillNumerator', 'fillDenominator', 'cancelRemainder',
    'comment', 'feeTokenId', 'feeAmount', 'executionGiveAmount', 'executionWantAmount',
    'restingGiveTokenId', 'restingWantTokenId', 'restingPriceTicks', 'restingGiveAmount',
    'restingWantAmount', 'restingQuantizedGive', 'restingQuantizedWant',
  ],
  settle_transition: [
    'kind', 'revision', 'previousWorkspaceHash', 'ops', 'executorIsLeft', 'memo',
    'workspaceHash', 'settlementNonce', 'settlementHash', 'settlementHanko', 'postProof',
  ],
  j_event_claim: ['jHeight', 'jBlockHash', 'events', 'leftProof', 'rightProof'],
} as const satisfies {
  [Kind in AccountTx['type']]: readonly AllKeys<AccountTxData<Kind>>[];
};

