import type { RuntimeAdapter } from '../../api/runtime-adapter/types';
import type { readLendingEvidence } from '../../api/runtime-adapter/read/lending-evidence';
import type { AccountFrame } from '../../types/account';
import type { LendingBankTerms, LendingFacility, LendingLoan } from '../../types/finance/lending';
import { creditUsd, type CreditFacts } from './policy';
import type { CreditRequest } from './proof';
import type { CreditLedger } from './ledger';

type CreditBook = { loans: LendingLoan[]; facilities: LendingFacility[]; terms: LendingBankTerms[] };

/** Only committed adapter reads supply reputation. The bounded signed frame
 * sample gives a volume lower bound, never a claim of complete history.
 * Registration age belongs only to the officer's durable observation clock.
 * Transfers involving the bank or borrower themselves earn no volume points. */
export async function readCreditEvidence(adapter: RuntimeAdapter, r: CreditRequest, now: number, ledger: CreditLedger) {
  const path = `/entity/${r.hubEntityId}`;
  const snapshot = await adapter.read<ReturnType<typeof readLendingEvidence>>(`${path}/lending`, {
    accountId: r.borrowerEntityId,
  });
  const { atHeight, account, book, signerId, isHub } = snapshot;
  if (!isHub || !signerId || atHeight < 1) throw new Error('HUB_AUTHORITY_UNAVAILABLE');
  if (account.status !== 'active' || !account.state.deltas.has(r.tokenId)) throw new Error('ACCOUNT_UNAVAILABLE');
  const firstSeenAt = ledger.observe(r, now);
  const frames = await adapter.read<AccountFrame[]>(`${path}/account/${r.borrowerEntityId}/frames`, { limit: 500 });
  const committedFrames = frames.filter(frame => frame.height <= account.currentHeight);
  const terms = book.terms.find(
    row =>
      row.tokenId === r.tokenId &&
      row.termId === r.termId &&
      row.chainId === account.state.domain.chainId &&
      row.depositoryAddress === account.state.domain.depositoryAddress,
  );
  if (!terms || terms.expiresAt <= now) throw new Error('BANK_TERMS_UNAVAILABLE');
  const facts = creditFacts(account, book, committedFrames, now, r, firstSeenAt);
  return { signerId, atHeight, accountRoot: account.currentFrame.accountStateRoot, firstSeenAt, facts, terms };
}

function creditFacts(
  account: ReturnType<typeof readLendingEvidence>['account'],
  book: CreditBook,
  frames: AccountFrame[],
  now: number,
  request: CreditRequest,
  firstSeenAt: number,
): CreditFacts {
  let volumeUsd = 0n;
  for (const frame of frames)
    for (const tx of frame.accountTxs) {
      if (tx.type !== 'direct_payment' || tx.data.amount <= 0n) continue;
      // A trusted source leg debits this borrower once; the bank's outgoing
      // hop is not another commercial payment or evidence of GDP attribution.
      if (
        tx.data.deliveryMode !== 'trusted' ||
        tx.data.fromEntityId !== request.borrowerEntityId ||
        tx.data.toEntityId !== request.hubEntityId ||
        tx.data.route.length !== 2 ||
        tx.data.route[1] === request.borrowerEntityId ||
        tx.data.route[1] === request.hubEntityId
      )
        continue;
      volumeUsd += creditUsd(tx.data.tokenId, tx.data.amount);
    }
  const loans = book.loans;
  const exposureUsd =
    book.facilities
      .filter(row => row.expiresAt > now)
      .reduce((sum, row) => sum + (row.maxPrincipal > 0n ? creditUsd(row.tokenId, row.maxPrincipal) : 0n), 0n) +
    loans
      .filter(row => row.status !== 'repaid' && row.principalAmount > 0n)
      .reduce((sum, row) => sum + creditUsd(row.tokenId, row.principalAmount), 0n);
  return {
    chainId: account.state.domain.chainId,
    ageDays: Math.max(0, Math.floor((now - firstSeenAt) / 86_400_000)),
    volumeUsd,
    exposureUsd,
    repaid: loans.filter(row => row.status === 'repaid' && row.updatedAt <= row.dueAt).length,
    epochChanged: account.state.jNonce !== 0,
    adverse:
      account.status !== 'active' ||
      Boolean(account.activeDispute) ||
      loans.some(
        row =>
          row.status === 'defaulted' ||
          row.status === 'disputed' ||
          (row.status !== 'repaid' && row.dueAt <= now) ||
          (row.status === 'repaid' && row.updatedAt > row.dueAt),
      ),
  };
}
