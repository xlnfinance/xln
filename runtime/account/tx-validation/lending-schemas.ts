import type { AccountTxDataSchema } from './fields';

const TERM_IDS = ['1h', '1d', '1m'] as const;

export const ACCOUNT_TX_LENDING_SCHEMAS = {
  lending_fund: {
    required: {
      positionId: 'string', hubEntityId: 'string', lenderEntityId: 'string',
      tokenId: 'integer', amount: 'bigint', termId: 'string', interestBps: 'integer',
    },
    literals: { termId: TERM_IDS },
  },
  lending_borrow_request: {
    required: {
      requestId: 'string', hubEntityId: 'string', borrowerEntityId: 'string',
      tokenId: 'integer', amount: 'bigint', termId: 'string', maxInterestBps: 'integer',
    },
    literals: { termId: TERM_IDS },
  },
  lending_repay: {
    required: {
      loanId: 'string', hubEntityId: 'string', borrowerEntityId: 'string',
      tokenId: 'integer', amount: 'bigint',
    },
  },
  lending_credit: {
    required: {
      action: 'string', loanId: 'string', hubEntityId: 'string',
      borrowerEntityId: 'string', tokenId: 'integer', creditLimit: 'bigint',
    },
    literals: { action: ['grant', 'revoke'] },
  },
  lending_close_request: {
    required: { positionId: 'string', hubEntityId: 'string', lenderEntityId: 'string' },
  },
  lending_close_payout: {
    required: {
      positionId: 'string', hubEntityId: 'string', lenderEntityId: 'string',
      tokenId: 'integer', amount: 'bigint',
    },
  },
} as const satisfies Readonly<Record<string, AccountTxDataSchema>>;
