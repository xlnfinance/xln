import type { EntityState } from '../../../entity/types';
import type { EntityTx } from '../../../types/entity-tx';
import type { LendingTermId } from '../../../types/finance/lending';
import { handleLendingPolicy } from '../../../entity/tx/handlers/payments/lending-policy';
import { validateEntityTx } from '../../../entity/tx-validation';

/** Explicit bank governance for funded-loan fixtures; no automatic protocol approval. */
export const authorizeTestLending = (
  state: EntityState, borrowerEntityId: string,
  terms: { termId?: LendingTermId; savingsInterestBps?: number; loanInterestBps?: number; maxPrincipal?: bigint; loanLateMs?: number; expiresAt?: number } = {},
): void => {
  const account = state.accounts.get(borrowerEntityId);
  if (!account) throw new Error('TEST_LENDING_ACCOUNT_MISSING');
  const termId = terms.termId ?? '1d';
  const expiresAt = terms.expiresAt ?? state.timestamp + 31 * 86_400_000;
  const txs: Array<Extract<EntityTx, { type: 'lendingSetTerms' | 'lendingApprove' }>> = [
    { type: 'lendingSetTerms', data: { ...account.state.domain, tokenId: 1, termId,
      savingsInterestBps: terms.savingsInterestBps ?? 100, loanInterestBps: terms.loanInterestBps ?? 100, loanLateMs: terms.loanLateMs ?? 0, expiresAt } },
    { type: 'lendingApprove', data: { borrowerEntityId, tokenId: 1, termId,
      maxPrincipal: terms.maxPrincipal ?? 20_000n, expiresAt } },
  ];
  for (const tx of txs) {
    validateEntityTx(tx, 'TEST_BANK_POLICY');
    handleLendingPolicy(state, tx, true);
  }
};
